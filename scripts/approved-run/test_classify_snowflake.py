"""Tests for classify_snowflake.py. Run: APPROVED_RUN_SNOW_ROOT=<the pinned snow install> python3 -I test_classify_snowflake.py"""
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
CLF = os.path.join(HERE, "classify_snowflake.py")
spec = importlib.util.spec_from_file_location("clf", CLF)
clf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(clf)

SNOW_ROOT = os.environ.get("APPROVED_RUN_SNOW_ROOT", "")
if not SNOW_ROOT:
    sys.exit("APPROVED_RUN_SNOW_ROOT must name the snow install the classifier pins")
clf.configure(SNOW_ROOT)

ROLES = "SECURITYADMIN,SYSADMIN,ACME_DEV_OWNER"
DEFAULT_ROLE = "ACME_DEV_OWNER"


def run_raw(sql, default_role=DEFAULT_ROLE):
    with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False, newline="") as f:
        f.write(sql)
    args = [sys.executable, "-I", CLF, "--facts", "--snow-root", SNOW_ROOT, "--allowed-roles", ROLES, f.name]
    if default_role:
        args[6:6] = ["--default-role", default_role]
    try:
        return json.loads(subprocess.run(args, capture_output=True, text=True, check=True).stdout)
    finally:
        os.unlink(f.name)


def run(sql, **kw):
    return run_raw(sql, **kw)["statements"]


def file_tier(sql):
    """card when nothing is denied and something runs; there is no auto tier."""
    facts = run(sql)
    if any(s.get("deny") for s in facts) or all(s["kind"] == "context" for s in facts):
        return "deny"
    return "card"


class Tiered(unittest.TestCase):
    def assertTier(self, cases, want):
        for sql in cases:
            with self.subTest(sql=sql):
                self.assertEqual(file_tier(sql), want)


class WhatRunsIsWhatWasJudged(Tiered):
    def test_a_backslash_escaped_quote_cannot_hide_a_statement(self):
        facts = run("USE DATABASE ACME_DEV;\nSELECT 'a\\', '; GRANT ROLE R TO USER ALICE; SELECT ' --'\n;\n")
        self.assertIn("GRANT ROLE R TO USER ALICE;", [s["text"].strip() for s in facts])
        self.assertTrue(any(s.get("deny") for s in facts))

    def test_each_fact_is_exactly_one_statement_snow_would_send(self):
        split = clf.load_splitter()
        sql = "USE DATABASE ACME_DEV;\nCREATE SCHEMA S; -- trailing ; note\nGRANT USAGE ON SCHEMA S TO ROLE R;\n"
        for s in run(sql):
            self.assertEqual(clf.snow_statements(split, s["text"]), [s["text"]])

    def test_snow_must_deliver_each_statement_unchanged(self):
        real = clf.snow_sends
        clf.snow_sends = lambda texts: [{"final": [clf.SESSION_SQL.strip(), t.strip().lower()], "errors": []}
                                        for t in texts]
        try:
            facts = clf.facts_for("USE DATABASE ACME_DEV;\nCREATE SCHEMA S;\n", set(), DEFAULT_ROLE)
        finally:
            clf.snow_sends = real
        self.assertIn("snow would send something other", facts[-1]["deny"])
        self.assertFalse(run("USE DATABASE ACME_DEV;\nCREATE SCHEMA S; -- note\n")[-1].get("deny"))

    def test_readers_that_could_disagree_refuse_the_statement(self):
        self.assertTier([
            'USE ROLE SECURITYADMIN;\nGRANT USAGE ON SCHEMA "a\\"; GRANT ROLE R TO ROLE X;',
            "USE ROLE SECURITYADMIN;\nGRANT USAGE ON SCHEMA ACME_DEV.S // c\nTO ROLE R;\n",
            "USE ROLE SECURITYADMIN;\nGRANT USAGE ON SCHEMA ACME_DEV.S /* c */ TO ROLE R;\n",
            "USE ROLE SECURITYADMIN;\nGRANT ROLE ACCOUNT/**/ADMIN TO ROLE ANALYST;\n",
            "CREATE ROLE R COMMENT = 'unterminated\n;\n",
            "USE ROLE SECURITYADMIN;\nUSE DATABASE ACME_DEV; !source /tmp/grants.sql;\n",
            "SHOW ROLES;>\n",
            "SHOW TABLES ->> DROP DATABASE ACME_PROD;\n",
            "DESC TABLE ACME_DEV.S.T;\n",
        ], "deny")

    def test_line_endings_and_characters(self):
        self.assertEqual(file_tier("USE DATABASE ACME_DEV;\r\nCREATE SCHEMA S; -- c\r\n"), "card")
        self.assertTier([
            "USE ROLE SECURITYADMIN;\nCREATE SCHEMA ACME_DEV.S; -- c\rGRANT ROLE R TO ROLE SYSADMIN;\n",
            "CREATE SCHEMA ACME_DEV.S -- c ;\n",
            "USE ROLE SECURITYADMIN;\nGRANT ROLE R​1 TO ROLE ANALYST;\n",
            "USE ROLE SECURITYADMIN;\nGRANT ROLE РЕ TO ROLE ANALYST;\n",
            "CREATE ROLE R COMMENT = 'café';\n",
            "CREATE ROLE R COMMENT = 'x\n-- role SYSADMIN · in ACME_PROD.PUBLIC\ny';\n",
        ], "deny")

    def test_names_the_pinned_runner_and_every_pin_for_the_run_to_recheck(self):
        out = run_raw("SHOW ROLES;")
        self.assertEqual(out["runner"], clf.RUNNER)
        self.assertEqual(out["pins"], clf.PINS)
        self.assertIn(clf.RUNNER, out["pins"])

    def test_a_changed_snow_install_refuses_everything(self):
        saved = dict(clf.PINS)
        try:
            clf.PINS[clf.SPLITTER] = "0" * 64
            with self.assertRaises(clf.Refuse):
                clf.facts_for("SHOW ROLES;", set(), DEFAULT_ROLE)
        finally:
            clf.PINS.clear()
            clf.PINS.update(saved)


