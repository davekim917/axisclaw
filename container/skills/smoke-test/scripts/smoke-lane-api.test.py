#!/usr/bin/env python3
import base64
import contextlib
import http.server
import io
import importlib
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.parse
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True
sys.path.insert(0, HERE)
api = importlib.import_module("smoke_lane_api")

RUN_ID = "acme-pr-pr7-0123456789ab-20260101T000000Z"
PREFIX = "QA-{}-".format(RUN_ID)
SCOPE = {"mode": "deny", "tenants": ["sandbox", "playground"],
         "authPaths": ["/users/login", "/users/refresh"], "readOnlyPosts": ["/widgets/search"],
         "denyPaths": ["/ledger/close", "/widgets/[^/]+/broadcast"], "denyPrefixes": ["/media", "/profile/photo"]}
SEAT_TENANTS = {"m@example.test": {"tenantId": "sandbox"}, "g@example.test": {"tenantId": "globex"},
                "n@example.test": {"sub": "9"}, "w@example.test": {"tenantId": "sandbox", "tenant_id": "globex"},
                "o@example.test": {"sub": "11"}}
MEDIA_URL = "https://media.example.test/fixture-bucket/photos/a.jpg"


def token_for(claims):
    raw = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return "h.{}.s".format(raw)


class Backend(http.server.BaseHTTPRequestHandler):
    seen = []
    store = {}
    modes = {}
    modes_by_auth = {}
    replies = {}
    auths = []

    def log_message(self, format, *args):
        pass

    def reply(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n)) if n else None
        Backend.seen.append((self.command, self.path, body))
        Backend.auths.append(self.headers.get("Authorization"))
        auth_key = (self.path, self.headers.get("Authorization"))
        if (self.command, self.path) in Backend.replies:
            status, out = Backend.replies[(self.command, self.path)]
            raw = json.dumps(out).encode()
            self.send_response(status)
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        if self.command == "GET" and (auth_key in Backend.modes_by_auth or self.path in Backend.modes):
            status, out = Backend.modes_by_auth.get(auth_key) or Backend.modes[self.path]
            raw = json.dumps(out).encode()
            self.send_response(status)
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        if self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "/elsewhere")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self.path.startswith("/users/login"):
            out = {"access_token": token_for(SEAT_TENANTS[(body or {}).get("email")])}
        elif self.path == "/users/switch-role":
            out = {"data": {"accessToken": token_for({"sub": "9", "role": (body or {}).get("roleType")})}}
        elif self.command == "POST":
            new_id = "fx-{}".format(900 + len(Backend.store))
            Backend.store["{}/{}".format(self.path, new_id)] = dict(body or {}, id=new_id)
            out = {"owner": {"id": 191}, "report": {"id": new_id}}
        elif self.command == "GET" and self.path in Backend.store:
            stored = Backend.store[self.path]
            out = stored if self.path.startswith("/bare/") else {"data": stored}
        else:
            out = {"ok": True}
        raw = json.dumps(out).encode()
        self.send_response(201 if self.command == "POST" else 200)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    do_GET = do_POST = do_PATCH = do_DELETE = do_PUT = reply


class Harness(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Backend)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = "http://127.0.0.1:{}".format(cls.server.server_port)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        Backend.seen.clear()
        Backend.store.clear()
        Backend.modes.clear()
        Backend.modes_by_auth.clear()
        Backend.replies.clear()
        Backend.auths.clear()
        self.tmp = tempfile.TemporaryDirectory()
        self.run_dir = os.path.join(self.tmp.name, RUN_ID)
        os.makedirs(self.run_dir)
        self.helper = os.path.join(self.tmp.name, "pw.sh")
        with open(self.helper, "w") as f:
            f.write('[ "$1" = held@example.test ] && exit 69\necho fictional-pw\n')

    def tearDown(self):
        self.tmp.cleanup()

    def pin(self, scope=None):
        src = os.path.join(self.tmp.name, "scope.json")
        with open(src, "w") as f:
            json.dump(SCOPE if scope is None else scope, f)
        return api.init_scope(self.run_dir, src)

    def client(self, *login):
        h = api.H(os.path.join(self.run_dir, "lanes", "l1"), run_dir=self.run_dir, base=self.base,
                  seats={"M": "m@example.test", "X": "held@example.test", "G": "g@example.test",
                         "N": "n@example.test", "W": "w@example.test"}, password_helper=self.helper)
        for seat in login:
            h.login(seat)
        return h

    def ledger(self):
        path = os.path.join(self.run_dir, api.LEDGER_FILE)
        if not os.path.exists(path):
            return set()
        with open(path) as f:
            return {"{}/{}".format(r["path"], r["id"]) for r in map(json.loads, f)}

    def assert_blocked(self, h, tag, method, path, body, reason, seat="M"):
        before = len(Backend.seen)
        with self.assertRaises(api.WriteScopeRefused) as ctx:
            h.call(tag, seat, method, path, body)
        self.assertIn(reason, str(ctx.exception))
        self.assertEqual(len(Backend.seen), before, "a refused write must send nothing")
        with open(os.path.join(h.out, tag + ".json")) as f:
            rec = json.load(f)
        self.assertTrue(rec["harnessBlocked"])
        self.assertEqual(rec["refusal"], "WRITE_SCOPE_REFUSED")
        self.assertNotIn("status", rec, "a refusal must never look like a product response")
        with open(os.path.join(h.out, "00-timeline.txt")) as f:
            self.assertIn("[{}] {} {} {} -> HARNESS_BLOCKED WRITE_SCOPE_REFUSED".format(tag, seat, method, path), f.read())

    def assert_sent(self, h, tag, method, path, body=None, seat="M"):
        before = len(Backend.seen)
        code, _ = h.call(tag, seat, method, path, body)
        self.assertIn(code, (200, 201))
        self.assertEqual(len(Backend.seen), before + 1)


