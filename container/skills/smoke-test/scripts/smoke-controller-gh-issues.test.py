#!/usr/bin/env python3
"""Controller finding issues against a repo's real label set (#1107).

One campaign wedged its finish for an hour: an owner wrote `labels: ["P3"]`, the
repo has no `P3` (its convention is `severity:p3`), GitHub refused the whole
`gh issue create`, and the controller threw gh's stderr away -- so the
decision said `effect: unknown` and the overdue alarm said nothing about why.
Runs the real Effects._gh and Controller.github against the gh fake."""
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("controller", HERE / "smoke-campaign-controller.py")
ctl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ctl)
RUN = "acme-pr-pr7-aaaaaaaaaaaa-20260918T100000Z"
FAKES = HERE / "testdata" / "controller-live-fakes.py"


class ResolveLabels(unittest.TestCase):
    def test_maps_severity_shorthand_drops_unknown_keeps_repo_spelling(self):
        kept, mapped, dropped = ctl.resolve_labels(["smoke-finding", "P3", "UI", "nope", "ui"],
                                                   ["smoke-finding", "severity:p3", "ui", "bug"])
        self.assertEqual(kept, ["smoke-finding", "severity:p3", "ui"])
        self.assertEqual(mapped, ["P3->severity:p3"])
        self.assertEqual(dropped, ["nope"])

    def test_shorthand_without_a_severity_label_is_dropped_and_an_exact_p_label_is_kept(self):
        self.assertEqual(ctl.resolve_labels(["P1"], ["bug"]), ([], [], ["P1"]))
        self.assertEqual(ctl.resolve_labels(["P1"], ["P1", "severity:p1"]), (["P1"], [], []))

    def test_smoke_finding_is_dropped_like_any_label_the_repo_lacks(self):
        self.assertEqual(ctl.resolve_labels(["smoke-finding", "P3"], ["severity:p3"]),
                         (["severity:p3"], ["P3->severity:p3"], ["smoke-finding"]))

    def test_listing_failed_sends_labels_unchanged(self):
        self.assertEqual(ctl.resolve_labels(["smoke-finding", "P3"], None), (["smoke-finding", "P3"], [], []))