class Shapes(Tiered):
    def test_the_accepted_shapes_reach_a_card(self):
        self.assertTier([
            'USE ROLE ACME_DEV_OWNER;\nGRANT SELECT ON FUTURE TABLES IN SCHEMA ACME_PROD."INSIGHTS" TO ROLE ACME_PROD_R;\n',
            "USE ROLE ACME_DEV_OWNER;\nGRANT SELECT, REFERENCES ON ALL TABLES IN DATABASE ACME_PROD TO ROLE ACME_PROD_R;\n",
            "CREATE WAREHOUSE W WAREHOUSE_SIZE = 'SMALL' MAX_CLUSTER_COUNT = 2;\n",
            "USE ROLE ACME_DEV_OWNER;\nGRANT USAGE ON PROCEDURE ACME_DEV.TRANSFORM_PROD.SP_X(VARCHAR, NUMBER(38, 0)) TO ROLE R;\n",
            "USE ROLE ACME_DEV_OWNER;\nGRANT USAGE ON FUNCTION ACME_DEV.S.UDF_Y() TO ROLE R;\n",
            "USE ROLE ACME_DEV_OWNER;\nGRANT CREATE SCHEMA, CREATE FILE FORMAT ON DATABASE ACME_DEV TO ROLE R;\n",
            "USE ROLE ACME_DEV_OWNER;\nGRANT MONITOR ON DBT PROJECT ACME_DEV.TRANSFORM_PROD.P TO ROLE R;\n",
            "USE ROLE ACME_DEV_OWNER;\nGRANT OWNERSHIP ON SCHEMA ACME_DEV.SAMPLE_STAGING TO ROLE R COPY CURRENT GRANTS;\n",
            "USE ROLE ACME_DEV_OWNER;\nCREATE ROLE ACME_JOB_RUN;\nGRANT OWNERSHIP ON ROLE ACME_JOB_RUN TO ROLE ACME_JOB_SETUP COPY CURRENT GRANTS;\n",
            "USE ROLE ACME_DEV_OWNER;\nREVOKE CREATE PROCEDURE ON SCHEMA ACME_PROD.DEPLOY_RUN FROM ROLE R;\n",
            "USE ROLE ACME_DEV_OWNER;\nGRANT DATABASE ROLE ACME_DEV.READER TO ROLE R;\n",
            "USE ROLE SECURITYADMIN;\nGRANT ROLE ACME_ARCHIVE_OWNER TO USER BOB;\n",
            "CREATE ROLE IF NOT EXISTS R COMMENT = 'reads dev';\n",
            "CREATE USER IF NOT EXISTS SVC TYPE = SERVICE DEFAULT_ROLE = R DEFAULT_SECONDARY_ROLES = ();\n",
            "CREATE WAREHOUSE W WAREHOUSE_SIZE = XSMALL AUTO_SUSPEND = 60 AUTO_RESUME = TRUE INITIALLY_SUSPENDED = TRUE;\n",
            "CREATE SCHEMA IF NOT EXISTS ACME_DEV.S WITH MANAGED ACCESS;\n",
            "CREATE STAGE IF NOT EXISTS ACME_PROD.DEPLOY_RUN.SQL_FILES COMMENT = 'files';\n",
            "CREATE FILE FORMAT ACME_PROD.R.F TYPE = CSV FIELD_DELIMITER = NONE NULL_IF = () SKIP_HEADER = 0;\n",
            "ALTER SCHEMA ACME_DEV.S ENABLE MANAGED ACCESS;\n",
            "SHOW FUTURE GRANTS IN SCHEMA ACME_DEV.TEAM_REPORTS;\n",
            "USE ROLE SECURITYADMIN;\nCREATE ROLE NEWR;\nGRANT ROLE NEWR TO ROLE SYSADMIN;\n",
        ], "card")

    def test_everything_else_is_refused(self):
        self.assertTier([
            "SELECT SYSTEM$CANCEL_ALL_QUERIES(1);\n",
            "CALL ACME_DEV.S.P();\n",
            "USE ROLE SECURITYADMIN;\nWITH P AS PROCEDURE() RETURNS STRING LANGUAGE PYTHON RUNTIME_VERSION = '3.11' PACKAGES = ('snowflake-snowpark-python') HANDLER = 'h' AS 'def h(s): return s.sql(\"GRANT ROLE R TO ROLE X\").collect()' CALL P();\n",
            "USE ROLE SECURITYADMIN;\nCREATE ALERT ACME_DEV.S.A WAREHOUSE = W SCHEDULE = '1 MINUTE' IF (EXISTS (SELECT 1)) THEN GRANT ROLE R TO ROLE X;\n",
            "USE ROLE SECURITYADMIN;\nALTER TASK ACME_DEV.S.T MODIFY AS GRANT ROLE R TO ROLE X;\n",
            "ALTER TASK ACME_DEV.S.T RESUME;\n",
            "CREATE TASK ACME_DEV.S.T SCHEDULE = '1 MINUTE' AS INSERT INTO ACME_DEV.S.X VALUES (1);\n",
            "CREATE OR REPLACE ROLE R;\n",
            "USE ROLE SECURITYADMIN;\nGRANT USAGE ON DATABASE ACME_DEV TO SHARE S;\n",
            "ALTER DATABASE ACME_PROD ENABLE REPLICATION TO ACCOUNTS ORG.ACCT;\n",
            "USE ROLE SECURITYADMIN;\nGRANT MANAGE GRANTS ON ACCOUNT TO ROLE R;\n",
            "USE ROLE SECURITYADMIN;\nGRANT MODIFY PROGRAMMATIC AUTHENTICATION METHODS ON USER ALICE TO ROLE R;\n",
            "USE ROLE SECURITYADMIN;\nGRANT EXECUTE TASK ON ACCOUNT TO ROLE R;\n",
            "USE ROLE SECURITYADMIN;\nGRANT SELECT ON TABLE ACME_DEV.S.T TO ROLE R WITH GRANT OPTION;\n",
            "ALTER USER ALICE SET RSA_PUBLIC_KEY = 'x';\n",
            "CREATE USER SVC PASSWORD = 'x';\n",
            "CREATE STAGE ACME_DEV.S.ST URL = 's3://bucket/' STORAGE_INTEGRATION = I;\n",
            "SET r = 'X';\n",
            "USE SECONDARY ROLES ALL;\n",
            "USE DATABASE &{db};\n",
            "CREATE USER U DEFAULT_WAREHOUSE = <% wh %>;\n",
            "DROP TABLE ACME_DEV.S.T;\n",
            'USE ROLE SECURITYADMIN;\nGRANT SELECT ON TABLE ACME_DEV.S."x y" TO ROLE R;\n',
            'USE ROLE SECURITYADMIN;\nGRANT ROLE "lower_r" TO ROLE R2;\n',
            "USE ROLE SECURITYADMIN;\nGRANT APPLYBUDGET ON DATABASE ACME_DEV TO ROLE R;\n",
            "USE ROLE SECURITYADMIN;\nGRANT OWNERSHIP ON INTEGRATION I TO ROLE R;\n",
            "USE ROLE SECURITYADMIN;\nGRANT ALL ON SCHEMA ACME_DEV.S TO ROLE R;\n",
            "USE ROLE SECURITYADMIN;\nGRANT ALL PRIVILEGES ON FUTURE SCHEMAS IN DATABASE ACME_PROD TO ROLE R;\n",
            "USE ROLE SECURITYADMIN;\nGRANT USAGE, ALL ON WAREHOUSE W TO ROLE R;\n",
            "CREATE USER SVC TYPE = SERVICE RSA_PUBLIC_KEY = 'MIIB';\n",
            "CREATE USER SVC DEFAULT_ROLE = SECURITYADMIN;\n",
            "CREATE WAREHOUSE W WAREHOUSE_SIZE = X4LARGE;\n",
            "CREATE WAREHOUSE W MAX_CLUSTER_COUNT = 10;\n",
        ], "deny")

    def test_system_roles_are_untouchable(self):
        self.assertTier([
            "USE ROLE SECURITYADMIN;\nGRANT ROLE SECURITYADMIN TO ROLE R;\n",
            "USE ROLE SECURITYADMIN;\nGRANT ROLE SECURITYADMIN TO USER ALICE;\n",
            "USE ROLE SECURITYADMIN;\nGRANT ROLE R TO ROLE PUBLIC;\n",
            "USE ROLE SECURITYADMIN;\nGRANT USAGE ON DATABASE ACME_DEV TO ROLE SYSADMIN;\n",
            "USE ROLE SECURITYADMIN;\nGRANT OWNERSHIP ON ROLE SYSADMIN TO ROLE R COPY CURRENT GRANTS;\n",
            "USE ROLE SECURITYADMIN;\nGRANT OWNERSHIP ON ROLE EXISTING_POWER TO ROLE R2;\n",
            "USE ROLE SECURITYADMIN;\nGRANT ROLE R TO DATABASE ROLE ACME_DEV.PUBLIC;\n",
            "USE ROLE SECURITYADMIN;\nGRANT DATABASE ROLE ACME_DEV.READER TO DATABASE ROLE ACME_DEV.PUBLIC;\n",
            "USE ROLE SECURITYADMIN;\nGRANT OWNERSHIP ON DATABASE ACME_PROD TO ROLE USERADMIN COPY CURRENT GRANTS;\n",
            "USE ROLE SECURITYADMIN;\nREVOKE ROLE SYSADMIN FROM USER ALICE;\n",
            "CREATE ROLE IF NOT EXISTS SECURITYADMIN;\n",
            'USE ROLE SECURITYADMIN;\nGRANT ROLE "AccountAdmin" TO USER ALICE;\n',
            "USE ROLE SECURITYADMIN;\nGRANT ROLE IDENTIFIER('SYSADMIN') TO ROLE R;\n",
            "USE ROLE SECURITYADMIN;\nGRANT SELECT ON TABLE ACME_DEV.S.\"X FROM Y\" TO ROLE SYSADMIN;\n",
        ], "deny")

    def test_the_lanes_own_objects_are_untouchable(self):
        self.assertTier([
            "USE ROLE SECURITYADMIN;\nGRANT ROLE R TO ROLE APPROVED_RUN_ACME_ROLE;\n",
            "USE ROLE SECURITYADMIN;\nGRANT ROLE R TO USER APPROVED_RUN_ACME;\n",
            "USE ROLE SECURITYADMIN;\nGRANT USAGE ON DATABASE ACME_DEV TO ROLE approved_run_acme_role;\n",
            'USE ROLE SECURITYADMIN;\nGRANT ROLE R TO ROLE "APPROVED_RUN_ACME_ROLE";\n',
            "USE ROLE SECURITYADMIN;\nGRANT ROLE IDENTIFIER('APPROVED_' || 'RUN_ACME_ROLE') TO ROLE R;\n",
            "USE ROLE SECURITYADMIN;\nGRANT OWNERSHIP ON DATABASE APPROVED_RUN_WATCH TO ROLE R COPY CURRENT GRANTS;\n",
            "USE DATABASE APPROVED_RUN_WATCH;\nCREATE SCHEMA S2;\n",
            "USE ROLE SECURITYADMIN;\nGRANT OPERATE ON TASK APPROVED_RUN_WATCH.WATCH.CHECK_GRANTS_EVERY_5M TO ROLE R;\n",
            "USE ROLE SECURITYADMIN;\nGRANT USAGE ON INTEGRATION APPROVED_RUN_WATCH_EMAIL TO ROLE R;\n",
        ], "deny")
        self.assertTier(["USE ROLE ACME_DEV_OWNER;\nGRANT ROLE R TO ROLE ACME_DEV_READER;\n"], "card")

    def test_a_created_role_cannot_launder_power_into_sysadmin(self):
        self.assertTier([
            "USE ROLE SECURITYADMIN;\nCREATE ROLE R;\nGRANT ROLE SECURITYADMIN TO ROLE R;\nGRANT ROLE R TO ROLE PUBLIC;\n",
            "USE ROLE SECURITYADMIN;\nCREATE ROLE R;\nGRANT ROLE EXISTING_POWER TO ROLE R;\nGRANT ROLE R TO ROLE SYSADMIN;\n",
            "USE ROLE SECURITYADMIN;\nCREATE ROLE R;\nGRANT OWNERSHIP ON DATABASE ACME_PROD TO ROLE R COPY CURRENT GRANTS;\nGRANT ROLE R TO ROLE SYSADMIN;\n",
            "USE ROLE SECURITYADMIN;\nCREATE ROLE R;\nGRANT USAGE ON DATABASE ACME_PROD TO ROLE R;\nGRANT ROLE R TO ROLE SYSADMIN;\n",
            "USE ROLE SECURITYADMIN;\nCREATE ROLE R;\nDROP ROLE R;\nALTER ROLE EXISTING_POWER RENAME TO R;\nGRANT ROLE R TO ROLE SYSADMIN;\n",
            "USE ROLE SECURITYADMIN;\nCREATE DATABASE ROLE ACME_DEV.R;\nGRANT ROLE R TO ROLE SYSADMIN;\n",
            "USE ROLE SECURITYADMIN;\nCREATE ROLE IF NOT EXISTS R;\nGRANT ROLE R TO ROLE SYSADMIN;\n",
            "USE ROLE SECURITYADMIN;\nGRANT ROLE R TO ROLE SYSADMIN;\nCREATE ROLE R;\n",
        ], "deny")

    def test_a_grant_revoke_or_ownership_move_needs_a_named_role(self):
        for sql in [
            "GRANT USAGE ON DATABASE ACME_DEV TO ROLE R;\n",
            "REVOKE USAGE ON DATABASE ACME_DEV FROM ROLE R;\n",
            "GRANT OWNERSHIP ON TABLE ACME_DEV.S.T TO ROLE R COPY CURRENT GRANTS;\n",
            "GRANT ROLE R TO USER BOB;\n",
            "USE DATABASE ACME_DEV;\nGRANT USAGE ON SCHEMA S TO ROLE R;\n",
        ]:
            with self.subTest(sql=sql):
                self.assertEqual(
                    run(sql)[-1].get("deny"),
                    "this statement needs a USE ROLE before it; without one this "
                    + sql.split("\n")[-2].split()[0]
                    + " would run as the default role ACME_DEV_OWNER",
                )
        self.assertTier(["USE ROLE ACME_DEV_OWNER;\nGRANT USAGE ON DATABASE ACME_DEV TO ROLE R;\n"], "card")

    def test_facts_carry_what_the_parser_extracted(self):
        f = run('USE ROLE ACME_DEV_OWNER;\nUSE DATABASE ACME_PROD;\nGRANT SELECT ON FUTURE TABLES IN SCHEMA "INSIGHTS" TO ROLE ACME_PROD_R;\n')[-1]
        self.assertEqual((f["kind"], f["object"], f["grantee"]),
                         ("grant", "FUTURE TABLES IN ACME_PROD.INSIGHTS", "ACME_PROD_R"))
        o = run("USE ROLE ACME_DEV_OWNER;\nGRANT OWNERSHIP ON DATABASE ACME_BACKUP TO ROLE R REVOKE CURRENT GRANTS;\n")[-1]
        self.assertEqual((o["kind"], o["drops_grants"]), ("ownership", True))
        c = run("USE ROLE ACME_DEV_OWNER;\nGRANT OWNERSHIP ON SCHEMA ACME_DEV.S TO ROLE R COPY CURRENT GRANTS;\n")[-1]
        self.assertFalse(c["drops_grants"])