class Guard(Harness):
    def test_no_scope_refuses_writes_but_not_reads(self):
        h = self.client()
        self.assertEqual(h.call("r1", "M", "GET", "/widgets/5")[0], 200)
        self.assert_blocked(h, "w1", "POST", "/notes", {"title": PREFIX + "a"}, "no-scope")
        with self.assertRaises(api.WriteScopeRefused):
            h.login("M")
        self.assertEqual([s[0] for s in Backend.seen], ["GET"])

    def test_login_needs_the_auth_exemption(self):
        self.pin(dict(SCOPE, authPaths=[]))
        with self.assertRaises(api.WriteScopeRefused):
            self.client().login("M")
        self.assertEqual(Backend.seen, [])
        os.unlink(os.path.join(self.run_dir, api.SCOPE_FILE))
        self.pin()
        h = self.client()
        self.assertEqual(h.login("M"), 201)
        self.assertEqual(Backend.seen[0][:2], ("POST", "/users/login"))
        self.assertIn("M", h.tok)

    def test_refused_login_evidence_holds_no_password(self):
        self.pin()
        scope = os.path.join(self.run_dir, api.SCOPE_FILE)
        with open(self.helper, "w") as f:
            f.write('rm -f "%s"\necho fictional-pw\n' % scope)
        h = self.client()
        with self.assertRaises(api.WriteScopeRefused):
            h.login("M")
        self.assertEqual(Backend.seen, [])
        with open(os.path.join(h.out, "login-M.json")) as f:
            saved = f.read()
        self.assertNotIn("fictional-pw", saved)
        self.assertIn("<redacted>", saved)

    def test_seat_lease_refusal_sends_no_login(self):
        self.pin()
        with self.assertRaises(SystemExit):
            self.client().login("X")
        self.assertEqual(Backend.seen, [])

    def test_ordinary_writes_in_a_scoped_tenant_go(self):
        self.pin()
        h = self.client("M")
        self.assert_sent(h, "o1", "POST", "/notes", {"body": "any note"})
        self.assert_sent(h, "o2", "PATCH", "/cards/4402", {"stage": "b"})
        self.assert_sent(h, "o3", "DELETE", "/users/4401")
        self.assert_sent(h, "o4", "PUT", "/widgets/7/settings", {"tenantId": "sandbox"})
        self.assert_sent(h, "o5", "POST", "/jobs", {"kind": "one-off"})
        self.assert_sent(h, "o6", "POST", "/mediakit/items", {"k": 1})
        self.assertEqual(self.ledger(), set(), "writes never ledger on their own")

    def test_deny_paths_refused_whatever_the_spelling(self):
        self.pin()
        h = self.client("M")
        for i, path in enumerate(("/ledger/close", "/Ledger/CLOSE", "/ledger/close/", "/ledger//close",
                                  "/ledger/%63lose", "/ledger/close?dryRun=false", "/widgets/9/broadcast")):
            self.assert_blocked(h, "d%d" % i, "POST", path, {"k": 1}, "denied-path rule=denyPaths")
        self.assert_blocked(h, "d-del", "DELETE", "/ledger/close", None, "denied-path")
        self.assert_blocked(h, "d-dot", "POST", "/ledger/x/../close", None, "bad-path")
        self.assert_sent(h, "d-near", "POST", "/ledger/close-preview", {"k": 1})

    def test_deny_prefixes_refuse_every_write_method_but_not_reads(self):
        self.pin()
        h = self.client("M")
        for method in ("POST", "PUT", "PATCH", "DELETE"):
            for path in ("/media", "/media/5", "/MEDIA/5/thumb/", "/profile/photo/upload"):
                self.assert_blocked(h, "p-{}-{}".format(method, len(Backend.seen)) + path.replace("/", "_"),
                                    method, path, {"k": 1}, "denied-path rule=denyPrefixes")
        self.assert_sent(h, "p-get", "GET", "/media/5")
        self.assert_sent(h, "p-sibling", "PATCH", "/profile/settings", {"k": 1})
        self.assert_sent(h, "p-seg", "POST", "/media-library", {"k": 1})

    def test_a_new_tenant_wide_route_is_refused_by_shape(self):
        self.pin()
        h = self.client("M")
        for i, path in enumerate(("/forecasts/nightly-resync", "/catalog/Rebuild", "/orders/archive",
                                  "/stats/reindex/all", "/history/backfill", "/admin/cron/trigger",
                                  "/budget/publishDraft", "/reports/jobs/run", "/imports/jobs/77/run",
                                  "/cache/refresh-all", "/jobs/7/runs", "/jobs/7/execute", "/jobs/run-all",
                                  "/job/trigger")):
            self.assertFalse(api.denied(api.load_scope(self.run_dir), api.route_of(path)), "not an exact rule")
            self.assert_blocked(h, "s%d" % i, "POST", path, {"k": 1}, "tenant-wide-shape")
        self.assert_blocked(h, "s-patch", "PATCH", "/users/refresh", {"k": 1}, "tenant-wide-shape")
        self.assert_sent(h, "s-auth", "POST", "/users/refresh", {"k": 1})
        self.assert_sent(h, "s-runner", "POST", "/runners/7/rerun-notes", {"k": 1})

    def test_scope_routes_are_server_routes_under_the_base_path(self):
        self.pin(dict(SCOPE, denyPaths=["/api/ledger/close"], denyPrefixes=["/api/media"]))
        h = api.H(os.path.join(self.run_dir, "lanes", "l2"), run_dir=self.run_dir, base=self.base + "/api/",
                  seats={"M": "m@example.test"}, password_helper=self.helper)
        self.assert_blocked(h, "b1", "POST", "/ledger/close", None, "denyPaths")
        self.assert_blocked(h, "b2", "DELETE", "/media/5", None, "denyPrefixes")
        self.assertEqual(api.judge(self.run_dir, "POST", "/ledger/close", None, ["sandbox"]), "write")

    def test_explicit_deny_beats_exemptions(self):
        self.pin(dict(SCOPE, readOnlyPosts=["/media/search"], authPaths=["/ledger/close"]))
        h = self.client()
        self.assert_blocked(h, "e1", "POST", "/media/search", {"q": 1}, "denyPrefixes")
        self.assert_blocked(h, "e2", "POST", "/ledger/close", None, "denyPaths")

    def test_writes_outside_the_scoped_tenants_refused(self):
        self.pin()
        h = self.client("M", "G", "N", "W")
        self.assert_blocked(h, "t1", "POST", "/notes", {"k": 1}, "foreign-tenant seat-tenant=globex", seat="G")
        self.assert_blocked(h, "t2", "POST", "/notes", {"k": 1}, "foreign-tenant seat-tenant=globex", seat="W")
        self.assert_blocked(h, "t3", "POST", "/notes", {"k": 1}, "no-tenant", seat="N")
        self.assert_blocked(h, "t4", "POST", "/notes", {"k": 1}, "no-tenant", seat="X")
        self.assert_blocked(h, "t5", "POST", "/notes", {"tenantId": "globex"}, "foreign-tenant targets=tenantId=globex")
        self.assert_blocked(h, "t6", "POST", "/notes?tenant=globex", {"k": 1}, "foreign-tenant")
        self.assert_blocked(h, "t7", "POST", "/notes", {"meta": {"tenant_id": "globex"}}, "foreign-tenant")
        for i, empty in enumerate((None, [], [None], "")):
            self.assert_blocked(h, "t8e%d" % i, "POST", "/notes", {"tenantId": empty}, "foreign-tenant")
        self.assert_blocked(h, "t9", "POST", "/notes", {"tenants": ["sandbox", "globex"]}, "foreign-tenant")
        self.assert_blocked(h, "t9b", "POST", "/notes", {"Tenant-Id": "globex"}, "foreign-tenant")
        self.assert_blocked(h, "t9c", "POST", "/notes?tenantId%5B%5D=globex", {"k": 1}, "foreign-tenant")
        self.assert_blocked(h, "t9d", "POST", "/notes?filter%5Btenant_id%5D=globex", {"k": 1}, "foreign-tenant")
        self.assert_sent(h, "t10", "POST", "/notes", {"tenants": ["sandbox", "playground"]})
        self.assertEqual(h.call("t11", "G", "GET", "/notes")[0], 200, "reads go from any seat")
        before = len(Backend.seen)
        with self.assertRaises(api.WriteScopeRefused):
            h.req("DELETE", "/users/4401")
        self.assertEqual(len(Backend.seen), before, "the client's own send method is guarded too")
        self.assert_blocked(h, "t12", "POST", "//4401/cards", {"k": 1}, "bad-path")
        with self.assertRaises(api.WriteScopeRefused):
            h.call("t13", "M", "GET", "relative/path")
        self.assertEqual(len(Backend.seen), before, "a malformed path is refused even for a read")

    def test_redirects_are_not_followed(self):
        self.pin()
        h = self.client()
        self.assertEqual(h.call("r1", "M", "GET", "/redirect")[0], 302)
        self.assertEqual([p for _, p, _ in Backend.seen], ["/redirect"], "a redirect is reported, never followed")

    def test_read_only_post_is_an_explicit_list(self):
        self.pin()
        h = self.client()
        self.assertEqual(h.call("q1", "M", "POST", "/widgets/search", {"markets": ["M1"]})[0], 201)
        self.assert_blocked(h, "q2", "POST", "/widgets/search/save", {"markets": ["M1"]}, "no-tenant")

    def test_own_ledgers_only_a_verified_readback(self):
        self.pin()
        h = self.client("M")
        name = PREFIX + "coord-r1"
        code, js = h.call("c1", "M", "POST", "/reports", {"name": name, "segmentId": 81})
        self.assertEqual(code, 201)
        self.assertEqual(self.ledger(), set(), "a create response is never parsed for ownership")
        h.own("c3", "M", "/reports", js["report"]["id"], name)
        self.assertEqual(self.ledger(), {"/reports/" + js["report"]["id"]})
        with self.assertRaises(api.WriteScopeRefused) as ctx:
            h.own("c7", "M", "/reports", 191, name)
        self.assertIn("unverified-fixture", str(ctx.exception), "the owner id in the response is not the object")
        Backend.store["/accounts/4401"] = {"id": 4401, "name": "Existing client", "notes": [{"name": name}]}
        with self.assertRaises(api.WriteScopeRefused):
            h.own("c8", "M", "/accounts", 4401, name)
        Backend.store["/bare/4403"] = {"id": 4403, "name": "Existing", "report": {"id": 4403, "name": name}}
        Backend.store["/bare/4404"] = {"id": 4404, "name": "Existing", "data": {"id": 4404, "name": name}}
        for acct in (4403, 4404):
            with self.assertRaises(api.WriteScopeRefused):
                h.own("c8e%d" % acct, "M", "/bare", acct, name)
        Backend.store["/accounts/4402"] = {"id": "fx-777", "name": name}
        with self.assertRaises(api.WriteScopeRefused):
            h.own("c8b", "M", "/accounts", 4402, name)
        quoted = PREFIX + 'say "hi"'
        _, qjs = h.call("c8q", "M", "POST", "/reports", {"name": quoted})
        h.own("c8r", "M", "/reports", qjs["report"]["id"], quoted)
        before = len(Backend.seen)
        with self.assertRaises(api.WriteScopeRefused) as ctx:
            h.own("c9", "M", "/reports", js["report"]["id"], PREFIX)
        self.assertIn("not-a-qa-name", str(ctx.exception))
        self.assertEqual(len(Backend.seen), before, "a bad name is refused before any read")
        self.assertEqual(len(self.ledger()), 2)
        with open(os.path.join(h.out, "c7-own.json")) as f:
            self.assertTrue(json.load(f)["harnessBlocked"])

    def test_evidence_holds_no_secrets(self):
        self.pin()
        h = self.client()
        with self.assertRaises(api.WriteScopeRefused):
            h.call("s1", "M", "POST", "/notes?access_token=FICTIONAL-TOKEN&x=1", {"k": 1})
        h.call("s2", "M", "POST", "/users/login", {"email": "m@example.test", "password": "fictional-pw"})
        h.login("M")
        with self.assertRaises(api.WriteScopeRefused):
            h.call("s3", "M", "POST", "/media", {"meta": {"access_token": "FICTIONAL-TOKEN"}})
        issued = h.tok["M"].split(".")[1]
        for f in ("s1.json", "s2.json", "s3.json", "00-timeline.txt"):
            with open(os.path.join(h.out, f)) as fh:
                text = fh.read()
            for secret in ("FICTIONAL-TOKEN", "fictional-pw", issued):
                self.assertNotIn(secret, text, "{} leaks {}".format(f, secret))

    def test_signed_url_secrets_never_reach_evidence_or_stdout(self):
        signed = (MEDIA_URL + "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=FAKE-CRED-ID%2F20260101%2Faws4_request"
                  "&X-Amz-Expires=3600&X-Amz-Security-Token=FAKE-SESSION&X-Amz-SignedHeaders=host"
                  "&X-Amz-Signature=FAKE-SIG-0123")
        gcs = MEDIA_URL + "?X-Goog-Credential=FAKE-GCRED&X-Goog-Signature=FAKE-GSIG"
        Backend.replies[("GET", "/media/9")] = (200, {"data": {"items": [{"thumb": {"src": signed}}],
                                                              "note": "Download it from {} (link expires)".format(gcs),
                                                              signed: {"width": 640}}})
        self.pin()
        out = os.path.join(self.tmp.name, "stdout.txt")
        with open(out, "w") as f, contextlib.redirect_stdout(f):
            h = self.client("M")
            h.call("u1", "M", "GET", "/media/9")
            h.call("u2", "M", "GET", "/media/9?X-Amz-Credential=FAKE-CRED-ID&X-Amz-Signature=FAKE-SIG-0123")
            h.call("u3", "M", "GET", "/media/fetch?src=" + urllib.parse.quote(signed, safe=""))
            self.assert_sent(h, "u4", "POST", "/notes", {"body": "any note", "attachment": {"url": signed},
                                                        "gallery": (gcs,)})
            with self.assertRaises(api.WriteScopeRefused):
                h.own_item("u5", "M", "/media/9?X-Amz-Credential=FAKE-CRED-ID&X-Amz-Signature=FAKE-SIG-0123")
        for name in (out, "u1.json", "u2.json", "u3.json", "u4.json", "u5.json", "00-timeline.txt"):
            with open(os.path.join(h.out, name)) as fh:
                text = fh.read()
            for secret in ("FAKE-CRED-ID", "FAKE-SESSION", "FAKE-SIG-0123", "FAKE-GCRED", "FAKE-GSIG"):
                self.assertNotIn(secret, text, "{} leaks {}".format(name, secret))
        with open(os.path.join(h.out, "u1.json")) as fh:
            response = json.load(fh)["response"]["data"]
        self.assertEqual(response["items"][0]["thumb"]["src"],
                         MEDIA_URL + "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=[REDACTED]"
                         "&X-Amz-Expires=3600&X-Amz-Security-Token=[REDACTED]&X-Amz-SignedHeaders=host"
                         "&X-Amz-Signature=[REDACTED]")
        self.assertTrue(response["note"].startswith("Download it from " + MEDIA_URL + "?X-Goog-Credential=[REDACTED]&"),
                        response["note"])
        with open(out) as fh:
            self.assertIn("GET /media/9?X-Amz-Credential=[REDACTED]", fh.read())

    def test_a_broken_browser_allowlist_does_not_stop_the_lane_client_loading(self):
        allow = os.path.join(self.tmp.name, "ab-net-allow.txt")
        with open(allow, "w") as f:
            f.write("(" * 2000 + ")" * 2000 + "\n")
        env = {"PATH": os.environ["PATH"], "PYTHONDONTWRITEBYTECODE": "1", "AB_NET_REDACT_ALLOW_FILE": allow}
        r = subprocess.run([sys.executable, "-c", "import smoke_lane_api; print(smoke_lane_api.scrub_str('/a?sig=FAKE'))"],
                           cwd=HERE, env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual((r.returncode, r.stdout), (0, "/a?sig=[REDACTED]\n"), r.stderr[-300:])

    def test_scope_from_another_run_refused(self):
        self.pin()
        other = os.path.join(self.tmp.name, "acme-pr-pr8-0123456789ab-20260102T000000Z")
        os.makedirs(other)
        os.rename(os.path.join(self.run_dir, api.SCOPE_FILE), os.path.join(other, api.SCOPE_FILE))
        with self.assertRaises(api.WriteScopeRefused) as ctx:
            api.judge(other, "POST", "/notes", {"k": 1}, ["sandbox"])
        self.assertIn("scope-run-mismatch", str(ctx.exception))

    def test_unreadable_or_allowlist_scope_refuses(self):
        path = os.path.join(self.run_dir, api.SCOPE_FILE)
        with open(path, "w") as f:
            f.write("{")
        with self.assertRaises(api.WriteScopeRefused) as ctx:
            api.judge(self.run_dir, "PUT", "/x", None, ["sandbox"])
        self.assertIn("unreadable-scope", str(ctx.exception))
        legacy = {k: v for k, v in SCOPE.items() if k != "mode"}
        with open(path, "w") as f:
            json.dump(dict(legacy, accounts=[], brands=[], runId=RUN_ID), f)
        with self.assertRaises(api.WriteScopeRefused) as ctx:
            api.judge(self.run_dir, "PUT", "/x", None, ["sandbox"])
        self.assertIn("mode must be", str(ctx.exception), "a deny file missing its mode fails closed")
        os.unlink(path)
        with self.assertRaises(ValueError):
            self.pin(legacy)
        bad = ([("denyPrefix", ["/media"])], [("denypaths", ["/ledger/close"])], [("accounts", [])],
               [("denyPrefixes", ["/"])], [("denyPrefixes", ["/media/"])], [("denyPrefixes", ["/Media"])],
               [("denyPrefixes", ["/me%64ia"])], [("denyPrefixes", ["/media//x"])], [("denyPrefixes", ["media"])],
               [("denyPaths", ["/ledger/close/"])], [("denyPaths", ["/ledger//close"])],
               [("denyPaths", ["/ledger/%63lose"])], [("tenants", [7])])
        for pairs in bad:
            with self.assertRaises(ValueError, msg=pairs):
                self.pin(dict(SCOPE, **dict(pairs)))
        for key in ("tenants", "denyPaths", "denyPrefixes"):
            with self.assertRaises(ValueError, msg=key):
                self.pin({k: v for k, v in SCOPE.items() if k != key})
        with open(path, "w") as f:
            json.dump(dict(SCOPE, denyPrefix=["/media"], runId=RUN_ID), f)
        with self.assertRaises(api.WriteScopeRefused) as ctx:
            api.judge(self.run_dir, "POST", "/media/5", None, ["sandbox"])
        self.assertIn("unknown keys", str(ctx.exception), "a typo'd rule key fails closed, not open")
        os.unlink(path)
        self.pin()
        real = os.path.join(self.tmp.name, "scope-copy.json")
        os.rename(path, real)
        os.symlink(real, path)
        with self.assertRaises(api.WriteScopeRefused) as ctx:
            api.judge(self.run_dir, "POST", "/notes", {"k": 1}, ["sandbox"])
        self.assertIn("no-scope", str(ctx.exception), "a symlinked scope is refused, not followed")

    def test_allowlist_era_scope_keeps_its_old_behaviour(self):
        legacy = {"tenants": [], "brands": [], "accounts": [], "authPaths": ["/users/login"],
                  "readOnlyPosts": ["/widgets/search"]}
        pinned = self.pin(legacy)
        self.assertEqual((pinned["schemaVersion"], "mode" in pinned), (1, False))
        h = self.client()
        self.assertEqual(h.login("M"), 201)
        self.assertEqual(h.call("l1", "M", "POST", "/widgets/search", {"q": 1})[0], 201)
        name = PREFIX + "legacy"
        code, js = h.call("l2", "M", "POST", "/reports", {"name": name})
        self.assertEqual(code, 201)
        self.assert_blocked(h, "l3", "PATCH", "/reports/" + js["report"]["id"], {"slot": 2}, "foreign-target")
        h.own("l4", "M", "/reports", js["report"]["id"], name)
        self.assert_sent(h, "l5", "PATCH", "/reports/" + js["report"]["id"], {"slot": 2})
        self.assert_blocked(h, "l6", "POST", "/notes", {"body": "x"}, "no-qa-target")
        self.assert_blocked(h, "l7", "POST", "/notes", {"name": PREFIX + "n", "accountId": 4401}, "foreign-target")

    def test_a_run_already_holding_an_allowlist_pin_keeps_working(self):
        with open(os.path.join(self.run_dir, api.SCOPE_FILE), "w") as f:
            json.dump({"tenants": [], "brands": [], "accounts": [], "authPaths": ["/users/login"],
                       "readOnlyPosts": [], "schemaVersion": 1, "runId": RUN_ID}, f)
        h = self.client()
        self.assertEqual(h.login("M"), 201)
        self.assert_sent(h, "k1", "POST", "/notes", {"title": PREFIX + "n"})
        self.assert_blocked(h, "k2", "DELETE", "/users/4401", None, "foreign-target")

    def test_a_file_mixing_both_formats_is_refused(self):
        with self.assertRaises(ValueError):
            self.pin({"tenants": [], "authPaths": [], "readOnlyPosts": [], "denyPrefixes": ["/media"]})
        with self.assertRaises(ValueError):
            self.pin({"tenants": [], "brands": [], "denyPaths": []})

    def test_cli(self):
        src = os.path.join(self.tmp.name, "scope.json")
        with open(src, "w") as f:
            json.dump(SCOPE, f)
        cli = [sys.executable, os.path.join(HERE, "smoke_lane_api.py")]
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
        run = lambda *a: subprocess.run(cli + list(a), capture_output=True, text=True, env=env)
        missing = run("check", self.run_dir, "POST", "/notes", "--tenant", "sandbox")
        self.assertEqual(missing.returncode, 77, "a missing scope file refuses through the CLI too")
        self.assertIn("no-scope", missing.stderr)
        self.assertEqual(run("init", self.run_dir, "--from", src).returncode, 0)
        self.assertEqual(run("init", self.run_dir, "--from", src).returncode, 3, "the scope is pinned once")
        ok = run("check", self.run_dir, "PATCH", "/cards/4402", "--body", '{"stage": "b"}', "--tenant", "sandbox")
        self.assertEqual((ok.returncode, ok.stdout.strip()), (0, "write"))
        flipped = run("check", self.run_dir, "PATCH", "/cards/4402", "--tenant", "sandbox", "--body", "{}")
        self.assertEqual(flipped.returncode, 0)
        for args, reason in ((("POST", "/notes"), "no-tenant"),
                             (("POST", "/notes", "--tenant", "globex"), "foreign-tenant"),
                             (("DELETE", "/media/5", "--tenant", "sandbox"), "denied-path"),
                             (("POST", "/stock/resync", "--tenant", "sandbox"), "tenant-wide-shape"),
                             (("POST", "//4401/cards", "--tenant", "sandbox"), "bad-path")):
            no = run("check", self.run_dir, *args)
            self.assertEqual(no.returncode, 77, args)
            self.assertTrue(no.stderr.startswith("WRITE_SCOPE_REFUSED reason="), no.stderr)
            self.assertIn(reason, no.stderr)
        self.assertEqual(run("check", self.run_dir, "POST", "/notes", "--tenants", "sandbox").returncode, 2)
        self.assertEqual(run("check", self.run_dir, "POST", "/notes", "--tenant").returncode, 2)
        with open(src, "w") as f:
            json.dump(dict(SCOPE, readOnlyPosts=["("]), f)
        self.assertEqual(run("init", os.path.join(self.tmp.name, "fresh"), "--from", src).returncode, 2)
        old = os.path.join(self.tmp.name, "acme-pr-pr9-0123456789ab-20260103T000000Z")
        os.makedirs(old)
        with open(src, "w") as f:
            json.dump({"tenants": [], "brands": [], "accounts": [], "authPaths": ["/users/login"], "readOnlyPosts": []}, f)
        self.assertEqual(run("init", old, "--from", src).returncode, 0, "init accepts an allowlist-era file")
        self.assertEqual(run("check", old, "POST", "/users/login").returncode, 0)
        self.assertEqual(run("check", old, "POST", "/notes", "--body", '{"title": "x"}').returncode, 77)


GUARDS = [
    {"methods": ["PUT"], "path": "/v1/blocks/(?P<level>[^/]+)/(?P<id>[^/]+)",
     "read": "/v1/blocks/{level}/{id}", "field": "{level}.mode", "allow": ["two_person"]},
    {"methods": ["POST"], "path": "/v1/visuals",
     "read": "/v1/collateral/{body.canonicalSubjectType}/{body.canonicalSubjectId}", "field": "mode",
     "allow": ["two_person"]},
    {"methods": ["POST"], "path": "/v1/asset-studio/assets/(?P<id>[^/]+)/save",
     "read": "/v1/asset-studio/assets/{id}", "field": "needsApproval", "allow": [True]},
]
GUARDED = dict(SCOPE, approvalModeGuards=GUARDS)


class ApprovalModeGuard(Harness):
    """A save that publishes without a second approver is refused unless the seat reads an allowed mode first."""

    def setUp(self):
        super().setUp()
        self.pin(GUARDED)

    def assert_refused_unwritten(self, h, tag, method, path, body, reason, seat="M"):
        before = len(Backend.seen)
        with self.assertRaises(api.WriteScopeRefused) as ctx:
            h.call(tag, seat, method, path, body)
        self.assertIn(reason, str(ctx.exception))
        sent = Backend.seen[before:]
        self.assertTrue(all(m == "GET" for m, _, _ in sent), "only the mode read may go: {}".format(sent))
        with open(os.path.join(h.out, tag + ".json")) as f:
            rec = json.load(f)
        self.assertTrue(rec["harnessBlocked"])
        self.assertEqual(rec["refusal"], "WRITE_SCOPE_REFUSED")
        self.assertIn("single_person_publish", rec["reason"])
        self.assertNotIn("status", rec)
        with open(os.path.join(h.out, "00-timeline.txt")) as f:
            self.assertIn("[{}] {} {} {} -> HARNESS_BLOCKED WRITE_SCOPE_REFUSED reason=single_person_publish".format(
                tag, seat, method, path), f.read())
        return sent

    def test_single_person_mode_refuses_the_save_and_sends_no_write(self):
        Backend.modes["/v1/blocks/brand/ACME-B-000166"] = (200, {"brand": {"mode": "single_person"}})
        h = self.client("M")
        sent = self.assert_refused_unwritten(h, "b1", "PUT", "/v1/blocks/brand/ACME-B-000166",
                                             {"writingSamples": []}, "single_person_publish mode=single_person")
        self.assertEqual([p for _, p, _ in sent], ["/v1/blocks/brand/ACME-B-000166"], "ids keep their case")
        self.assertEqual(Backend.auths[-1], "Bearer " + h.tok["M"], "the mode is read on the writing seat")
        with open(os.path.join(h.out, "b1-approval-mode.json")) as f:
            self.assertEqual(json.load(f)["response"]["brand"]["mode"], "single_person")
        Backend.modes["/v1/collateral/brand/ACME-B-1"] = (200, {"mode": "single_person"})
        self.assert_refused_unwritten(h, "v1", "POST", "/v1/visuals",
                                      {"canonicalSubjectType": "brand", "canonicalSubjectId": "ACME-B-1"}, "mode=")
        Backend.modes["/v1/asset-studio/assets/a7"] = (200, {"needsApproval": False})
        self.assert_refused_unwritten(h, "a1", "POST", "/v1/asset-studio/assets/a7/save", {}, "mode=false")

    def test_two_person_mode_lets_the_save_go(self):
        Backend.modes["/v1/blocks/company/ACME-O-000004"] = (200, {"company": {"mode": "two_person"}})
        h = self.client("M")
        before = len(Backend.seen)
        code, _ = h.call("c1", "M", "PUT", "/v1/blocks/company/ACME-O-000004", {"story": "x"})
        self.assertEqual(code, 200)
        self.assertEqual([(m, p) for m, p, _ in Backend.seen[before:]],
                         [("GET", "/v1/blocks/company/ACME-O-000004"), ("PUT", "/v1/blocks/company/ACME-O-000004")])
        Backend.modes["/v1/asset-studio/assets/a8"] = (200, {"needsApproval": True})
        self.assert_sent_after_read(h, "a2", "POST", "/v1/asset-studio/assets/a8/save", {})

    def assert_sent_after_read(self, h, tag, method, path, body):
        before = len(Backend.seen)
        code, _ = h.call(tag, "M", method, path, body)
        self.assertIn(code, (200, 201))
        self.assertEqual([m for m, _, _ in Backend.seen[before:]], ["GET", method])

    def test_an_unreadable_mode_refuses(self):
        h = self.client("M")
        cases = (
            ("u1", (200, {"brand": {"mode": None}}), "approval-mode-unreadable"),
            ("u2", (403, {"brand": {"mode": "two_person"}}), "approval-mode-unreadable status=403"),
            ("u3", (200, {"company": {"mode": "two_person"}}), "approval-mode-unreadable"),
            ("u4", (200, {"brand": {"mode": "TWO_PERSON"}}), "mode=TWO_PERSON"),
            ("u5", (200, {"brand": {"mode": {"value": "two_person"}}}), "approval-mode-unreadable"),
            ("u6", (200, {"brand": "two_person"}), "approval-mode-unreadable"),
            ("u7", (200, {"data": {"brand": {"mode": "two_person"}}}), "approval-mode-unreadable"),
        )
        for tag, reply, reason in cases:
            Backend.modes["/v1/blocks/brand/B-{}".format(tag)] = reply
            self.assert_refused_unwritten(h, tag, "PUT", "/v1/blocks/brand/B-{}".format(tag), {"k": 1}, reason)
        sent = self.assert_refused_unwritten(h, "u8", "PUT", "/v1/blocks/brand/B-404", {"k": 1}, "unreadable")
        self.assertEqual(len(sent), 1, "an absent read route is unreadable, not a pass")
        Backend.modes["/v1/asset-studio/assets/a9"] = (200, {"needsApproval": "true"})
        self.assert_refused_unwritten(h, "u9", "POST", "/v1/asset-studio/assets/a9/save", {}, "mode=true")
        for i, body in enumerate(({"canonicalSubjectType": "brand"}, None, ["x"],
                                  {"canonicalSubjectType": "brand", "canonicalSubjectId": ""},
                                  {"canonicalSubjectType": "brand", "canonicalSubjectId": True})):
            sent = self.assert_refused_unwritten(h, "ub%d" % i, "POST", "/v1/visuals", body, "missing=")
            self.assertEqual(sent, [], "an unresolvable read sends nothing at all")

    def test_unguarded_routes_and_reads_are_untouched(self):
        h = self.client("M")
        before = len(Backend.seen)
        self.assertEqual(h.call("n1", "M", "PUT", "/v1/blocks/brand/B1/extra", {"k": 1})[0], 200)
        self.assertEqual(h.call("n2", "M", "POST", "/v1/blocks/brand/B1/derive", {"k": 1})[0], 201)
        self.assertEqual(h.call("n3", "M", "PATCH", "/v1/blocks/brand/B1", {"k": 1})[0], 200)
        self.assertEqual(h.call("n4", "M", "GET", "/v1/blocks/brand/B1")[0], 200)
        self.assertEqual(h.call("n5", "M", "POST", "/notes", {"k": 1})[0], 201)
        self.assertEqual([m for m, _, _ in Backend.seen[before:]], ["PUT", "POST", "PATCH", "GET", "POST"],
                         "no mode read for a route no guard names")

    def test_static_refusals_come_first_and_send_no_read(self):
        h = self.client("M", "G")
        Backend.modes["/v1/blocks/brand/B1"] = (200, {"brand": {"mode": "two_person"}})
        before = len(Backend.seen)
        self.refused_without_read(h, "f1", "G", "foreign-tenant")
        self.refused_without_read(h, "f2", "M", "foreign-tenant", {"tenantId": "globex"})
        os.unlink(os.path.join(self.run_dir, api.SCOPE_FILE))
        self.pin(dict(GUARDED, denyPaths=["/v1/blocks/[^/]+/[^/]+"]))
        self.refused_without_read(h, "f3", "M", "denied-path")
        self.assertEqual(len(Backend.seen), before)

    def refused_without_read(self, h, tag, seat, reason, body=None):
        with self.assertRaises(api.WriteScopeRefused) as ctx:
            h.call(tag, seat, "PUT", "/v1/blocks/brand/B1", body or {"k": 1})
        self.assertIn(reason, str(ctx.exception))

    def test_base_path_is_stripped_from_the_read(self):
        os.unlink(os.path.join(self.run_dir, api.SCOPE_FILE))
        guard = dict(GUARDS[0], path="/api/v1/blocks/(?P<level>[^/]+)/(?P<id>[^/]+)", read="/api/v1/blocks/{level}/{id}")
        self.pin(dict(SCOPE, approvalModeGuards=[guard]))
        h = api.H(os.path.join(self.run_dir, "lanes", "l2"), run_dir=self.run_dir, base=self.base + "/api/",
                  seats={"M": "m@example.test"}, password_helper=self.helper)
        h.tok["M"] = token_for({"tenantId": "sandbox"})
        Backend.modes["/api/v1/blocks/brand/B1"] = (200, {"brand": {"mode": "single_person"}})
        before = len(Backend.seen)
        with self.assertRaises(api.WriteScopeRefused) as ctx:
            h.call("bp1", "M", "PUT", "/v1/blocks/brand/B1", {"k": 1})
        self.assertIn("mode=single_person", str(ctx.exception))
        self.assertEqual([(m, p) for m, p, _ in Backend.seen[before:]], [("GET", "/api/v1/blocks/brand/B1")])
        os.unlink(os.path.join(self.run_dir, api.SCOPE_FILE))
        self.pin(dict(SCOPE, approvalModeGuards=[dict(guard, read="/other/{level}/{id}")]))
        with self.assertRaises(api.WriteScopeRefused) as ctx:
            h.call("bp2", "M", "PUT", "/v1/blocks/brand/B1", {"k": 1})
        self.assertIn("outside the client base", str(ctx.exception))

    def test_cli_check_refuses_a_guarded_route_it_cannot_read(self):
        cli = [sys.executable, os.path.join(HERE, "smoke_lane_api.py")]
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
        no = subprocess.run(cli + ["check", self.run_dir, "PUT", "/v1/blocks/brand/B1", "--tenant", "sandbox",
                                   "--body", "{}"], capture_output=True, text=True, env=env)
        self.assertEqual(no.returncode, 77)
        self.assertTrue(no.stderr.startswith("WRITE_SCOPE_REFUSED reason=single_person_publish approval-mode-unread"))
        ok = subprocess.run(cli + ["check", self.run_dir, "PUT", "/v1/blocks/brand/B1/extra", "--tenant", "sandbox"],
                            capture_output=True, text=True, env=env)
        self.assertEqual((ok.returncode, ok.stdout.strip()), (0, "write"))
        with self.assertRaises(api.ApprovalModeUnread) as ctx:
            api.judge(self.run_dir, "put", "/v1/Blocks/Brand/B%2D1", {}, ["sandbox"])
        self.assertEqual((ctx.exception.read_path, ctx.exception.field), ("/v1/blocks/Brand/B-1", "Brand.mode"))

    def test_encoded_separators_are_refused_at_every_entry(self):
        Backend.modes["/v1/blocks/brand/B1"] = (200, {"brand": {"mode": "single_person"}})
        h = self.client("M")
        cli = [sys.executable, os.path.join(HERE, "smoke_lane_api.py")]
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
        cases = (("PUT", "/v1/blocks/brand/B1%2F"), ("PUT", "/v1/blocks/brand/B1%2f/"), ("PUT", "/v1/blocks%2Fbrand/B1"),
                 ("POST", "/v1/visuals%2F"), ("POST", "/v1/asset-studio/assets/A1/save%2F"),
                 ("PUT", "/v1/blocks/brand/B1%5C"), ("PUT", "/v1/blocks/brand/B1\\x"), ("PUT", "/v1/blocks/brand/B1%00"),
                 ("PUT", "/v1/blocks/brand/B1%252F"), ("POST", "/ledger%2Fclose"), ("DELETE", "/media%2F5"))
        before = len(Backend.seen)
        for i, (method, path) in enumerate(cases):
            body = {"canonicalSubjectType": "brand", "canonicalSubjectId": "B1"}
            with self.assertRaises(api.WriteScopeRefused, msg=path) as ctx:
                h.call("x%d" % i, "M", method, path, body)
            self.assertIn("bad-path", str(ctx.exception), path)
            with open(os.path.join(h.out, "x%d.json" % i)) as f:
                self.assertTrue(json.load(f)["harnessBlocked"])
            with self.assertRaises(api.WriteScopeRefused, msg=path):
                h.req(method, path, h.tok["M"], body, tag="xr%d" % i, seat="M")
            no = subprocess.run(cli + ["check", self.run_dir, method, path, "--tenant", "sandbox", "--body", json.dumps(body)],
                                capture_output=True, text=True, env=env)
            self.assertEqual(no.returncode, 77, path)
            self.assertIn("bad-path", no.stderr, path)
        self.assertEqual(Backend.seen[before:], [], "an ambiguous path sends nothing, not even the mode read")
        for method in ("GET", "HEAD", "OPTIONS"):
            self.assertEqual(api.judge(self.run_dir, method, "/objects/a%2Fb"), "read", "reads always go")

    def test_req_reads_the_mode_with_the_writes_own_token(self):
        h = self.client("M")
        cached = h.tok["M"]
        other = token_for({"tenantId": "playground"})
        Backend.modes_by_auth[("/v1/blocks/brand/B1", "Bearer " + cached)] = (200, {"brand": {"mode": "two_person"}})
        Backend.modes_by_auth[("/v1/blocks/brand/B1", "Bearer " + other)] = (200, {"brand": {"mode": "single_person"}})
        before = len(Backend.seen)
        with self.assertRaises(api.WriteScopeRefused) as ctx:
            h.req("PUT", "/v1/blocks/brand/B1", other, {"k": 1}, tag="r1", seat="M")
        self.assertIn("mode=single_person", str(ctx.exception))
        self.assertEqual([m for m, _, _ in Backend.seen[before:]], ["GET"])
        self.assertEqual(Backend.auths[-1], "Bearer " + other, "the mode is read with the token that would write")
        code, _, _ = h.req("PUT", "/v1/blocks/brand/B1", cached, {"k": 1}, tag="r2", seat="M")
        self.assertEqual(code, 200)
        self.assertEqual([m for m, _, _ in Backend.seen[before:]], ["GET", "GET", "PUT"])
        self.assertEqual(Backend.auths[-2:], ["Bearer " + cached] * 2)
        with self.assertRaises(api.WriteScopeRefused) as ctx:
            h.req("PUT", "/v1/blocks/brand/B1", None, {"k": 1}, tag="r3", seat="M")
        self.assertIn("no-tenant", str(ctx.exception))
        self.assertEqual(len(Backend.seen), before + 3, "a tokenless write reads nothing")

    def test_guards_are_pinned_and_malformed_guards_fail_closed(self):
        with open(os.path.join(self.run_dir, api.SCOPE_FILE)) as f:
            self.assertEqual(json.load(f)["approvalModeGuards"], GUARDS)
        os.unlink(os.path.join(self.run_dir, api.SCOPE_FILE))
        g = GUARDS[0]
        bad = ({}, "x", [dict(g, extra=1)], [{k: v for k, v in g.items() if k != "allow"}],
               [dict(g, methods=["put"])], [dict(g, methods=["GET"])], [dict(g, methods=[])],
               [dict(g, path="/v1/blocks/")], [dict(g, path="/v1//blocks")], [dict(g, path="v1/blocks")],
               [dict(g, path="/v1/blocks/(")], [dict(g, read="v1/blocks/{id}")], [dict(g, read="/v1/{nope}")],
               [dict(g, field="{nope}.mode")], [dict(g, read="/v1/{id")], [dict(g, field="")],
               [dict(g, allow=[])], [dict(g, allow="two_person")], [dict(g, allow=[1])])
        for guards in bad:
            with self.assertRaises((ValueError, api.re.error), msg=guards):
                self.pin(dict(SCOPE, approvalModeGuards=guards))
            self.assertFalse(os.path.exists(os.path.join(self.run_dir, api.SCOPE_FILE)), guards)
        with open(os.path.join(self.run_dir, api.SCOPE_FILE), "w") as f:
            json.dump(dict(SCOPE, approvalModeGuards=[dict(g, methods=["put"])], runId=RUN_ID), f)
        with self.assertRaises(api.WriteScopeRefused) as ctx:
            api.judge(self.run_dir, "POST", "/notes", {"k": 1}, ["sandbox"])
        self.assertIn("unreadable-scope", str(ctx.exception), "a tampered pin refuses every write")


OWNED = {"path": "/trips/(?P<parent>[^/]+)/stops/(?P<item>[^/]+)", "read": "/trips/{parent}", "items": "data.stops",
         "require": {"visited": [False], "visitedAt": [None], "checkedInAt": [None]}}
OWNED_SCOPE = dict(SCOPE, denyPaths=SCOPE["denyPaths"] + ["/trips/[^/]+/stops/[^/]+"], ownedDeletes=[OWNED])
UNUSED = {"visited": False, "visitedAt": None, "checkedInAt": None}


def trip(*stops):
    return 200, {"data": {"id": "T1", "stops": [dict(UNUSED, id=s) if isinstance(s, int) else s for s in stops]}}


class OwnedDelete(Harness):
    """DELETE alone may pass a deny, for an item this run ledgered and a fresh read still shows unused."""

    def setUp(self):
        super().setUp()
        self.pin(OWNED_SCOPE)
        Backend.modes["/trips/T1"] = trip(51, 53, dict(UNUSED, id=52, visited=True, visitedAt="2026-01-01T00:00:00Z"))

    def sent_since(self, before):
        return [(m, p) for m, p, _ in Backend.seen[before:]]

    def test_a_ledgered_unused_item_is_deleted_and_no_other_method_opens(self):
        h = self.client("M")
        h.own_item("o1", "M", "/trips/T1/stops/51")
        before = len(Backend.seen)
        code, _ = h.call("d1", "M", "DELETE", "/trips/T1/stops/51")
        self.assertEqual(code, 200)
        self.assertEqual(self.sent_since(before), [("GET", "/trips/T1"), ("DELETE", "/trips/T1/stops/51")])
        for method in ("PATCH", "PUT", "POST"):
            self.assert_blocked(h, "w-" + method, method, "/trips/T1/stops/51", {"visited": True}, "denied-path")

    def test_an_unledgered_item_is_refused_before_any_read(self):
        h = self.client("M")
        self.assert_blocked(h, "d2", "DELETE", "/trips/T1/stops/53", None, "owned-delete not-ledgered")

    def test_the_item_is_read_again_and_any_sign_of_use_refuses(self):
        h = self.client("M")
        h.own_item("o3", "M", "/trips/T1/stops/51")
        cases = (
            ("visited", trip(dict(UNUSED, id=51, visited=True)), "in-use field=visited"),
            ("visitedAt", trip(dict(UNUSED, id=51, visitedAt="2026-01-02T00:00:00Z")), "in-use field=visitedAt"),
            ("checkedIn", trip(dict(UNUSED, id=51, checkedInAt="2026-01-02T00:00:00Z")), "in-use field=checkedInAt"),
            ("absentField", trip({"id": 51, "visited": False, "visitedAt": None}), "in-use field=checkedInAt"),
            ("gone", trip(53), "item-not-found"),
            ("forbidden", (403, {"data": {"stops": [dict(UNUSED, id=51)]}}), "unreadable status=403"),
            ("notAList", (200, {"data": {"stops": {"51": UNUSED}}}), "unreadable"),
        )
        for tag, reply, reason in cases:
            Backend.modes["/trips/T1"] = reply
            before = len(Backend.seen)
            with self.assertRaises(api.WriteScopeRefused, msg=tag) as ctx:
                h.call(tag, "M", "DELETE", "/trips/T1/stops/51")
            self.assertIn(reason, str(ctx.exception), tag)
            self.assertEqual(self.sent_since(before), [("GET", "/trips/T1")], tag)

    def test_an_item_read_on_its_own_is_the_one_candidate(self):
        os.unlink(os.path.join(self.run_dir, api.SCOPE_FILE))
        route = {"path": "/routes/(?P<item>[0-9]+)", "read": "/routes/{item}", "items": "data",
                 "require": {"isEmpty": [True]}}
        self.pin(dict(OWNED_SCOPE, denyPaths=OWNED_SCOPE["denyPaths"] + ["/routes/[^/]+"],
                      ownedDeletes=[OWNED, route]))
        empty = (200, {"data": {"id": 7, "isEmpty": True}})
        Backend.modes["/routes/7"] = empty
        h = self.client("M")
        h.own_item("r7", "M", "/routes/7")
        for tag, data, reason in (("busy", {"id": 7, "isEmpty": False}, "in-use field=isEmpty"),
                                  ("other", {"id": 8, "isEmpty": True}, "item-not-found"),
                                  ("noId", {"isEmpty": True}, "unreadable"),
                                  ("boolId", {"id": True, "isEmpty": True}, "unreadable")):
            Backend.modes["/routes/7"] = (200, {"data": data})
            with self.assertRaises(api.WriteScopeRefused, msg=tag) as ctx:
                h.call(tag, "M", "DELETE", "/routes/7")
            self.assertIn(reason, str(ctx.exception), tag)
        Backend.modes["/routes/7"] = empty
        before = len(Backend.seen)
        self.assertEqual(h.call("rd", "M", "DELETE", "/routes/7")[0], 200)
        self.assertEqual(self.sent_since(before), [("GET", "/routes/7"), ("DELETE", "/routes/7")])

    def test_scope_checks_still_bind_an_owned_delete(self):
        h = self.client("M", "G")
        h.own_item("o4", "M", "/trips/T1/stops/51")
        self.assert_blocked(h, "d4", "DELETE", "/trips/T1/stops/51", None, "foreign-tenant", seat="G")

    def test_own_item_ledgers_only_an_unused_item_it_read(self):
        h = self.client("M")
        for tag, path, reason in (("v", "/trips/T1/stops/52", "in-use field=visited"),
                                  ("missing", "/trips/T1/stops/99", "item-not-found"),
                                  ("unlisted", "/notes/T1/stops/51", "no-owned-delete")):
            with self.assertRaises(api.WriteScopeRefused, msg=tag) as ctx:
                h.own_item(tag, "M", path)
            self.assertIn(reason, str(ctx.exception), tag)
        self.assertEqual(self.ledger(), set())
        h.own_item("ok", "M", "/trips/T1/stops/51")
        self.assertEqual(self.ledger(), {"/trips/T1/stops/51"})

    def test_no_spelling_lets_one_ledgered_item_cover_another(self):
        Backend.modes["/trips/T1"] = trip(dict(UNUSED, id="A"), dict(UNUSED, id="a"), 51)
        Backend.modes["/api/trips/T1"] = Backend.modes["/trips/T1"]
        h = self.client("M")
        h.own_item("oA", "M", "/trips/T1/stops/A")
        self.assert_blocked(h, "case", "DELETE", "/trips/T1/stops/a", None, "owned-delete not-ledgered")
        h.own_item("o51", "M", "/trips/T1/stops/51")
        for i, path in enumerate(("/trips/T1/stops/51%3Fx", "/trips/T1/stops/51%23x", "/trips/T1/stops/5%31")):
            self.assert_blocked(h, "enc%d" % i, "DELETE", path, None, "denied-path")
        os.unlink(os.path.join(self.run_dir, api.SCOPE_FILE))
        os.unlink(os.path.join(self.run_dir, api.LEDGER_FILE))
        self.pin(dict(OWNED_SCOPE, denyPaths=["/api/trips/[^/]+/stops/[^/]+"],
                      ownedDeletes=[dict(OWNED, path="/api/trips/(?P<parent>[^/]+)/stops/(?P<item>[^/]+)",
                                         read="/api/trips/{parent}")]))
        based = api.H(os.path.join(self.run_dir, "lanes", "l2"), run_dir=self.run_dir, base=self.base + "/api",
                      seats={"M": "m@example.test"}, password_helper=self.helper)
        based.tok["M"] = token_for({"tenantId": "sandbox"})
        based.own_item("b51", "M", "/trips/T1/stops/51")
        for i, path in enumerate(("/trips/T1/stops/51%3Fx", "/trips/T1/stops/51%23x")):
            self.assert_blocked(based, "benc%d" % i, "DELETE", path, None, "denied-path")
        before = len(Backend.seen)
        self.assertEqual(based.call("bok", "M", "DELETE", "/trips/T1/stops/51")[0], 200)
        self.assertEqual(self.sent_since(before), [("GET", "/api/trips/T1"), ("DELETE", "/api/trips/T1/stops/51")])

    def test_a_row_without_an_id_matches_no_item(self):
        h = self.client("M")
        for i, row in enumerate((dict(UNUSED), {"id": None, **UNUSED})):
            Backend.modes["/trips/T1"] = trip(row)
            with self.assertRaises(api.WriteScopeRefused, msg=row) as ctx:
                h.own_item("oNone%d" % i, "M", "/trips/T1/stops/None")
            self.assertIn("item-not-found", str(ctx.exception))
        self.assertEqual(self.ledger(), set())

    def test_a_fixture_ledgered_by_own_is_not_an_owned_delete(self):
        api.record_fixture(self.run_dir, "/trips/T1/stops", "51", PREFIX + "stop")
        self.assert_blocked(self.client("M"), "fx", "DELETE", "/trips/T1/stops/51", None, "owned-delete not-ledgered")

    def test_cli_check_names_what_it_cannot_read(self):
        self.client("M").own_item("o6", "M", "/trips/T1/stops/51")
        cli = [sys.executable, os.path.join(HERE, "smoke_lane_api.py")]
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
        for method, path, reason in (("DELETE", "/trips/T1/stops/51", "owned-delete-unread read=/trips/T1"),
                                     ("DELETE", "/trips/T1/stops/53", "owned-delete not-ledgered"),
                                     ("PATCH", "/trips/T1/stops/51", "denied-path")):
            out = subprocess.run(cli + ["check", self.run_dir, method, path, "--tenant", "sandbox"],
                                 capture_output=True, text=True, env=env)
            self.assertEqual(out.returncode, 77, path)
            self.assertIn(reason, out.stderr, (method, path))

    def test_malformed_owned_deletes_fail_closed(self):
        os.unlink(os.path.join(self.run_dir, api.SCOPE_FILE))
        bad = ({}, [dict(OWNED, extra=1)], [{k: v for k, v in OWNED.items() if k != "require"}],
               [dict(OWNED, path="/trips/(?P<parent>[^/]+)/stops/[^/]+")], [dict(OWNED, path="/trips/")],
               [dict(OWNED, read="trips/{parent}")], [dict(OWNED, read="/trips/{nope}")], [dict(OWNED, items="")],
               [dict(OWNED, require={})], [dict(OWNED, require={"visited": []})], [dict(OWNED, require={"visited": [1]})])
        for entries in bad:
            with self.assertRaises((ValueError, api.re.error), msg=entries):
                self.pin(dict(OWNED_SCOPE, ownedDeletes=entries))
            self.assertFalse(os.path.exists(os.path.join(self.run_dir, api.SCOPE_FILE)), entries)


SEAT_SCOPE = dict(SCOPE, tenants=[], authPaths=["/users/login", "/users/switch-role"], seats=["n@example.test"])
PASSWORD = "fictional-file-pw-7Qx"


class SeatScope(Harness):
    """A product whose tokens carry only `sub` scopes writes by the seat this client signed in."""

    def setUp(self):
        super().setUp()
        self.lease = os.path.join(self.tmp.name, "lease.py")
        with open(self.lease, "w") as f:
            f.write("import sys\nsys.exit(69 if sys.argv[2] == 'held@example.test' else 0)\n")
        self.logins = os.path.join(self.tmp.name, "private", "logins.json")
        os.makedirs(os.path.dirname(self.logins))
        self.write_logins({"n@example.test": PASSWORD, "o@example.test": PASSWORD, "g@example.test": PASSWORD,
                           "held@example.test": PASSWORD})

    def write_logins(self, logins, mode=0o600, path=None):
        path = path or self.logins
        with open(path, "w") as f:
            json.dump(logins, f)
        os.chmod(path, mode)

    def file_client(self, *login, logins=None):
        h = api.H(os.path.join(self.run_dir, "lanes", "l1"), run_dir=self.run_dir, base=self.base,
                  seats={"N": "n@example.test", "O": "o@example.test", "G": "g@example.test", "X": "held@example.test"},
                  password_helper="/nonexistent/helper.sh", logins_file=logins or self.logins, lease_tool=self.lease)
        for seat in login:
            h.login(seat)
        return h

    def test_a_scoped_seat_writes_without_a_tenant_claim(self):
        self.pin(SEAT_SCOPE)
        h = self.file_client("N")
        self.assert_sent(h, "p1", "POST", "/notes", {"body": "any"}, seat="N")
        self.assert_sent(h, "p2", "PATCH", "/cards/4402", {"stage": "b"}, seat="N")

    def test_seat_scope_keeps_every_other_refusal(self):
        self.pin(SEAT_SCOPE)
        h = self.file_client("N", "O", "G")
        self.assert_blocked(h, "q1", "POST", "/notes", {"k": 1}, "foreign-seat seat=o@example.test", seat="O")
        self.assert_blocked(h, "q0", "POST", "/notes", {"k": 1}, "foreign-tenant seat-tenant=globex", seat="G")
        self.assert_blocked(h, "q2", "POST", "/media/upload", {"k": 1}, "denied-path", seat="N")
        self.assert_blocked(h, "q3", "POST", "/stock/resync", {"k": 1}, "tenant-wide-shape", seat="N")
        self.assert_blocked(h, "q4", "POST", "/notes", {"tenantId": "sandbox"}, "foreign-tenant", seat="N")

    def test_a_token_this_client_did_not_issue_has_no_seat(self):
        self.pin(SEAT_SCOPE)
        h = self.file_client()
        before = len(Backend.seen)
        with self.assertRaises(api.WriteScopeRefused) as ctx:
            h.exchange("t1", "N", "POST", "/notes", {"k": 1}, token_for({"sub": "9"}))
        self.assertIn("no-seat", str(ctx.exception))
        self.assertEqual(len(Backend.seen), before)

    def test_without_seats_a_claimless_token_still_refuses(self):
        self.pin(dict(SEAT_SCOPE, seats=[]))
        h = self.file_client("N")
        self.assert_blocked(h, "u1", "POST", "/notes", {"k": 1}, "no-tenant", seat="N")

    def test_seats_must_be_canonical_and_are_pinned_only_when_set(self):
        for bad in ("n@example.test", ["N@example.test"], ["not-an-email"], [5]):
            with self.assertRaises(ValueError, msg=bad):
                self.pin(dict(SEAT_SCOPE, seats=bad))
        self.assertEqual(self.pin(SEAT_SCOPE)["seats"], ["n@example.test"])
        os.unlink(os.path.join(self.run_dir, api.SCOPE_FILE))
        self.assertNotIn("seats", self.pin(), "a tenant-scoped pin is unchanged")

    def test_a_role_switch_token_replaces_the_seats_token(self):
        self.pin(SEAT_SCOPE)
        h = self.file_client("N")
        first = h.tok["N"]
        self.assertEqual(h.call("sw", "N", "POST", "/users/switch-role", {"roleType": "store"})[0], 201)
        self.assertNotEqual(h.tok["N"], first)
        self.assert_sent(h, "after", "POST", "/notes", {"k": 1}, seat="N")
        self.assertEqual(Backend.auths[-1], "Bearer " + h.tok["N"], "the write carries the switched token")
        self.assertIn("store", json.dumps(api.claims(h.tok["N"])))
        with open(os.path.join(h.out, "00-timeline.txt")) as f:
            timeline = f.read()
        self.assertIn("[sw] N token replaced by a refresh", timeline)
        self.assertNotIn(h.tok["N"].split(".")[1], timeline)

    def test_a_refresh_is_adopted_only_on_a_2xx_auth_answer_to_the_seats_own_token_for_the_same_user(self):
        self.pin(SEAT_SCOPE)
        h = self.file_client("N", "O")
        own, other = h.tok["N"], h.tok["O"]
        role = "/users/switch-role"
        rows = (("partial", own, role, 201, {"access_token": token_for({"sub": "9", "userId": "77"})}),
                ("rejected", own, role, 401, {"access_token": token_for({"sub": "9", "role": "admin"})}),
                ("not-auth", own, "/notes", 201, {"token": token_for({"sub": "9", "role": "admin"})}),
                ("o-token", other, role, 201, {"access_token": token_for({"sub": "11", "role": "admin"})}))
        for tag, tok, path, status, reply in rows:
            Backend.replies[("POST", path)] = (status, reply)
            self.assertEqual(h.exchange(tag, "N", "POST", path, {"k": 1}, tok)[0], status, tag)
            self.assertEqual((h.tok["N"], h.tok["O"]), (own, other), tag)
        with open(os.path.join(h.out, "00-timeline.txt")) as f:
            self.assertNotIn("token replaced", f.read())
        same = token_for({"sub": "9", "role": "admin"})
        Backend.replies[("POST", role)] = (201, {"access_token": same})
        h.exchange("same", "N", "POST", role, {"k": 1}, own)
        self.assertEqual(h.tok["N"], same, "the same user's refresh on the seat's own token is adopted")

    def test_a_token_without_an_identity_claim_is_never_adopted(self):
        self.pin()
        h = self.client("M")
        own = h.tok["M"]
        for i, fresh in enumerate((token_for({"tenantId": "sandbox", "role": "admin"}), "opaque-fictional-token")):
            Backend.replies[("POST", "/users/refresh")] = (200, {"access_token": fresh})
            self.assertEqual(h.call("nc%d" % i, "M", "POST", "/users/refresh", {"k": 1})[0], 200)
            self.assertEqual(h.tok["M"], own, fresh)

    def test_another_users_token_on_an_auth_path_is_not_adopted(self):
        self.pin(SEAT_SCOPE)
        h = self.file_client("N")
        own = h.tok["N"]
        code, _ = h.call("other", "N", "POST", "/users/login", {"email": "o@example.test", "password": PASSWORD})
        self.assertEqual(code, 201)
        self.assertEqual(h.tok["N"], own, "a login as o@ must not become n@'s token")
        self.assert_sent(h, "after", "POST", "/notes", {"k": 1}, seat="N")
        self.assertEqual(Backend.auths[-1], "Bearer " + own)

    def test_logins_file_password_never_reaches_evidence_or_stdout(self):
        self.pin(SEAT_SCOPE)
        out = os.path.join(self.tmp.name, "stdout.txt")
        with open(out, "w") as f, contextlib.redirect_stdout(f):
            h = self.file_client("N")
            self.assert_sent(h, "v1", "POST", "/notes", {"k": 1}, seat="N")
        self.assertEqual(Backend.seen[0][2], {"email": "n@example.test", "password": PASSWORD})
        texts = [out] + [os.path.join(h.out, n) for n in os.listdir(h.out)]
        for path in texts:
            with open(path) as f:
                self.assertNotIn(PASSWORD, f.read(), path)

    def test_logins_file_refusals_send_nothing_and_quote_nothing(self):
        self.pin(SEAT_SCOPE)
        inside = os.path.join(self.run_dir, "logins.json")
        self.write_logins({"n@example.test": PASSWORD}, path=inside)
        link = os.path.join(self.tmp.name, "link.json")
        os.symlink(self.logins, link)
        cases = (("X", None, "SEAT_LEASE_REFUSED"),
                 ("N", inside, "inside the run's evidence"),
                 ("N", link, "not a regular file"),
                 ("N", os.path.join(self.tmp.name, "absent.json"), "is missing"))
        for seat, logins, reason in cases:
            self.assert_refused_locally(seat, logins, reason)
        self.write_logins({"n@example.test": PASSWORD}, mode=0o644)
        self.assert_refused_locally("N", None, "mode 0600")
        self.write_logins({"g@example.test": PASSWORD})
        self.assert_refused_locally("N", None, "no password for n@example.test")
        with open(self.logins, "w") as f:
            f.write('{"n@example.test": "%s"' % PASSWORD)
        self.assert_refused_locally("N", None, "not JSON")
        self.write_logins({"n@example.test": PASSWORD})
        with mock.patch.object(api.os, "getuid", return_value=os.getuid() + 1):
            self.assert_refused_locally("N", None, "must be owned by this user")
        h = self.file_client(logins=self.logins)
        h.lease_tool = os.path.join(self.tmp.name, "no-lease.py")
        with self.assertRaises(SystemExit):
            h.login("N")
        self.assertEqual(Backend.seen, [], "no lease tool refuses like the seat helper does")

    def assert_refused_locally(self, seat, logins, reason):
        h = self.file_client(logins=logins)
        out = io.StringIO()
        with contextlib.redirect_stdout(out), self.assertRaises(SystemExit):
            h.login(seat)
        self.assertEqual(Backend.seen, [], reason)
        self.assertIn(reason, out.getvalue())
        self.assertIn("REFUSED locally", out.getvalue())
        self.assertNotIn(PASSWORD, out.getvalue())
        self.assertNotIn(seat, h.tok)

    def test_cli_check_takes_the_seat(self):
        self.pin(SEAT_SCOPE)
        cli = [sys.executable, os.path.join(HERE, "smoke_lane_api.py"), "check", self.run_dir, "POST", "/notes"]
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
        ok = subprocess.run(cli + ["--seat", "n@example.test"], capture_output=True, text=True, env=env)
        self.assertEqual((ok.returncode, ok.stdout.strip()), (0, "write"))
        for extra, reason in ((["--seat", "o@example.test"], "foreign-seat"), ([], "no-seat")):
            no = subprocess.run(cli + extra, capture_output=True, text=True, env=env)
            self.assertEqual(no.returncode, 77, extra)
            self.assertIn(reason, no.stderr)



class RelativeRunDir(Harness):
    """The run id is the run directory's own name, however the caller spells the path."""

    def test_a_run_dir_given_as_dot_pins_and_loads_as_its_directory_name(self):
        src = os.path.join(self.tmp.name, "scope.json")
        with open(src, "w") as f:
            json.dump(SCOPE, f)
        old = os.getcwd()
        os.chdir(self.run_dir)
        try:
            self.assertEqual(api.init_scope(".", src)["runId"], RUN_ID)
            self.assertEqual(api.fixture_prefix("."), PREFIX)
            self.assertEqual(api.load_scope(".")["tenants"], SCOPE["tenants"])
        finally:
            os.chdir(old)
        self.assertEqual(api.judge(self.run_dir, "POST", "/notes", {"k": 1}, ["sandbox"]), "write")

if __name__ == "__main__":
    unittest.main(verbosity=1)