class FindingIssue(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.state = root / "fake"
        self.state.mkdir()
        os.environ["FAKE_STATE"] = str(self.state)
        os.environ["FAKE_LOG"] = str(root / "calls.ndjson")
        issues = root / "runs" / RUN / "controller" / "issues"
        issues.mkdir(parents=True)
        (issues / "CF-1.json").write_text(json.dumps(
            {"title": "Upload preview missing", "body": "Seen on B1.", "labels": ["smoke-finding", "P3", "nope"]}))
        journal = root / "journal"
        journal.mkdir()
        gh = "{} {} gh".format(sys.executable, FAKES)
        self.fx = ctl.EffectLayer("live", {"repo": "acme/widget", "send_to": "x", "gate_cmd": "/unused",
                                       "enqueue_cmd": "/unused", "gh_cmd": gh, "ncl_cmd": "/unused"})
        c = ctl.Controller.__new__(ctl.Controller)
        c.journal = ctl.Journal.__new__(ctl.Journal)
        c.journal.records, c.journal._obs, c.journal.dir = [], {}, str(journal)
        c.journal.append = lambda rec: c.journal._fold(rec)
        c.args = SimpleNamespace(run_root=str(root / "runs"))
        c.gate = SimpleNamespace(active_claims=lambda: {}, pr_for_run=lambda run_id: 7)
        c.now = dt.datetime(2026, 9, 23, 15, 51, tzinfo=dt.timezone.utc)
        c.fire, c.planned, c.decisions, c.alarms = "fire-one", set(), [], []
        c.decide = lambda run_id, phase, dtype, cls, reason, **extra: c.decisions.append(dict(extra, type=dtype))
        c.ensure_alarm = lambda run_id, trigger, fp, detail, **kw: c.alarms.append((trigger, detail)) or True
        c.effects = self.fx
        self.fx.bind(c)
        c.record(RUN, "run", "claim", "claimed", detail={"pr": 7, "sha": "a" * 40})
        self.c = c

    def tearDown(self):
        self.tmp.cleanup()

    def gh(self, **db):
        (self.state / "gh.json").write_text(json.dumps(dict({"comments": {}, "issues": [], "prs": {}}, **db)))

    def filed(self):
        return json.loads((self.state / "gh.json").read_text())["issues"]

    def test_unknown_label_is_dropped_shorthand_mapped_and_the_create_lands(self):
        self.gh(labels=["smoke-finding", "severity:p3", "bug"])
        self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-1"), "done")
        [issue] = self.filed()
        self.assertEqual(issue["labels"], ["smoke-finding", "severity:p3"])
        self.assertIn("dropped: `nope`", issue["body"])
        self.assertEqual(self.c.decisions[-1]["labelsDropped"], ["nope"])
        self.assertEqual(self.c.decisions[-1]["labelsMapped"], ["P3->severity:p3"])
        ob = self.c.obligations()[ctl.obligation_key(RUN, "gh", "issue:CF-1")]
        self.assertEqual((ob["state"], ob["detail"]["labelsDropped"]), ("done", ["nope"]))

    def test_repo_labels_are_listed_once_per_fire(self):
        self.gh(labels=["smoke-finding", "severity:p3"])
        (Path(self.c.args.run_root) / RUN / "controller" / "issues" / "CF-2.json").write_text(
            json.dumps({"title": "Second finding", "labels": ["P3"]}))
        self.c.github(RUN, "synthesis", "issue:CF-1")
        self.c.github(RUN, "synthesis", "issue:CF-2")
        with open(os.environ["FAKE_LOG"]) as fh:
            calls = [json.loads(line) for line in fh]
        self.assertEqual(sum(1 for x in calls if x["argv"][:2] == ["label", "list"]), 1)
        self.assertEqual(len(self.filed()), 2)

    def test_refused_create_records_ghs_stderr_in_the_decision_and_the_overdue_alarm(self):
        # The listing fails, so the owner's labels go out unchanged and GitHub
        # refuses the create -- the #2126 shape. Its stderr is the only why.
        self.gh(labels=["smoke-finding", "severity:p3"])
        (self.state / "faults.json").write_text(json.dumps({"gh:label-list": ["fail-before"]}))
        self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-1"), "intent")
        self.assertEqual(self.filed(), [])
        err = self.c.decisions[-1]["error"]
        self.assertIn("issue create rc=1", err)
        self.assertIn("could not add label: 'P3' not found", err)
        ob = self.c.obligations()[ctl.obligation_key(RUN, "gh", "issue:CF-1")]
        self.assertEqual(ob["detail"]["error"], err)
        self.c.now += dt.timedelta(seconds=ctl.RECEIPT_SLA_SECONDS + 60)
        self.c._alarm_overdue(RUN, "synthesis")
        [(trigger, detail)] = self.c.alarms
        self.assertEqual(trigger, "controller_obligation_overdue")
        self.assertEqual(detail["error"], err)

    def test_a_repo_without_smoke_finding_still_gets_its_issue(self):
        self.gh(labels=["severity:p3"])
        self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-1"), "done")
        [issue] = self.filed()
        self.assertEqual(issue["labels"], ["severity:p3"])
        self.assertIn("`smoke-finding`", issue["body"])

    def test_a_repo_without_smoke_finding_dedups_across_runs_unlabelled(self):
        # An earlier campaign filed this finding unlabelled; the marker cannot
        # see it (its key carries that run's id), so title dedup must.
        prior = {"number": 5, "title": "Upload preview missing", "body": "earlier run", "state": "open",
                 "labels": [], "html_url": "https://github.test/issues/5"}
        self.gh(labels=["severity:p3"], issues=[prior])
        self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-1"), "done")
        self.assertEqual(len(self.filed()), 1)
        ob = self.c.obligations()[ctl.obligation_key(RUN, "gh", "issue:CF-1")]
        self.assertEqual((ob["detail"]["via"], ob["detail"]["duplicateOf"]), ("dedup", 5))

    def test_a_repo_with_smoke_finding_keeps_dedup_scoped_to_it(self):
        prior = {"number": 5, "title": "Upload preview missing", "body": "a human's issue", "state": "open",
                 "labels": [], "html_url": "https://github.test/issues/5"}
        self.gh(labels=["smoke-finding", "severity:p3"], issues=[prior])
        self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-1"), "done")
        self.assertEqual(len(self.filed()), 2)

    def test_a_title_match_is_named_in_the_decision_and_the_pr_run_record(self):
        prior = {"number": 5, "title": "Upload preview missing", "body": "a human's issue", "state": "open",
                 "labels": [], "html_url": "https://github.test/issues/5"}
        self.gh(labels=["severity:p3"], issues=[prior])
        self.c.github(RUN, "synthesis", "issue:CF-1")
        self.assertEqual(self.c.decisions[-1]["duplicateOf"], 5)
        self.assertEqual(self.c.github(RUN, "synthesis", "pr-comment", hint={"verdict": "GO"}), "done")
        [comment] = json.loads((self.state / "gh.json").read_text())["comments"]["7"]
        self.assertIn("Finding CF-1: matched open issue #5 by title, not filed again", comment["body"])

    def test_no_match_leaves_the_run_record_as_it_was(self):
        self.gh(labels=["smoke-finding", "severity:p3"])
        self.c.github(RUN, "synthesis", "issue:CF-1")
        self.c.github(RUN, "synthesis", "pr-comment", hint={"verdict": "GO"})
        [comment] = json.loads((self.state / "gh.json").read_text())["comments"]["7"]
        self.assertNotIn("matched open issue", comment["body"])

    def noise(self, n):
        return [{"number": 1000 + k, "title": "Other finding {}".format(k), "body": "", "state": "open",
                 "labels": ["smoke-finding"], "html_url": "https://github.test/issues/{}".format(1000 + k)}
                for k in range(n)]

    def test_dedup_lists_every_open_issue_without_search(self):
        # A match far past any page size is found: one complete listing, no
        # --label, no --search (both route gh through the search index).
        match = {"number": 5, "title": "Upload preview missing", "body": "", "state": "open",
                 "labels": ["smoke-finding"], "html_url": "https://github.test/issues/5"}
        self.gh(labels=["smoke-finding", "severity:p3"], issues=self.noise(1500) + [match])
        self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-1"), "done")
        self.assertEqual(self.c.decisions[-1]["duplicateOf"], 5)
        with open(os.environ["FAKE_LOG"]) as fh:
            [argv] = [json.loads(line)["argv"] for line in fh if '"issue", "list"' in line]
        self.assertNotIn("--label", argv)
        self.assertNotIn("--search", argv)
        self.assertEqual(argv[argv.index("--limit") + 1], str(ctl.ISSUE_DEDUP_LIMIT))

    def test_a_listing_at_its_cap_never_files(self):
        self.gh(labels=["smoke-finding", "severity:p3"], issues=self.noise(ctl.ISSUE_DEDUP_LIMIT))
        self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-1"), "intent")
        self.assertEqual(len(self.filed()), ctl.ISSUE_DEDUP_LIMIT)
        self.assertIn("cap; not filing", self.c.decisions[-1]["error"])

    def test_a_non_ascii_title_dedups_by_normalized_equality(self):
        run = Path(self.c.args.run_root) / RUN / "controller" / "issues"
        (run / "CF-1.json").write_text(json.dumps({"title": "Aperçu du téléversement absent", "labels": []}))
        match = {"number": 5, "title": "Aperçu du téléversement absent", "body": "", "state": "open",
                 "labels": ["smoke-finding"], "html_url": "https://github.test/issues/5"}
        self.gh(labels=["smoke-finding", "severity:p3"], issues=[match])
        self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-1"), "done")
        self.assertEqual(self.c.decisions[-1]["duplicateOf"], 5)

    def issue_lists(self):
        with open(os.environ["FAKE_LOG"]) as fh:
            return sum(1 for line in fh if json.loads(line)["argv"][:2] == ["issue", "list"])

    def spec(self, fid, title):
        (Path(self.c.args.run_root) / RUN / "controller" / "issues" / "{}.json".format(fid)).write_text(
            json.dumps({"title": title, "labels": ["P3"]}))

    def test_the_dedup_listing_runs_once_per_fire(self):
        self.gh(labels=["smoke-finding", "severity:p3"])
        self.spec("CF-2", "Second finding")
        self.c.github(RUN, "synthesis", "issue:CF-1")
        self.c.github(RUN, "synthesis", "issue:CF-2")
        self.assertEqual(self.issue_lists(), 1)
        self.assertEqual(len(self.filed()), 2)

    def test_the_cached_listing_learns_an_issue_this_fire_filed(self):
        # Two findings with one title in one fire: the second must dedup
        # against the first, exactly as a fresh listing would have let it.
        self.gh(labels=["smoke-finding", "severity:p3"])
        self.spec("CF-2", "Upload preview missing")
        self.c.github(RUN, "synthesis", "issue:CF-1")
        self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-2"), "done")
        [issue] = self.filed()
        self.assertEqual(self.c.decisions[-1]["duplicateOf"], issue["number"])

    def test_an_unconfirmed_create_makes_the_next_obligation_relist(self):
        self.gh(labels=["smoke-finding", "severity:p3"])
        (self.state / "faults.json").write_text(json.dumps({"gh:issue-create": ["fail-before"]}))
        self.spec("CF-2", "Second finding")
        self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-1"), "intent")
        self.c.github(RUN, "synthesis", "issue:CF-2")
        self.assertEqual(self.issue_lists(), 2)

    def calls(self, prefix):
        with open(os.environ["FAKE_LOG"]) as fh:
            return [c for c in (json.loads(line) for line in fh) if c["argv"][:len(prefix)] == prefix]

    def test_a_create_the_listings_lag_is_confirmed_by_its_own_url_in_the_same_fire(self):
        # Every listing lacks the fresh creates, so only the direct read of the
        # URL create printed can settle them in this fire.
        self.gh(labels=["smoke-finding", "severity:p3"], listLag=True)
        self.spec("CF-2", "Second finding")
        self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-1"), "done")
        self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-2"), "done")
        self.assertEqual(len(self.filed()), 2)
        self.assertEqual(self.issue_lists(), 1)
        first = self.filed()[0]
        ob = self.c.obligations()[ctl.obligation_key(RUN, "gh", "issue:CF-1")]
        self.assertEqual((ob["detail"]["via"], ob["detail"]["url"]), ("write", first["html_url"]))
        self.assertIn(["api", "repos/acme/widget/issues/{}".format(first["number"])],
                      [c["argv"][:2] for c in self.calls(["api"])])

    def test_no_printed_url_falls_back_to_the_listing_and_never_reads_as_not_created(self):
        # Create lands but prints nothing, and the listing lags: unknown, not
        # "not created" -- and the next fire finds it by its marker, no refile.
        self.gh(labels=["smoke-finding", "severity:p3"], listLag=True)
        (self.state / "faults.json").write_text(json.dumps({"gh:issue-create": ["silent"]}))
        self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-1"), "intent")
        self.assertEqual(self.c.decisions[-1]["error"], "issue not found on read-back")
        db = json.loads((self.state / "gh.json").read_text())
        db["issues"][0].pop("unlisted")
        (self.state / "gh.json").write_text(json.dumps(db))
        self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-1"), "done")
        self.assertEqual(len(self.filed()), 1)
        ob = self.c.obligations()[ctl.obligation_key(RUN, "gh", "issue:CF-1")]
        self.assertEqual(ob["detail"]["via"], "search")

    def test_a_failed_get_falls_back_to_the_listing_scan(self):
        # The pre-create marker scan passes; the GET of the printed URL fails;
        # the listing scan (no lag here) still confirms the create.
        self.gh(labels=["smoke-finding", "severity:p3"])
        (self.state / "faults.json").write_text(json.dumps({"gh:api": ["pass", "fail-before"]}))
        self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-1"), "done")
        self.assertEqual(len(self.filed()), 1)
        self.assertEqual(len(self.calls(["api"])), 3)

    def test_a_printed_url_whose_issue_lacks_our_marker_is_not_ours(self):
        other = {"number": 100, "title": "someone else's", "body": "no marker", "state": "open",
                 "labels": [], "html_url": "https://github.test/issues/100"}
        self.gh(labels=["smoke-finding", "severity:p3"])
        wrote = (0, "https://github.test/issues/100\n", "")
        (self.state / "gh.json").write_text(json.dumps({"comments": {}, "issues": [other], "prs": {}}))
        self.assertIsNone(self.fx._created_issue("acme/widget", wrote, "<!-- smoke-ctl:abc -->"))
        self.assertIsNone(self.fx._created_issue("acme/widget", (0, "created\n", ""), "<!-- smoke-ctl:abc -->"))
        self.assertIsNone(self.fx._created_issue("acme/widget", (None, "", "timed out"), "<!-- smoke-ctl:abc -->"))

    def test_a_label_listing_that_is_not_a_list_or_is_at_its_cap_is_unknown(self):
        self.gh(labelListRaw='{"message": "Not Found"}')
        self.assertIsNone(self.fx._labels_of("acme/widget"))
        self.fx._repo_labels = {}
        self.gh(labels=["label-{}".format(k) for k in range(1000)])
        self.assertIsNone(self.fx._labels_of("acme/widget"))
        self.fx._repo_labels = {}
        self.gh(labels=["label-{}".format(k) for k in range(999)])
        self.assertEqual(len(self.fx._labels_of("acme/widget")), 999)

    def test_a_recovered_listing_still_puts_the_dropped_note_in_the_filed_body(self):
        # Fire 1: the listing fails, the owner's labels go out unchanged, the
        # create is refused -- and its body payload is already on disk.
        self.gh(labels=["smoke-finding", "severity:p3"])
        (self.state / "faults.json").write_text(json.dumps({"gh:label-list": ["fail-before"]}))
        self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-1"), "intent")
        # Fire 2 (a fresh EffectLayer, as every fire is its own process): the
        # listing recovers, `nope` is dropped, and the note reaches the issue.
        self.fx._repo_labels = {}
        self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-1"), "done")
        [issue] = self.filed()
        self.assertEqual(issue["labels"], ["smoke-finding", "severity:p3"])
        self.assertIn("dropped: `nope`", issue["body"])

    # -- a finding that already names its tracker ------------------------------

    def synth(self, *findings):
        (Path(self.c.args.run_root) / RUN / "synthesis.json").write_text(json.dumps({"findings": list(findings)}))

    def tracker(self, number, state="open"):
        return {"number": number, "title": "Tracked defect {}".format(number), "body": "the tracker", "state": state,
                "labels": ["bug"], "html_url": "https://github.test/issues/{}".format(number)}

    def comments(self, number):
        return json.loads((self.state / "gh.json").read_text())["comments"].get(str(number), [])

    def test_a_named_tracker_gets_one_comment_read_back_by_marker_and_no_new_issue(self):
        self.gh(labels=["smoke-finding", "severity:p3"],
                issues=[self.tracker(3191), self.tracker(3192), self.tracker(3193), self.tracker(3194)])
        self.synth({"id": "CF-1", "severity": "P3", "blocking": False, "confirmed": True, "existingIssue": 3191},
                   {"id": "CF-2", "confirmed": True, "existingIssue": "#3192"},
                   {"id": "CF-3", "confirmed": True, "issue": "https://github.com/acme/widget/issues/3193"})
        self.spec("CF-4", "Fourth finding")
        doc = json.loads((Path(self.c.args.run_root) / RUN / "controller" / "issues" / "CF-4.json").read_text())
        (Path(self.c.args.run_root) / RUN / "controller" / "issues" / "CF-4.json").write_text(
            json.dumps(dict(doc, issue="#3194")))
        for fid, number in (("CF-1", 3191), ("CF-2", 3192), ("CF-3", 3193), ("CF-4", 3194)):
            self.assertEqual(self.c.github(RUN, "synthesis", "issue:" + fid), "done")
            [comment] = self.comments(number)
            marker = "<!-- smoke-ctl:{} -->".format(ctl.obligation_key(RUN, "gh", "issue:" + fid))
            self.assertIn(marker, comment["body"])
            ob = self.c.obligations()[ctl.obligation_key(RUN, "gh", "issue:" + fid)]
            self.assertEqual((ob["detail"]["via"], ob["detail"]["duplicateOf"], ob["detail"]["url"]),
                             ("tracker-comment", number, comment["html_url"]))
            self.assertEqual(self.c.decisions[-1]["duplicateOf"], number)
        [first] = self.comments(3191)
        line = first["body"].splitlines()[1]
        for part in (RUN, "a" * 40, "`CF-1`", "severity `P3`", "blocking `false`", "PR #7"):
            self.assertIn(part, line)
        self.assertEqual(self.calls(["issue", "create"]), [])
        self.assertEqual(len(self.filed()), 4)

    def test_a_replay_finds_its_marker_and_posts_no_second_comment(self):
        # The comment lands but its read-back fails: unknown, and the next
        # attempt finds the marker instead of commenting again.
        self.gh(labels=["smoke-finding"], issues=[self.tracker(3191)])
        self.synth({"id": "CF-1", "confirmed": True, "existingIssue": 3191})
        # Calls: issue marker scan, tracker GET, comment scan, (comment), read-back.
        (self.state / "faults.json").write_text(json.dumps({"gh:api": ["pass", "pass", "pass", "fail-before"]}))
        self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-1"), "intent")
        self.assertEqual(len(self.comments(3191)), 1)
        self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-1"), "done")
        self.assertEqual(len(self.comments(3191)), 1)
        self.assertEqual(len(self.calls(["issue", "comment"])), 1)
        ob = self.c.obligations()[ctl.obligation_key(RUN, "gh", "issue:CF-1")]
        self.assertEqual((ob["detail"]["via"], ob["detail"]["duplicateOf"]), ("tracker-comment", 3191))

    def test_a_closed_tracker_gets_the_comment_and_is_never_reopened_or_edited(self):
        self.gh(labels=["smoke-finding"], issues=[self.tracker(3191, state="closed")])
        self.synth({"id": "CF-1", "confirmed": True, "existingIssue": 3191})
        self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-1"), "done")
        self.assertEqual(len(self.comments(3191)), 1)
        [issue] = self.filed()
        self.assertEqual((issue["state"], issue["labels"], issue["body"], issue["title"]),
                         ("closed", ["bug"], "the tracker", "Tracked defect 3191"))
        with open(os.environ["FAKE_LOG"]) as fh:
            ops = [json.loads(line)["argv"][:2] for line in fh]
        self.assertEqual([x for x in ops if x[0] != "api"], [["issue", "comment"]])

    def test_a_malformed_or_foreign_reference_takes_the_create_path(self):
        refs = [("existingIssue", "WIDGET#3191"), ("existingIssue", "3191"), ("existingIssue", 0),
                ("existingIssue", True), ("existingIssue", "https://github.com/acme/widget/issues/3191"),
                ("issue", "https://github.com/other/repo/issues/3191"), ("issue", 3191),
                ("issue", "https://github.com/acme/widget/pull/3191"), ("issue", "#3191 ")]
        self.gh(labels=["smoke-finding"], issues=[self.tracker(3191)])
        self.synth(*[{"id": "R-{}".format(k), "confirmed": True, field: value} for k, (field, value) in enumerate(refs)])
        for k in range(len(refs)):
            self.spec("R-{}".format(k), "Finding number {}".format(k))
            self.assertEqual(self.c.github(RUN, "synthesis", "issue:R-{}".format(k)), "done", refs[k])
            ob = self.c.obligations()[ctl.obligation_key(RUN, "gh", "issue:R-{}".format(k))]
            self.assertEqual(ob["detail"]["via"], "write", refs[k])
        self.assertEqual(self.comments(3191), [])
        self.assertEqual(len(self.calls(["issue", "create"])), len(refs))

    def test_no_reference_files_as_before_and_reads_no_tracker(self):
        self.gh(labels=["smoke-finding"], issues=[self.tracker(3191)])
        self.synth({"id": "CF-1", "confirmed": True, "severity": "P3"})
        self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-1"), "done")
        self.assertEqual(len(self.calls(["issue", "create"])), 1)
        self.assertEqual(self.calls(["issue", "comment"]), [])
        self.assertEqual([c for c in self.calls(["api"]) if "/comments" in c["argv"][1]], [])

    def test_a_tracker_comment_is_named_in_the_pr_run_record(self):
        self.gh(labels=["smoke-finding"], issues=[self.tracker(3191)])
        self.synth({"id": "CF-1", "confirmed": True, "existingIssue": 3191})
        self.c.github(RUN, "synthesis", "issue:CF-1")
        self.assertEqual(self.c.github(RUN, "synthesis", "pr-comment", hint={"verdict": "GO"}), "done")
        [comment] = self.comments(7)
        self.assertIn("Finding CF-1: already tracked as #3191; re-observation commented there, not filed again",
                      comment["body"])

    def test_a_pull_request_number_is_never_a_tracker_and_files_as_before(self):
        pr = dict(self.tracker(3191), pull_request={"url": "https://api.github.test/repos/acme/widget/pulls/3191"})
        self.gh(labels=["smoke-finding"], issues=[pr])
        self.synth({"id": "CF-1", "confirmed": True, "existingIssue": 3191})
        self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-1"), "done")
        self.assertEqual(self.comments(3191), [])
        self.assertEqual(self.calls(["issue", "comment"]), [])
        self.assertEqual(len(self.calls(["issue", "create"])), 1)
        ob = self.c.obligations()[ctl.obligation_key(RUN, "gh", "issue:CF-1")]
        self.assertEqual(ob["detail"]["via"], "write")
        self.assertIn("pull request", ob["detail"]["trackerRejected"])
        self.assertIn("pull request", self.c.decisions[-1]["trackerRejected"])

    def test_a_tracker_that_resolves_to_another_repo_is_rejected(self):
        foreign = dict(self.tracker(3191), repository_url="https://api.github.com/repos/other/repo")
        self.gh(labels=["smoke-finding"], issues=[foreign])
        self.synth({"id": "CF-1", "confirmed": True, "existingIssue": 3191})
        self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-1"), "done")
        ob = self.c.obligations()[ctl.obligation_key(RUN, "gh", "issue:CF-1")]
        self.assertEqual(ob["detail"]["via"], "write")
        self.assertIn("other/repo", ob["detail"]["trackerRejected"])
        self.assertEqual(self.comments(3191), [])

    def test_a_tracker_that_does_not_exist_is_rejected_but_a_failed_read_is_retried(self):
        self.gh(labels=["smoke-finding"], issues=[])
        self.synth({"id": "CF-1", "confirmed": True, "existingIssue": 3191})
        (self.state / "faults.json").write_text(json.dumps({"gh:api": ["pass", "fail-before"]}))
        self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-1"), "intent")
        self.assertEqual(self.calls(["issue", "create"]), [])
        self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-1"), "done")
        ob = self.c.obligations()[ctl.obligation_key(RUN, "gh", "issue:CF-1")]
        self.assertEqual(ob["detail"]["via"], "write")
        self.assertIn("not found", ob["detail"]["trackerRejected"])
        self.assertEqual(len(self.calls(["issue", "create"])), 1)
        self.assertEqual(self.comments(3191), [])

    def test_a_chosen_tracker_deleted_before_its_comment_lands_fails_to_terminal_not_forever(self):
        self.gh(labels=["smoke-finding"], issues=[self.tracker(3191)])
        self.synth({"id": "CF-1", "confirmed": True, "existingIssue": 3191})
        (self.state / "faults.json").write_text(json.dumps({"gh:issue-comment": ["fail-before"]}))
        self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-1"), "intent")
        db = json.loads((self.state / "gh.json").read_text())
        db["issues"], db["deleted"] = [], [3191]
        (self.state / "gh.json").write_text(json.dumps(db))
        states = [self.c.github(RUN, "synthesis", "issue:CF-1") for _ in range(ctl.MAX_EFFECT_FAILURES)]
        self.assertEqual(states[-1], "failed_terminal", states)
        ob = self.c.obligations()[ctl.obligation_key(RUN, "gh", "issue:CF-1")]
        self.assertIn("not found or deleted", ob["detail"]["error"])
        self.assertEqual(self.calls(["issue", "create"]), [])

    def test_the_destination_is_journaled_before_the_write_and_replays_unchanged(self):
        # The comment lands, its read-back fails; the owner then re-points the
        # finding, or drops the reference. The replay still reconciles only
        # the tracker chosen before the write: no second post, no new issue.
        for change in ({"existingIssue": 3192}, {}):
            with self.subTest(change=change):
                self.tearDown()
                self.setUp()
                self.gh(labels=["smoke-finding"], issues=[self.tracker(3191), self.tracker(3192)])
                self.synth({"id": "CF-1", "confirmed": True, "existingIssue": 3191})
                (self.state / "faults.json").write_text(json.dumps({"gh:api": ["pass", "pass", "pass", "fail-before"]}))
                self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-1"), "intent")
                ob = self.c.obligations()[ctl.obligation_key(RUN, "gh", "issue:CF-1")]
                dest = [h["detail"]["destination"] for h in ob["history"] if "destination" in (h.get("detail") or {})]
                self.assertEqual(dest, [{"action": "tracker-comment", "repo": "acme/widget", "number": 3191}])
                self.assertLess(next(i for i, h in enumerate(ob["history"]) if "destination" in (h.get("detail") or {})),
                                next(i for i, h in enumerate(ob["history"]) if (h.get("detail") or {}).get("outcome")))
                self.synth(dict({"id": "CF-1", "confirmed": True}, **change))
                self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-1"), "done")
                self.assertEqual((len(self.comments(3191)), len(self.comments(3192))), (1, 0))
                self.assertEqual(self.calls(["issue", "create"]), [])
                ob = self.c.obligations()[ctl.obligation_key(RUN, "gh", "issue:CF-1")]
                self.assertEqual((ob["detail"]["via"], ob["detail"]["duplicateOf"]), ("tracker-comment", 3191))

    # -- a finding with no tracker and no issue file is held, never wrapped ----

    def no_issue_file(self, fid="CF-1"):
        (Path(self.c.args.run_root) / RUN / "controller" / "issues" / "{}.json".format(fid)).unlink()

    def test_a_tracker_named_only_in_prose_files_nothing_and_alarms_until_the_field_is_set(self):
        self.gh(labels=["smoke-finding"], issues=[self.tracker(3191)])
        self.no_issue_file()
        self.synth({"id": "CF-1", "confirmed": True, "disposition": "not-blocking:already tracked as #3191"})
        self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-1"), "held")
        self.assertEqual(self.calls(["issue", "create"]), [])
        self.assertEqual(self.comments(3191), [])
        self.assertEqual(len(self.filed()), 1)
        ob = self.c.obligations()[ctl.obligation_key(RUN, "gh", "issue:CF-1")]
        self.assertEqual((ob["state"], ob["detail"]["outcome"]), ("failed", "held"))
        self.assertIn("finding CF-1 not filed", ob["detail"]["error"])
        self.assertNotIn("destination", ob["detail"])
        self.assertEqual([t for t, _ in self.c.alarms], ["controller_finding_unrouted"])
        # Re-read on the next attempt: the field the owner adds routes it.
        self.synth({"id": "CF-1", "confirmed": True, "disposition": "not-blocking:already tracked as #3191",
                    "existingIssue": 3191})
        self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-1"), "done")
        ob = self.c.obligations()[ctl.obligation_key(RUN, "gh", "issue:CF-1")]
        self.assertEqual((ob["detail"]["via"], ob["detail"]["duplicateOf"]), ("tracker-comment", 3191))
        self.assertEqual(len(self.comments(3191)), 1)
        self.assertEqual(self.calls(["issue", "create"]), [])

    def test_a_rejected_tracker_with_no_issue_file_is_held_not_wrapped(self):
        pr = dict(self.tracker(3191), pull_request={"url": "https://api.github.test/repos/acme/widget/pulls/3191"})
        self.gh(labels=["smoke-finding"], issues=[pr])
        self.no_issue_file()
        self.synth({"id": "CF-1", "confirmed": True, "existingIssue": 3191})
        self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-1"), "held")
        self.assertEqual(self.calls(["issue", "create"]), [])
        ob = self.c.obligations()[ctl.obligation_key(RUN, "gh", "issue:CF-1")]
        self.assertIn("pull request", ob["detail"]["error"])
        self.assertNotIn("destination", ob["detail"])

    def test_a_journaled_create_whose_issue_file_is_gone_is_held_not_wrapped(self):
        self.gh(labels=["smoke-finding", "severity:p3"])
        (self.state / "faults.json").write_text(json.dumps({"gh:label-list": ["fail-before"]}))
        self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-1"), "intent")
        self.no_issue_file()
        self.fx._repo_labels = {}
        self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-1"), "held")
        self.assertEqual(self.filed(), [])
        self.assertEqual(len(self.calls(["issue", "create"])), 1, "only the refused create ran")

    def pre_finish_stubbed(self):
        c = self.c
        c.driven, finished = set(), []
        c._settle_alarm_sends = lambda run: None
        c._run_dir_expected = lambda run: False
        c._publish_verb = lambda run, view, verb: verb
        c._terminal_call = lambda run, phase, verb, sha, verdict: finished.append(verdict) or "done"
        c.post_finish = lambda run, pr, verdict, external: verdict
        c.send = lambda *a, **kw: "delivered"
        return finished

    def test_held_issues_hold_the_verdict_then_end_terminal_past_the_owner_sla_and_are_not_reread(self):
        self.gh(labels=["smoke-finding"])
        self.no_issue_file()
        c, finished = self.c, self.pre_finish_stubbed()
        doc = {"findings": [{"id": fid, "confirmed": True} for fid in ("CF-1", "CF-2", "CF-3")]}
        self.assertEqual(c.pre_finish(RUN, 7, "NO_GO", [], doc), "verdict")
        self.assertEqual(finished, [])
        c.now += dt.timedelta(seconds=ctl.OWNER_STEP_SLA_SECONDS + 60)
        c.pre_finish(RUN, 7, "NO_GO", [], doc)
        self.assertEqual(finished, ["BLOCKED"])
        [fin] = [d for d in c.decisions if d["type"] == "finish"]
        for fid in ("CF-1", "CF-2", "CF-3"):
            self.assertIn("obligation gh:issue:{} is failed_terminal".format(fid), fin["failedChecks"])
            ob = c.obligations()[ctl.obligation_key(RUN, "gh", "issue:" + fid)]
            self.assertEqual(ob["state"], "failed_terminal")
            self.assertIn("held unfiled", ob["detail"]["reason"])
        reads = len(self.calls(["api"]))
        c.pre_finish(RUN, 7, "NO_GO", [], doc)
        self.assertEqual(len(self.calls(["api"])), reads, "a terminal hold is never read again")
        self.assertEqual(self.calls(["issue", "create"]), [])

    def test_a_held_issue_counts_its_hold_from_the_synthesis_refusal(self):
        self.gh(labels=["smoke-finding"])
        self.no_issue_file()
        c, finished = self.c, self.pre_finish_stubbed()
        since = c.now - dt.timedelta(seconds=ctl.OWNER_STEP_SLA_SECONDS + 60)
        c.record(RUN, "run", "claim", "claimed", detail={"unroutedSince": ctl.iso(since)})
        c.pre_finish(RUN, 7, "NO_GO", [], {"findings": [{"id": "CF-1", "confirmed": True}]})
        self.assertEqual(finished, ["BLOCKED"], "no second SLA after the refusal expired")
        self.assertEqual(self.calls(["issue", "create"]), [])

    def test_unrouted_findings_names_each_filed_finding_with_neither_a_tracker_nor_a_titled_issue_file(self):
        run_dir = Path(self.c.args.run_root) / RUN
        self.no_issue_file()
        self.spec("CF-3", "Third finding")
        (run_dir / "controller" / "issues" / "CF-5.json").write_text(json.dumps({"existingIssue": "#3195"}))
        (run_dir / "controller" / "issues" / "CF-6.json").write_text(json.dumps({"title": "  ", "body": "x"}))
        doc = {"findings": [{"id": "CF-1", "confirmed": True, "existingIssue": 3191},
                            {"id": "CF-2", "confirmed": True, "disposition": "not-blocking:tracked as #3192"},
                            {"id": "CF-3", "confirmed": True},
                            {"id": "CF-4", "blocking": True},
                            {"id": "CF-5", "confirmed": True},
                            {"id": "CF-6", "confirmed": True},
                            {"id": "CF-7", "confirmed": True, "issue": "https://github.com/acme/widget/issues/3197"}]}
        view = SimpleNamespace(dir=str(run_dir), markers=lambda: {
            "B1": {"doc": {"confirmedFindings": ["M-1", "CF-1"]}}, "A1": {"doc": None}})
        reasons = ctl.unrouted_findings(view, doc, "acme/widget")
        self.assertEqual([r.split(":")[0] for r in reasons], ["finding CF-2", "finding CF-6", "finding M-1"])
        self.assertIn('"existingIssue": <N>', reasons[0])
        # No repo known: an issue URL cannot be checked, so it routes nothing.
        self.assertIn("finding CF-7", " ".join(ctl.unrouted_findings(view, doc, None)))
        # A synthesis of the wrong shape has no findings of its own; the
        # markers' still count.
        for bad in ("bad", [{}], {"findings": 5}, {"findings": {"id": "CF-2"}}, None):
            self.assertEqual([r.split(":")[0] for r in ctl.unrouted_findings(view, bad, "acme/widget")],
                             ["finding M-1", "finding CF-1"], bad)

    def test_a_malformed_synthesis_still_publishes_its_pr_run_record(self):
        # No prose record, so the comment is rendered from synthesis.json.
        for findings, line in ((5, "- synthesis findings is not a list"),
                               ([{"id": ["F1"]}, {"id": "F2", "disposition": "open"}], "- finding entry 0 has no string id")):
            with self.subTest(findings=findings):
                self.tearDown()
                self.setUp()
                self.gh(labels=["smoke-finding"])
                run = Path(self.c.args.run_root) / RUN
                (run / "synthesis.json").write_text(json.dumps({"verdict": "GO", "findings": findings}))
                hint = {"verdict": "BLOCKED", "failedChecks": ["synthesis findings is not a list"]}
                self.assertEqual(self.c.github(RUN, "verdict", "pr-comment", hint=hint), "done")
                [comment] = self.comments(7)
                self.assertIn(line, comment["body"])

    def test_only_spawns_non_start_signal_defers_a_read(self):
        # A read that RAN and failed with the very words spawn() uses for a
        # refused start is unknown; only a call spawn() never started defers.
        self.gh(labels=["smoke-finding"])
        (self.state / "faults.json").write_text(json.dumps({"gh:api": ["fail-sentinel"]}))
        self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-1"), "intent")
        ob = self.c.obligations()[ctl.obligation_key(RUN, "gh", "issue:CF-1")]
        self.assertEqual(ob["detail"]["outcome"], "unknown")
        self.assertEqual(self.calls(["api"])[0]["result"], 1)
        self.fx.cfg["deadline"] = 1
        self.assertEqual(self.c.github(RUN, "synthesis", "pr-comment", hint={"verdict": "GO"}), "intent")
        ob = self.c.obligations()[ctl.obligation_key(RUN, "gh", "pr-comment")]
        self.assertEqual(ob["detail"]["outcome"], "deferred")
        self.assertEqual(len(self.calls(["api"])), 1, "the deferred read never ran")

    def test_the_publication_hint_follows_the_verdict_even_when_the_failed_set_does_not_change(self):
        c = self.c
        c.ensure_alarm = lambda *a, **kw: True
        c.record(RUN, "verdict", "validated", "done", 1, {"verdict": "GO", "failedChecks": []})
        unpublished = [{"obligation": "send:verdict", "state": "failed_terminal", "reason": "3 failures"}]
        c._record_unpublished(RUN, "verdict", "GO", [], unpublished)
        c._record_unpublished(RUN, "verdict", "BLOCKED", ["head moved"], unpublished)
        vob = c.obligations()[ctl.obligation_key(RUN, "verdict", "validated")]
        self.assertEqual(vob["detail"]["publicationHint"], {"verdict": "BLOCKED", "failedChecks": ["head moved"]})

    # -- every PR comment carries the verdict the run finishes with ------------

    def finish_blocked(self):
        """pre_finish with a BLOCKED verdict (the frozen GO fell), its real
        GitHub path against the fake and every other effect stubbed."""
        c = self.c
        c.driven, finished = set(), []
        c._settle_alarm_sends = lambda run: None
        c._run_dir_expected = lambda run: False
        c._publish_verb = lambda run, view, verb: verb
        c._terminal_call = lambda run, phase, verb, sha, verdict: finished.append(verdict) or "done"
        c.post_finish = lambda run, pr, verdict, external: verdict
        c.send = lambda *a, **kw: "delivered"
        c.ensure_alarm = lambda run_id, trigger, fp, detail, **kw: c.alarms.append((trigger, detail)) or True
        c.pre_finish(RUN, 7, "BLOCKED", ["head moved"], {})
        return finished

    def pre_install_pr_comment(self):
        """What a controller from before this install leaves: a pr-comment
        intent with no journaled verdict, and its write-once GO payload."""
        key = ctl.obligation_key(RUN, "gh", "pr-comment")
        self.c.record(RUN, "gh", "pr-comment", "intent", 1)
        payload = Path(self.c.journal.dir) / "payloads" / RUN / (key[:16] + "-pr-comment.md")
        payload.parent.mkdir(parents=True, exist_ok=True)
        payload.write_text("<!-- smoke-ctl:{} -->\n# Smoke run record\n\nRun on build: **Safe to ship**.\n".format(key))
        return key

    def test_a_pre_install_pr_comment_that_never_landed_is_rendered_afresh_from_the_finished_verdict(self):
        self.gh(labels=["smoke-finding"])
        self.pre_install_pr_comment()
        self.assertEqual(self.finish_blocked(), ["BLOCKED"])
        [comment] = self.comments(7)
        self.assertIn("Smoke verdict: Could not test honestly", comment["body"])
        self.assertNotIn("Safe to ship", comment["body"])

    def test_a_pre_install_pr_comment_that_may_have_landed_is_superseded_not_reposted(self):
        self.gh(labels=["smoke-finding"])
        key = self.pre_install_pr_comment()
        db = json.loads((self.state / "gh.json").read_text())
        db["comments"]["7"] = [{"id": 1, "body": "<!-- smoke-ctl:{} -->\nSafe to ship".format(key),
                                "html_url": "https://github.test/pr/7#c1"}]
        (self.state / "gh.json").write_text(json.dumps(db))
        self.assertEqual(self.finish_blocked(), ["BLOCKED"])
        self.assertEqual(len(self.comments(7)), 1, "the landed comment is never posted again")
        self.assertIn("controller_publication_superseded", [t for t, _ in self.c.alarms])
        vob = self.c.obligations()[ctl.obligation_key(RUN, "verdict", "validated")]
        self.assertIn("gh:pr-comment", [x["obligation"] for x in vob["detail"]["publicationFailed"]])

    def test_the_finished_verdict_heads_the_pr_comment_whatever_the_owner_prose_says(self):
        self.gh(labels=["smoke-finding"])
        (Path(self.c.args.run_root) / RUN / "run-record.md").write_text("# Smoke verdict\nSafe to ship\n")
        self.assertEqual(self.finish_blocked(), ["BLOCKED"])
        [comment] = self.comments(7)
        body = comment["body"]
        self.assertIn("## Smoke verdict: Could not test honestly", body)
        self.assertIn("Not cleared: head moved", body)
        self.assertLess(body.index("Could not test honestly"), body.index("Safe to ship"))
        self.assertLess(body.index("### Owner's run record"), body.index("Safe to ship"))

    def test_the_chat_verdict_never_carries_owner_bullets_for_another_verdict(self):
        # Guard (holds before this change too): the chat post's heading is the
        # hint's verdict, and owner bullets go out only under their own verdict.
        run = Path(self.c.args.run_root) / RUN
        (run / "synthesis.json").write_text(json.dumps({"verdict": "GO", "findings": []}))
        (run / "controller" / "verdict-bullets.md").write_text("- Safe to ship, all lanes passed\n")
        self.fx.cfg["repo"] = "acme/widget"
        text, _ = self.fx._render({"runId": RUN, "slot": "verdict",
                                   "hint": {"verdict": "BLOCKED", "failedChecks": ["head moved"]}})
        self.assertIn("Could not test honestly", text.splitlines()[0])
        self.assertNotIn("Safe to ship", text)

    def test_the_verdict_states_its_data_date(self):
        run = Path(self.c.args.run_root) / RUN
        self.fx.cfg["repo"] = "acme/widget"
        hint = {"runId": RUN, "slot": "verdict", "hint": {"verdict": "GO"}}
        claim = {"sha": "a" * 40}

        self.assertIn("- Data: date not recorded\n", self.fx._render(hint)[0], "lanes can finish with no synthesis")
        self.assertIn("- Data: date not recorded\n", self.fx._run_record(RUN, claim, {"verdict": "GO"}))

        (run / "synthesis.json").write_text(json.dumps({"verdict": "GO", "findings": []}))
        self.assertIn("- Data: date not recorded\n", self.fx._render(hint)[0])

        (run / "synthesis.json").write_text(json.dumps(
            {"verdict": "GO", "findings": [], "dataDate": "Client A sales\n through 11 Sep 2026"}))
        self.assertIn("- Data: Client A sales through 11 Sep 2026\n", self.fx._render(hint)[0])
        self.assertIn("- Data: Client A sales through 11 Sep 2026\n",
                      self.fx._run_record(RUN, claim, {"verdict": "GO"}))

        (run / "synthesis.json").write_text(json.dumps(
            {"verdict": "GO", "findings": [], "dataDate": "alpha " * 50}))
        self.assertIn("- Data: {}…\n".format(" ".join(["alpha"] * 33)), self.fx._render(hint)[0],
                      "an over-long stamp is cut at a word and marked, never mid-word")

        (run / "synthesis.json").write_text(json.dumps(
            {"verdict": "GO", "findings": [], "dataDate": "w" * 100 + " " + "v" * 98 + " u"}))
        self.assertIn("- Data: {} {}…\n".format("w" * 100, "v" * 98), self.fx._render(hint)[0],
                      "a word that fits with the mark is kept")

    def test_the_gh_allowlist_admits_the_comment_calls_and_nothing_broader(self):
        allowed = ctl.EffectLayer._gh_call_allowed
        self.assertTrue(allowed(["issue", "comment", "3191", "-R", "acme/widget", "--body-file", "x"]))
        self.assertTrue(allowed(["api", "repos/acme/widget/issues/3191/comments?per_page=100", "--paginate", "--jq",
                                 ".[]"]))
        self.assertTrue(allowed(["api", "repos/acme/widget/issues/3191"]))
        for rest in (["issue", "reopen", "3191"], ["issue", "edit", "3191", "--add-label", "x"],
                     ["issue", "close", "3191"], ["api", "-X", "PATCH", "repos/acme/widget/issues/3191"],
                     ["api", "repos/acme/widget/issues/3191", "-f", "state=open"],
                     ["api", "repos/acme/widget/issues/3191", "--method", "PATCH"], ["repo", "delete"]):
            self.assertFalse(allowed(rest), rest)
            with self.assertRaises(ctl.ControllerError):
                self.fx._run(self.fx.gh + rest, 5)
        self.assertFalse(os.path.exists(os.environ["FAKE_LOG"]), "a refused gh call never runs")

    def test_a_write_github_refused_fails_to_terminal_not_unknown_forever(self):
        for slot, op, text in (
                ("pr-comment", "gh:pr-comment", "GraphQL: Resource not accessible by integration (addComment)"),
                ("issue:CF-1", "gh:issue-create",
                 "HTTP 403: Resource not accessible by integration (https://api.github.com/graphql)")):
            with self.subTest(slot=slot):
                self.tearDown()
                self.setUp()
                self.gh(labels=["smoke-finding", "severity:p3"])
                (self.state / "faults.json").write_text(json.dumps({op: ["refuse:" + text] * ctl.MAX_EFFECT_FAILURES}))
                states = [self.c.github(RUN, "synthesis", slot, hint={"verdict": "GO"})
                          for _ in range(ctl.MAX_EFFECT_FAILURES)]
                self.assertEqual(states, ["intent"] * (ctl.MAX_EFFECT_FAILURES - 1) + ["failed_terminal"])
                ob = self.c.obligations()[ctl.obligation_key(RUN, "gh", slot)]
                self.assertEqual(ob["detail"]["effectFailures"], ctl.MAX_EFFECT_FAILURES)
                self.assertIn(text, ob["detail"]["error"])
                self.assertEqual([t for t, _ in self.c.alarms], ["controller_gh_failed"])
                db = json.loads((self.state / "gh.json").read_text())
                self.assertEqual((db["issues"], db["comments"]), ([], {}))

    def test_only_a_refusal_github_answered_counts_as_a_failed_write(self):
        for rc, err, refused in (
                (1, "GraphQL: Resource not accessible by integration (addComment)", True),
                (1, "HTTP 403: Resource not accessible by integration (https://api.github.com/graphql)", True),
                (1, "HTTP 422: Validation Failed (https://api.github.com/repos/acme/widget/issues)", False),
                (1, "HTTP 403: You have exceeded a secondary rate limit (https://api.github.com/graphql)", False),
                (1, "HTTP 429: Too Many Requests (https://api.github.com/graphql)", False),
                (1, "HTTP 408 (https://api.github.com/graphql)", False),
                (1, "HTTP 502: Bad Gateway (https://api.github.com/graphql)", False),
                (1, "GraphQL: Something went wrong while executing your query. This may be the result of a timeout",
                 False),
                (1, "could not add label: 'P3' not found", False),
                (None, "timed out after 30s", False),
                (None, ctl.NotStarted("no time left in this fire"), False),
                (0, "", False)):
            with self.subTest(err=err):
                self.assertIs(ctl.gh_refused((rc, "", err)), refused)

    def test_a_write_that_exits_zero_but_is_not_found_keeps_the_read_back_error(self):
        self.assertIsNone(ctl.gh_write_error((0, "", "noise"), "issue create"))
        self.assertEqual(ctl.gh_write_error((None, "", "timed out after 30s"), "pr comment"),
                         "pr comment timed out: timed out after 30s")


if __name__ == "__main__":
    unittest.main()