VALUE_ROWS = ",\n".join(f"    ('id{n}', {n})" for n in range(7))


class DataStatements(Tiered):
    def test_tables_views_dynamic_tables_merges_and_reads_reach_a_card(self):
        self.assertTier([
            "SELECT * FROM ACME_DEV.S.T;\n",
            "CREATE TABLE ACME_DEV.S.T (A INT);\n",
            "CREATE TABLE IF NOT EXISTS ACME_DEV.S.T (A VARCHAR NOT NULL, B TIMESTAMP_NTZ, PRIMARY KEY (A))\nCHANGE_TRACKING = TRUE COMMENT = 'c';\n",
            "CREATE OR REPLACE VIEW ACME_DEV.S.V COPY GRANTS COMMENT = 'c' AS SELECT t.* FROM ACME_DEV.S.T t WHERE NOT EXISTS (SELECT 1 FROM ACME_DEV.OTHER.U u WHERE u.A = t.A);\n",
            "CREATE OR REPLACE DYNAMIC TABLE ACME_DEV.S.D TARGET_LAG = '1 hour' WAREHOUSE = W AS SELECT A, COUNT(*) AS N FROM ACME_DEV.S.T GROUP BY A;\n",
            "CREATE TABLE ACME_DEV.S.C (A VARCHAR(16) NOT NULL, B NUMBER(38, 0) DEFAULT 0, PRIMARY KEY (A), FOREIGN KEY (B) REFERENCES ACME_DEV.S.U (B));\n",
            "SELECT F.VALUE FROM ACME_DEV.S.T, TABLE(FLATTEN(INPUT => T.J)) F;\n",
            "MERGE INTO ACME_DEV.S.T t USING (SELECT COLUMN1 AS A FROM VALUES ('x'), ('y')) s ON t.A = s.A\nWHEN MATCHED THEN UPDATE SET B = CURRENT_TIMESTAMP()::TIMESTAMP_NTZ\nWHEN NOT MATCHED THEN INSERT (A, B) VALUES (s.A, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ);\n",
            "SELECT j:field::STRING, A % 2, A || 'x' FROM ACME_DEV.S.T WHERE A <> 'y';\n",
        ], "card")

    def test_what_could_drop_move_or_escape_is_refused(self):
        self.assertTier([
            "CREATE OR REPLACE TABLE ACME_DEV.S.T (A INT);\n",
            "CREATE TABLE ACME_DEV.S.T CLONE ACME_DEV.S.U;\n",
            "CREATE TABLE ACME_DEV.S.T AS SELECT * FROM ACME_DEV.S.U;\n",
            "CREATE TABLE ACME_DEV.S.T AS SELECT * FROM ACME_PROD.S.EVENTS_STREAM;\n",
            "INSERT INTO ACME_DEV.S.T SELECT * FROM ACME_PROD.S.EVENTS_STREAM;\n",
            "UPDATE ACME_DEV.S.T SET A = (SELECT MAX(A) FROM ACME_PROD.S.EVENTS_STREAM);\n",
            "CREATE TABLE ACME_DEV.S.T LIKE ACME_DEV.S.U;\n",
            "CREATE TRANSIENT TABLE ACME_DEV.S.T (A INT);\n",
            "CREATE TABLE T (A INT);\n",
            "CREATE VIEW ACME_DEV.S.V AS SELECT SYSTEM$TYPEOF(1);\n",
            "CREATE VIEW ACME_DEV.S.V SECURE AS SELECT 1;\n",
            "CREATE VIEW ACME_DEV.S.V COMMENT = 'c';\n",
            "SELECT 1 FROM ACME_DEV.S.T WHERE A IN (SELECT 1 FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))) AND 1 = (SELECT 1 FROM (SELECT 1) WHERE FALSE) UNION ALL SELECT CALL;\n",
            "SELECT * FROM ACME_DEV.S.T; DROP TABLE ACME_DEV.S.T;\n",
            "WITH X AS (SELECT 1) INSERT INTO ACME_DEV.S.T SELECT * FROM X;\n",
            "MERGE INTO ACME_DEV.S.T t USING ACME_DEV.S.U s ON t.A = s.A WHEN MATCHED THEN UPDATE SET A = (SELECT SYSTEM$GET_TAG('a', 'b', 'table'));\n",
            "SELECT $1 FROM ACME_DEV.S.T;\n",
            "SELECT 'a\\' FROM ACME_DEV.S.T;\n",
            "SELECT 1 /* x */ FROM ACME_DEV.S.T;\n",
            "TRUNCATE TABLE ACME_DEV.S.T;\n",
            "COPY INTO ACME_DEV.S.T FROM @ACME_DEV.S.ST;\n",
            "SELECT * FROM TABLE(OTHERDB..EVIL_PROC());\n",
            "USE SCHEMA ACME_DEV.S;\nSELECT * FROM TABLE(EVIL_PROC());\n",
        ], "deny")

    def facts_one(self, sql):
        facts = [f for f in run(sql) if f["kind"] != "context"]
        self.assertEqual(len(facts), 1)
        return facts[0]

    def test_a_view_or_dynamic_table_may_name_its_columns(self):
        dynamic = (
            "CREATE OR REPLACE DYNAMIC TABLE ACME_DEV.S.D(\n"
            "    A,          -- the first column\n"
            "    B COMMENT 'the second column'\n"
            ")\n"
            "target_lag = '1 day' refresh_mode = AUTO initialize = ON_CREATE warehouse = W\n"
            "COPY GRANTS\n"
            "AS\n"
            "WITH C AS (SELECT 1 AS A, 2 AS B)\n"
            "SELECT A, B FROM C;\n"
        )
        f = self.facts_one(dynamic)
        self.assertFalse(f.get("deny"))
        self.assertEqual((f["kind"], f["object"], f["replaces"]), ("create_dynamic_table", "ACME_DEV.S.D", True))
        f = self.facts_one("CREATE VIEW ACME_DEV.S.V (A, B) AS SELECT 1 AS A, 2 AS B;\n")
        self.assertFalse(f.get("deny"))
        self.assertEqual((f["kind"], f["replaces"]), ("create_view", False))
        for columns, why in (
            ("(A INT)", "column list holding something other than names"),
            ("(A, B + 1)", "column list holding something other than names"),
            ("(A,)", "column list holding something other than names"),
            ("()", "column list holding something other than names"),
            ("(A COMMENT B)", "column COMMENT that isn't a string"),
            ('("SELECT")', 'quotes "SELECT"'),
        ):
            with self.subTest(columns=columns):
                sql = f"CREATE VIEW ACME_DEV.S.V {columns} AS SELECT 1 AS A;\n"
                self.assertIn(why, self.facts_one(sql).get("deny") or "")

    def test_kind_object_and_rebuild_are_reported(self):
        f = self.facts_one("USE DATABASE ACME_DEV;\nUSE SCHEMA S;\nCREATE OR REPLACE DYNAMIC TABLE D TARGET_LAG = '1 hour' WAREHOUSE = W AS SELECT 1 AS A;\n")
        self.assertEqual((f["kind"], f["object"], f["replaces"]), ("create_dynamic_table", "ACME_DEV.S.D", True))
        f = self.facts_one("MERGE INTO ACME_DEV.S.T USING ACME_DEV.S.U s ON TRUE WHEN MATCHED THEN DELETE;\n")
        self.assertEqual((f["kind"], f["object"]), ("merge", "ACME_DEV.S.T"))

    def test_a_merge_names_what_each_when_clause_does_to_rows(self):
        f = self.facts_one(
            "MERGE INTO ACME_DEV.S.T t USING ACME_DEV.S.U s ON t.A = s.A\n"
            "WHEN MATCHED AND s.K = CASE WHEN s.F THEN 1 END THEN UPDATE SET B = CASE WHEN s.G THEN 1 ELSE 2 END, C = COALESCE(s.C, t.C)\n"
            "WHEN MATCHED THEN DELETE\n"
            "WHEN NOT MATCHED THEN INSERT (A) VALUES (s.A);\n"
        )
        self.assertEqual(f["actions"], ["UPDATE 2 columns", "DELETE", "INSERT"])
        f = self.facts_one("MERGE INTO ACME_DEV.S.T t USING ACME_DEV.S.U s ON t.A = s.A WHEN MATCHED THEN UPDATE SET B = 1;\n")
        self.assertEqual(f["actions"], ["UPDATE 1 column"])
        self.assertIn("no WHEN", self.facts_one("MERGE INTO ACME_DEV.S.T t USING ACME_DEV.S.U s ON t.A = s.A;\n").get("deny") or "")

    def test_a_column_named_like_a_keyword_cannot_hide_a_delete(self):
        for column in ('"CASE"', '"END"', '"WHEN"', '"DELETE"'):
            with self.subTest(column=column):
                f = self.facts_one(
                    "MERGE INTO ACME_DEV.S.T t USING ACME_DEV.S.U s ON t.A = s.A\n"
                    f"WHEN MATCHED AND s.A = 1 THEN UPDATE SET {column} = 1, B = 2\n"
                    "WHEN MATCHED THEN DELETE;\n"
                )
                self.assertIn("quotes", f.get("deny") or "")
        for column in ("CASE", "END"):
            with self.subTest(column=column):
                f = self.facts_one(
                    "MERGE INTO ACME_DEV.S.T t USING ACME_DEV.S.U s ON t.A = s.A\n"
                    f"WHEN MATCHED AND s.A = 1 THEN UPDATE SET {column} = 1, B = 2\n"
                    "WHEN MATCHED THEN DELETE;\n"
                )
                self.assertFalse(f.get("deny"))
                self.assertEqual(f["actions"], ["UPDATE 2 columns", "DELETE"])
        f = self.facts_one("MERGE INTO ACME_DEV.S.T t USING ACME_DEV.S.U s ON t.A = s.A WHEN MATCHED THEN UPDATE SET A = 1 DELETE;\n")
        self.assertIn("other than a MERGE's WHEN", f.get("deny") or "")

    def test_set_columns_are_counted_by_assignment_and_the_insert_function_is_not_a_row_insert(self):
        merge = "MERGE INTO ACME_DEV.S.T t USING ACME_DEV.S.U s ON t.A = s.A WHEN MATCHED THEN UPDATE SET {};\n"
        for sets, want in (
            ("A = CASE WHEN MATCHED THEN 1 ELSE 0 END, B = 2", ["UPDATE 2 columns"]),
            ("A = CASE WHEN s.F THEN INSERT(s.T, 1, 1, 'x') ELSE s.T END", ["UPDATE 1 column"]),
            ("A = INSERT(s.T, 1, 1, 'x'), B = COALESCE(s.B, 0)", ["UPDATE 2 columns"]),
            ("t.A = CASE WHEN MATCHED THEN 1 END, t.B = 2, t.C = 3, t.D = 4", ["UPDATE 4 columns"]),
        ):
            with self.subTest(sets=sets):
                f = self.facts_one(merge.format(sets))
                self.assertFalse(f.get("deny"))
                self.assertEqual(f["actions"], want)

    def test_functions_named_with_a_schema_and_the_snowflake_database_are_refused(self):
        for sql, why in (
            ("SELECT SNOWFLAKE.CORTEX.FINETUNE('CREATE', 'M', 'base', 'SELECT 1');\n", "SNOWFLAKE.CORTEX.FINETUNE"),
            ("SELECT ACME_DEV.S.MY_FN(A) FROM ACME_DEV.S.T;\n", "ACME_DEV.S.MY_FN"),
            ("USE DATABASE SNOWFLAKE;\nUSE SCHEMA CORTEX;\nSELECT FINETUNE('CREATE', 'M', 'base', 'SELECT 1');\n", "calls FINETUNE"),
            ("SELECT * FROM TABLE(OTHERDB..EVIL_PROC());\n", "calls EVIL_PROC,"),
            ("USE SCHEMA ACME_DEV.S;\nSELECT * FROM TABLE(EVIL_PROC());\n", "calls EVIL_PROC"),
            ("SELECT HAVERSINE(1, 2, 3, 4);\n", "calls HAVERSINE"),
        ):
            with self.subTest(sql=sql):
                self.assertIn(why, self.facts_one(sql).get("deny") or "")

    def test_an_object_named_through_identifier_or_table_is_refused(self):
        for target in ("MERGE INTO IDENTIFIER('ACME_DEV.OTHER.T') X USING ACME_DEV.S.U Y ON X.A = Y.A WHEN MATCHED THEN DELETE;",
                       "CREATE TABLE IF NOT EXISTS IDENTIFIER('ACME_DEV.OTHER.T') (A INT);",
                       "MERGE INTO TABLE('ACME_DEV.OTHER.T') X USING ACME_DEV.S.U Y ON X.A = Y.A WHEN MATCHED THEN DELETE;"):
            with self.subTest(target=target):
                f = self.facts_one(f"USE SCHEMA ACME_DEV.S;\n{target}\n")
                self.assertIn("IDENTIFIER or TABLE", f.get("deny") or "")

    def test_a_data_body_may_not_hold_other_statements_keywords(self):
        for body in ("COPY", "PUT", "GET", "USE", "BEGIN"):
            with self.subTest(body=body):
                f = self.facts_one(f"SELECT A FROM ACME_DEV.S.T WHERE {body} = 1;\n")
                self.assertIn(f"holds {body}", f.get("deny") or "")

    def test_an_insert_by_name_is_a_row_insert_and_a_method_call_is_refused(self):
        f = self.facts_one("MERGE INTO ACME_DEV.S.T t USING ACME_DEV.S.U s ON t.A = s.A\n"
                           "WHEN MATCHED THEN UPDATE SET V = s.V\nWHEN NOT MATCHED THEN INSERT ALL BY NAME;\n")
        self.assertEqual(f["actions"], ["UPDATE 1 column", "INSERT"])
        f = self.facts_one("MERGE INTO ACME_DEV.S.T t USING ACME_DEV.S.U s ON t.A = s.A\n"
                           "WHEN MATCHED THEN DELETE\nWHEN NOT MATCHED THEN INSERT ALL BY NAME;\n")
        self.assertEqual(f["actions"], ["DELETE", "INSERT"])
        self.assertIn("calls SPCS_CANCEL_JOB", self.facts_one("SELECT ACME_DEV.S.JOB!SPCS_CANCEL_JOB();\n").get("deny") or "")
        self.assertFalse(self.facts_one("SELECT A FROM ACME_DEV.S.T WHERE A != 1;\n").get("deny"))

    def test_each_parenthesised_word_is_a_decided_case(self):
        for body in ("CAST(A AS INT)", "TRY_CAST(A AS INT)", "IFF(A = 1, 1, 2)", "COALESCE(A, 0)", "A::NUMBER(38, 2)",
                     "EXISTS (SELECT 1 FROM ACME_DEV.S.U)", "A IN (1, 2)", "COUNT(*) OVER (PARTITION BY A)",
                     "LISTAGG(A, ',') WITHIN GROUP (ORDER BY A)", "(SELECT MAX(A) FROM ACME_DEV.S.U)",
                     "DATE(A)", "CAST(A AS NUMBER(10, 2))", "CASE WHEN (A = 1) THEN 1 END"):
            with self.subTest(body=body):
                self.assertFalse(self.facts_one(f"SELECT {body} FROM ACME_DEV.S.T;\n").get("deny"))
        self.assertIn('quotes "COUNT"', self.facts_one('SELECT "COUNT"(A) FROM ACME_DEV.S.T;\n').get("deny") or "")
        for body, name in (("EXISTS_EVIL(1)", "EXISTS_EVIL"), ("S.COUNT(A)", "S.COUNT"),
                           ("ACME_DEV.S.MY_FN(A)", "ACME_DEV.S.MY_FN"), ("KEY(A)", "KEY"), ("TEXT(A)", "TEXT"),
                           ("NUMBER(A)", "NUMBER"), ("OVER(A)", "OVER"), ("IDENTITY(A)", "IDENTITY"),
                           ("WITHIN(A)", "WITHIN"), ("PIVOT(A)", "PIVOT"), ("WHEN(A)", "WHEN"),
                           ("REFERENCES ACME_DEV.S.FN(1)", "ACME_DEV.S.FN")):
            with self.subTest(body=body):
                self.assertIn(f"calls {name},", self.facts_one(f"SELECT {body} FROM ACME_DEV.S.T;\n").get("deny") or "")

    def test_column_lists_after_a_cte_or_derived_table_are_not_calls(self):
        for sql in ("WITH C(A) AS (SELECT 1) SELECT A FROM C;\n",
                    "SELECT V.A FROM (VALUES (1), (2)) AS V(A);\n",
                    "SELECT V.A FROM (VALUES (1), (2)) V(A);\n"):
            with self.subTest(sql=sql):
                self.assertFalse(self.facts_one(sql).get("deny"))

    def test_a_select_list_alias_after_a_call_is_not_a_column_list(self):
        for sql in ("USE SCHEMA ACME_DEV.S;\nSELECT 1 AS A, EVIL_UDF(2) AS B;\n",
                    "USE SCHEMA ACME_DEV.S;\nSELECT 1 AS A, EVIL_UDF(B) AS C FROM ACME_DEV.S.T;\n",
                    "SELECT (SELECT 1) EVIL_UDF(2);\n"):
            with self.subTest(sql=sql):
                self.assertIn("calls EVIL_UDF", self.facts_one(sql).get("deny") or "")

    def test_using_and_identity_pass_as_syntax_only_where_nothing_else_could_be_meant(self):
        for sql, name in (("SELECT USING(A) FROM ACME_DEV.S.T;\n", "USING"),
                          ("SELECT A FROM ACME_DEV.S.T JOIN ACME_DEV.S.U USING (A);\n", "USING"),
                          ("CREATE TABLE ACME_DEV.S.N (A NUMBER DEFAULT IDENTITY(1));\n", "IDENTITY"),
                          ("CREATE TABLE ACME_DEV.S.N (A NUMBER AUTOINCREMENT(1, 1));\n", "AUTOINCREMENT")):
            with self.subTest(sql=sql):
                self.assertIn(f"calls {name},", self.facts_one(sql).get("deny") or "")
        f = self.facts_one("CREATE TABLE ACME_DEV.S.N (ID NUMBER AUTOINCREMENT START 1 INCREMENT 1, A INT);\n")
        self.assertFalse(f.get("deny"))

    def test_a_merge_reads_only_the_table_named_after_using_or_a_values_list(self):
        head = "USE SCHEMA ACME_DEV.S;\nMERGE INTO T USING "
        tail = " ON T.A = X.A WHEN NOT MATCHED THEN INSERT (A) VALUES (X.A);\n"
        subquery, other = "is a MERGE with a subquery", "is a MERGE whose USING is neither one table name"
        for using, why in (
            ("(SELECT V.A FROM VALUES (1) AS V(A), ACME_PROD.S.STRM S) X", subquery),
            ("VALUES (1) V(A), ACME_PROD.S.STRM X", other),
            ("(SELECT V.A FROM ACME_DEV.S.LIMIT V, ACME_PROD.S.STRM E) X", subquery),
            ("(WITH C AS (SELECT A FROM ACME_DEV.S.U) SELECT A FROM C) X", subquery),
            ("(SELECT Y.A FROM ACME_DEV.S.U Y, OTHER.S.STREAM1 Z) X", subquery),
            ("OTHER..STREAM1 X", other),
            ("TABLE('OTHER.S.STREAM1') X", other),
            ("(SELECT Y.A FROM (ACME_PROD.S.STRM Y JOIN ACME_DEV.S.V W ON Y.A = W.A)) X", subquery),
            ("(EVENTS_STREAM) X", subquery),
            ("(SELECT V.A FROM (VALUES (1)) V(A) JOIN ACME_PROD.S.STRM E ON TRUE) X", subquery),
            ("(SELECT V.A FROM VALUES (1) V(A) WHERE V.A IN (SELECT A FROM ACME_PROD.S.STRM)) X", subquery),
            ("(SELECT V.A FROM VALUES (1) V(A) UNION SELECT A FROM ACME_PROD.S.STRM) X", subquery),
            ("(SELECT Y.A FROM ACME_DEV.S.U Y JOIN ACME_DEV.S.V W USING (A)) X", subquery),
            ("ACME_DEV.S.U X ON T.A = (SELECT MAX(A) FROM ACME_PROD.S.STRM) AND T.A", subquery),
            ("(SELECT 1 IS DISTINCT FROM (VALUES (1)) FROM (ACME_PROD.S.STRM)) X", subquery),
            ("(SELECT EXTRACT(YEAR FROM COLUMN1) AS A FROM VALUES ('2020-01-01')) X", subquery),
            ("(SELECT * FROM VALUES (1) JOIN (ACME_PROD.S.STRM)) X", subquery),
            ("(VALUES (1)) JOIN (ACME_PROD.S.STRM)", other),
            ("ACME_DEV.S.U JOIN (ACME_PROD.S.STRM)", other),
            ("ACME_DEV.S.U LATERAL (ACME_PROD.S.STRM)", other),
            ("ACME_DEV.S.U X ON T.A IN (FROM ACME_PROD.S.STRM) AND T.A", subquery),
            ("ACME_DEV.S.U X ON EXISTS (TABLE ACME_PROD.S.STRM) AND T.A", subquery),
        ):
            with self.subTest(using=using):
                self.assertIn(why, self.facts_one(head + using + tail).get("deny") or "")
        f = self.facts_one("MERGE INTO ACME_DEV.S.T T USING ACME_DEV.S.U X ON T.A = X.A WHEN MATCHED THEN "
                           "UPDATE SET B = (SELECT MAX(B) FROM ACME_PROD.S.EVENTS_STREAM);\n")
        self.assertIn(subquery, f.get("deny") or "")
        for using, sources in (
            ("ACME_DEV.S.U X", ["ACME_DEV.S.U"]), ("ACME_DEV.S.U AS X", ["ACME_DEV.S.U"]), ("U X", ["ACME_DEV.S.U"]),
            ("(VALUES (1, 'A'), (2, 'B')) AS X(A, B)", []),
            ("(SELECT * FROM (VALUES (1, 'A')) AS V(A, B)) X", []),
            ("(SELECT COLUMN1 AS A, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ AS TS FROM VALUES (1), (2)) X", []),
        ):
            with self.subTest(using=using):
                f = self.facts_one(head + using + tail)
                self.assertFalse(f.get("deny"))
                self.assertEqual(f["sources"], sources)
        f = self.facts_one(head + "ACME_DEV.S.U X ON T.A = X.A WHEN MATCHED AND T.B IS DISTINCT FROM X.B "
                           "AND EXTRACT(YEAR FROM X.D) > 2000 THEN UPDATE SET B = X.B;\n")
        self.assertFalse(f.get("deny"))
        self.assertEqual(f["sources"], ["ACME_DEV.S.U"])

    def test_a_quoted_keyword_in_a_merge_is_refused(self):
        head = "USE SCHEMA ACME_DEV.S;\nMERGE INTO T USING "
        tail = " ON T.A = X.A WHEN NOT MATCHED THEN INSERT (A) VALUES (X.A);\n"
        for using, why in (('(SELECT A "DISTINCT" FROM ACME_PROD.S.EVENTS_STREAM) X', 'quotes "DISTINCT"'),
                           ('(SELECT Y.A FROM ACME_DEV.S.U "ON", ACME_PROD.S.EVENTS_STREAM Z) X', 'quotes "ON"')):
            with self.subTest(using=using):
                self.assertIn(why, self.facts_one(head + using + tail).get("deny") or "")

    def test_a_non_ascii_refusal_names_the_character_and_line_and_stays_ascii(self):
        for sql, want in (
            ("CREATE TABLE ACME_DEV.S.T (\n  A INT -- id \u2014 primary\n);\n",
             "U+2014 EM DASH, on line 2 of the statement (A INT -- id \\u2014 primary); replace it with plain ASCII"),
            ("CREATE ROLE R COMMENT = 'caf\u00e9';\n", "U+00E9 LATIN SMALL LETTER E WITH ACUTE, on line 1"),
            ("GRANT ROLE R\u200b1 TO ROLE ANALYST;\n", "U+200B ZERO WIDTH SPACE, on line 1"),
            ("SHOW ROLES\x07;\n", "U+0007 control character, on line 1"),
            ("CREATE TABLE ACME_DEV.S.T (\n  ORDER_ID INT, -- surrogate key copied from the upstream source system and kept \u2192 stable\n);\n",
             "U+2192 RIGHTWARDS ARROW, on line 2 of the statement (...stream source system and kept \\u2192 stable); replace"),
            ("CREATE TABLE ACME_DEV.S.T (\n  A INT -- id\u00a0\n);\n", "U+00A0 NO-BREAK SPACE, on line 2 of the statement (A INT -- id\\u00A0)"),
            ("CREATE ROLE R COMMENT = '\u0378';\n", "U+0378 unnamed character, on line 1 of the statement (CREATE ROLE R COMMENT = '\\u0378';)"),
        ):
            with self.subTest(sql=sql):
                deny = self.facts_one(sql).get("deny") or ""
                self.assertIn(want, deny)
                self.assertTrue(deny.isascii())

    def test_nextval_is_refused_outside_a_column_default(self):
        self.assertIn("NEXTVAL", self.facts_one("SELECT ACME_DEV.S.SEQ.NEXTVAL;\n").get("deny") or "")
        f = self.facts_one("CREATE TABLE ACME_DEV.S.T (ID NUMBER DEFAULT ACME_DEV.S.SEQ.NEXTVAL, A INT);\n")
        self.assertFalse(f.get("deny"))

    def test_a_query_built_from_a_string_is_refused(self):
        f = self.facts_one("SELECT * FROM TABLE(TO_QUERY('SELECT SYSTEM$CANCEL_ALL_QUERIES(1)'));\n")
        self.assertIn("calls TO_QUERY", f.get("deny") or "")

    def test_a_long_literal_values_list_is_cut_to_its_first_and_last_rows(self):
        sql = f"MERGE INTO ACME_DEV.S.T t USING (SELECT COLUMN1 AS A, COLUMN2 AS N FROM VALUES\n{VALUE_ROWS}\n) s ON t.A = s.A WHEN NOT MATCHED THEN INSERT (A) VALUES (s.A);\n"
        f = self.facts_one(sql)
        self.assertFalse(f.get("deny"))
        self.assertEqual(f["text"], sql.rstrip("\n").strip())
        cut = sql[sql.index("('id0'"):sql.index("('id6', 6)") + len("('id6', 6)")]
        self.assertEqual(f["collapsed"], [{"rows": 7, "sha256": hashlib.sha256(cut.encode()).hexdigest()}])
        self.assertIn("('id2', 2),\n    … 1 more rows …,\n    ('id4', 4)", f["display"])
        self.assertNotIn("('id3', 3)", f["display"])

    def test_a_long_values_list_that_is_not_all_literals_is_refused(self):
        for bad in ("(CURRENT_DATE(), 3)", "((SELECT 1), 3)", "(ID3, 3)", "(1 + 2, 3)"):
            with self.subTest(row=bad):
                rows = VALUE_ROWS.replace("('id3', 3)", bad)
                sql = f"MERGE INTO ACME_DEV.S.T t USING (SELECT COLUMN1 AS A FROM VALUES\n{rows}\n) s ON TRUE WHEN MATCHED THEN DELETE;\n"
                self.assertIn("long VALUES list", self.facts_one(sql).get("deny") or "")

    def test_only_a_values_list_is_ever_cut(self):
        tuples = ", ".join(f"('id{n}', {n})" for n in range(9))
        f = self.facts_one(f"SELECT * FROM ACME_DEV.S.T WHERE (A, N) IN ({tuples});\n")
        self.assertFalse(f.get("deny"))
        self.assertNotIn("collapsed", f)
        f = self.facts_one("MERGE INTO ACME_DEV.S.T t USING (SELECT COLUMN1 AS A FROM VALUES ('a'), (CURRENT_DATE()), ('c')) s ON TRUE WHEN MATCHED THEN DELETE;\n")
        self.assertFalse(f.get("deny"))
        self.assertNotIn("collapsed", f)


class Roles(Tiered):
    def test_every_step_names_its_role(self):
        facts = run("SHOW ROLES;\nUSE ROLE SECURITYADMIN;\nUSE SCHEMA ACME_DEV.S;\nUSE WAREHOUSE WH;\nCREATE ROLE R;\n")
        self.assertEqual(facts[0]["role"], DEFAULT_ROLE)
        last = facts[-1]
        self.assertEqual((last["role"], last["database"], last["schema"], last["warehouse"]),
                         ("SECURITYADMIN", "ACME_DEV", "S", "WH"))

    def test_no_usable_default_role_refuses_the_file(self):
        for role in (None, "ACCOUNTADMIN", "orgadmin", "BAD-NAME"):
            with self.subTest(role=role):
                facts = run("SHOW ROLES;\n", default_role=role)
                self.assertEqual(len(facts), 1)
                self.assertIn("no usable default role", facts[0]["deny"])

    def test_a_role_switch_off_the_list_is_refused(self):
        self.assertTier(["USE ROLE USERADMIN;\nCREATE ROLE R;\n", "USE ROLE ACCOUNTADMIN;\nSHOW ROLES;\n"], "deny")


class SnowRoot(unittest.TestCase):
    def _facts_without(self, extra):
        with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False) as f:
            f.write("SHOW ROLES;\n")
        try:
            return subprocess.run(
                [sys.executable, "-I", CLF, "--facts", "--default-role", DEFAULT_ROLE, *extra, f.name],
                capture_output=True, text=True,
            )
        finally:
            os.unlink(f.name)

    def test_refuses_without_a_snow_root(self):
        r = self._facts_without([])
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(r.stdout, "")
        self.assertIn("--snow-root", r.stderr)

    def test_refuses_a_snow_root_that_is_not_a_directory(self):
        r = self._facts_without(["--snow-root", os.path.join(HERE, "no-such-install")])
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(r.stdout, "")


if __name__ == "__main__":
    unittest.main()
