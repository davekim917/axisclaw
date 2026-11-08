/**
 * Approved-run lane, end to end at the delivery-action entry and the card's
 * choice resolution: classification → tier → card / execution / refusal, the
 * named-approver authority, sha binding, and exactly-once execution.
 *
 * Real central DB; the delivery adapter is a fake that records what was
 * posted. The target's classifier is a stand-in script under the test's data
 * dir (sha-pinned like a real one) that reports one fact per SQL line, so
 * each case states its own statements.
 */
import { createHash } from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withCentralSync } from '../../db/central-lease.js';
import { closeDb, getDb, initMigratedTestDb } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { createSession, getPendingApprovalsByAction } from '../../db/sessions.js';
import {
  getDeliveryAction,
  reenterGuardedDeliveryAction,
  setDeliveryAdapter,
  type ChannelDeliveryAdapter,
} from '../../delivery.js';
import { writeSessionMessage } from '../../session-manager.js';
import { guard } from '../../guard/index.js';
import { log } from '../../log.js';
import { allowSubprocess, enforceHermeticity } from '../../test-hermeticity.js';
import type { PendingApproval, Session } from '../../types.js';
import { resolveChoice } from '../approvals/choices.js';
import { canAnswerApproval } from '../approvals/response-handler.js';
import { grantRole, revokeRole } from '../permissions/db/user-roles.js';
import { upsertUser } from '../permissions/db/users.js';
import { getHostStartCallbacks } from '../../host-lifecycle.js';
import { agentsHoldingSecret } from '../../onecli-secrets.js';
import { cardQuestion, QUESTION_MAX } from './card.js';
import { classifyFacts, type StatementFact } from './classify.js';
import { renderApiFor, type RenderApi } from './render-api.js';
import { migrationFacts } from './migrate-facts.js';
import { repoReader, type RepoReader } from './migrate-repo.js';
import { requestApprovalOutcome } from '../approvals/primitive.js';
import { docker } from './migrate-sandbox.js';
import { migrateTargetConfig } from '../../test-fixtures/migrate-target.js';
import { maskKey, maskValue } from './render-mask.js';
import { sqlApiFor, type SqlApi } from './sql-api.js';
import { APPROVED_RUN_ACTION, approvedRunExecute } from './guard.js';
import { deliverQueued } from './outbox.js';
import { targetsUsing } from './targets.js';
import { __approvedRunPreparedForTest } from './index.js';

enforceHermeticity();
// The classifier is a separate process by design; the stand-in reads only the temp SQL file (python3 -I).
allowSubprocess(['python3']);

vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    configureManualApproval = vi.fn().mockReturnValue({ stop: vi.fn() });
  },
}));
vi.mock('../../container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../container-runner.js')>()),
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});
vi.mock('../../session-manager.js', async () => {
  const actual = await vi.importActual<typeof import('../../session-manager.js')>('../../session-manager.js');
  return { ...actual, writeSessionMessage: vi.fn() };
});
vi.mock('../approvals/primitive.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../approvals/primitive.js')>();
  return { ...actual, requestApprovalOutcome: vi.fn(actual.requestApprovalOutcome) };
});
const DB_PASSWORD = 'pw';

vi.mock('./sql-api.js', () => ({ sqlApiFor: vi.fn() }));
vi.mock('./render-api.js', () => ({ renderApiFor: vi.fn() }));
vi.mock('./migrate-repo.js', () => ({ repoReader: vi.fn() }));
vi.mock('./migrate-facts.js', () => ({ migrationFacts: vi.fn() }));
vi.mock('./migrate-relay.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./migrate-relay.js')>()),
  openRelay: vi.fn(async (name: string, endpoint: { host: string }) => ({
    network: `${name}-net`,
    addHost: `${endpoint.host}:10.9.0.2`,
    close: async () => undefined,
  })),
}));
vi.mock('./migrate-sandbox.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./migrate-sandbox.js')>()),
  docker: vi.fn(),
  stopLeftoverSandboxes: vi.fn(),
}));
vi.mock('../../onecli-secrets.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../onecli-secrets.js')>()),
  agentsHoldingSecret: vi.fn(),
}));
vi.mock('../../webhook-server.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../webhook-server.js')>()),
  registerWebhookAdapter: vi.fn(),
}));

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('test-approved-run') }));
const RUN_DIR = path.join(TEST_DIR, 'approved-run');

/**
 * One fact per non-blank line, whose text is the line itself:
 * `<kind> [dev] [deny=<reason>] [grantee=<name>] [granted=<role>] [role=<name>] [db=<name>] [drops] [swap]
 * [obj=<name>] [replaces] [actions=<a>,<b>] [sources=<t>,<u>] [cut=<rows>]` (`_` in an action reads as a space; `cut` reports a VALUES
 * list of that many rows cut from the shown text). A line
 * without role= runs as the target's default role, as the real classifier reports it. `swap` rewrites
 * the target's approvers while classification is running, the window a config change can land in. A file holding
 * `!garbage` makes it print something that is not JSON; one holding `!crash` makes it exit non-zero; one starting
 * `!raw ` makes it print the rest of the file as its whole output.
 */
const FAKE_CLASSIFIER = `import json, os, sys
facts = []
if sys.argv[sys.argv.index("--snow-root") + 1] != "/opt/snow-install": sys.exit(5)
default_role = sys.argv[sys.argv.index("--default-role") + 1]
body = open(sys.argv[-1]).read()
if body.startswith("!raw "): sys.stdout.write(body[5:]); sys.exit(0)
if "!garbage" in body: print("not json"); sys.exit(0)
if "!crash" in body: sys.exit(3)
for line in open(sys.argv[-1]).read().splitlines():
    t = line.split()
    if not t: continue
    f = {"text": line, "kind": t[0], "scope": "dev" if "dev" in t else "other", "role": default_role}
    for w in t[1:]:
        if w.startswith("deny="): f["deny"] = w[5:]
        if w.startswith("grantee="): f["grantee"] = w[8:]
        if w.startswith("role="): f["role"] = w[5:]
        if w.startswith("db="): f["database"] = w[3:]
        if w == "drops": f["drops_grants"] = True
        if w.startswith("granted="): f["granted"] = w[8:]; f["grantee_kind"] = "role"
        if w.startswith("obj="): f["object"] = w[4:]
        if w == "replaces": f["replaces"] = True
        if w.startswith("actions="): f["actions"] = [a.replace("_", " ") for a in w[8:].split(",")]; f.setdefault("sources", [])
        if w.startswith("sources="): f["sources"] = w[8:].split(",")
        if w.startswith("cut="): f["display"] = line + " [cut]"; f["collapsed"] = [{"rows": int(w[4:]), "sha256": "a" * 64}]
        if w == "swap":
            tp = os.path.join(os.path.dirname(os.path.dirname(sys.argv[-1])), "targets.json")
            d = json.load(open(tp)); d["targets"][0]["approvers"] = ["slack:U-other"]; json.dump(d, open(tp, "w"))
    facts.append(f)
json.dump({"statements": facts}, sys.stdout)
`;

const EXECUTE = { account: 'acme-xy12345', user: 'APPROVED_RUN_ACME', onecliAgent: 'approved-run-acme' };

const ALICE = 'slack:U-alice';
const BOB = 'slack:U-bob';
const OTHER_ADMIN = 'slack:U-other';

let delivered: Array<{ platformId: string; threadId: string | null; content: string; instance?: string }>;
let failDeliveries = 0;
const fakeAdapter: ChannelDeliveryAdapter = {
  async deliver(_channelType, platformId, threadId, _kind, content, _files, instance) {
    if (failDeliveries > 0) {
      failDeliveries--;
      throw new Error('platform unavailable');
    }
    delivered.push({ platformId, threadId, content, instance });
    return `pm-${delivered.length}`;
  },
};

let session: Session;
let seq = 0;

function now(): string {
  return new Date().toISOString();
}

function writeTargets(overrides: Record<string, unknown> = {}): void {
  const classifierPath = path.join(RUN_DIR, 'fake_classifier.py');
  fs.writeFileSync(classifierPath, FAKE_CLASSIFIER);
  const target = {
    id: 'acme-snowflake',
    label: 'Acme Snowflake',
    kind: 'snowflake',
    agentGroups: ['ag-1'],
    approvers: [ALICE, BOB],
    allowedRoles: ['SECURITYADMIN', 'SYSADMIN'],
    defaultRole: 'ACME_DEPLOY',
    classifier: {
      path: classifierPath,
      sha256: createHash('sha256').update(FAKE_CLASSIFIER).digest('hex'),
      snowRoot: '/opt/snow-install',
    },
    mode: 'execute',
    execute: EXECUTE,
    ...overrides,
  };
  fs.writeFileSync(path.join(RUN_DIR, 'targets.json'), JSON.stringify({ targets: [target] }));
}

async function propose(sql: string, extra: Record<string, unknown> = {}): Promise<string> {
  const requestId = (extra.requestId as string | undefined) ?? `req-${++seq}`;
  const run = getDeliveryAction('request_approved_run');
  expect(run).toBeDefined();
  await run!(
    { action: 'request_approved_run', requestId, target: 'acme-snowflake', sql, reason: 'grant reads', ...extra },
    session,
  );
  await __approvedRunPreparedForTest();
  return requestId;
}

function notes(): string[] {
  return vi.mocked(writeSessionMessage).mock.calls.map((c) => (JSON.parse(c[2].content) as { text: string }).text);
}

async function onlyCard(): Promise<PendingApproval> {
  const rows = await getPendingApprovalsByAction(APPROVED_RUN_ACTION);
  expect(rows).toHaveLength(1);
  return rows[0];
}

async function runsSettled(): Promise<void> {
  const runs = path.join(RUN_DIR, 'runs');
  const outbox = path.join(RUN_DIR, 'outbox');
  const list = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);
  await vi.waitFor(() => {
    expect(list(runs).filter((r) => !fs.existsSync(path.join(runs, r, 'finished.json')))).toEqual([]);
    expect(list(outbox).filter((n) => n.endsWith('.json'))).toEqual([]);
  });
}

/** Plain-text posts to the thread (the card itself and its edits are excluded). */
function posts(): string[] {
  return delivered
    .map((d) => JSON.parse(d.content) as { text?: string; operation?: string })
    .flatMap((c) => (c.text && c.operation !== 'edit' ? [c.text] : []));
}

let sent: string[];
let sentContext: Array<Record<string, unknown>>;
let identityStall: Promise<void> | null;
let statementStall: Promise<void> | null;

/** Snowflake as seen through the gateway: the identity check passes, and `fails` gets a compilation error. */
function snowflake(fails?: string): void {
  sent = [];
  sentContext = [];
  identityStall = null;
  statementStall = null;
  const api: SqlApi = async (_method, _path, _query, body) => {
    const statement = String(body?.statement);
    if (statement.startsWith('SELECT CURRENT_USER()')) {
      if (identityStall) await identityStall;
      const role = typeof body?.role === 'string' ? body.role : 'ACME_DEPLOY';
      return { status: 200, body: { data: [['APPROVED_RUN_ACME', role, '{"roles":"","value":""}']] } };
    }
    sent.push(statement);
    sentContext.push({ statement, role: body?.role, database: body?.database });
    if (statementStall) await statementStall;
    return statement === fails
      ? { status: 422, body: { message: 'SQL compilation error' } }
      : { status: 200, body: { statementHandle: '01b2c3d4-0000-4000-8000-000000000001' } };
  };
  vi.mocked(sqlApiFor).mockResolvedValue(api);
  vi.mocked(agentsHoldingSecret).mockResolvedValue(['approved-run-acme']);
}

beforeEach(async () => {
  vi.clearAllMocks();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(RUN_DIR, { recursive: true });
  await initMigratedTestDb();
  delivered = [];
  failDeliveries = 0;

  await createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'slack',
    platform_id: 'C-work',
    instance: 'acme-bot',
    name: 'work',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  session = {
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: 'mg-1',
    thread_id: 'T-1',
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  };
  await createSession(session);
  for (const [id, name] of [
    [ALICE, 'Alice'],
    [BOB, 'Bob'],
    [OTHER_ADMIN, 'Other'],
  ]) {
    await upsertUser({ id, kind: 'slack', display_name: name, created_at: now() });
    await grantRole({ user_id: id, role: 'admin', agent_group_id: 'ag-1', granted_by: null, granted_at: now() });
  }
  writeTargets();
  snowflake();
  setDeliveryAdapter(fakeAdapter);
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('tier table', () => {
  const f = (kind: string, extra: Partial<StatementFact> = {}): StatementFact => ({
    text: kind,
    kind,
    role: 'DEPLOY_R',
    ...extra,
  });
  it.each([
    ['metadata read', [f('read_metadata')], 'card'],
    ['dev-only create, since there is no auto tier', [f('create_object', { scope: 'dev' })], 'card'],
    ['grant, even in dev', [f('grant', { scope: 'dev' })], 'card'],
    ['account role create', [f('create_role')], 'card'],
    ['a kind the classifier never reports, such as insert', [f('insert', { scope: 'dev' })], 'deny'],
    ['a read-only query', [f('select')], 'card'],
    ['a table created in a listed schema', [f('create_table', { object: 'DEV_DB.APP.T' })], 'card'],
    ['a merge into a listed schema', [f('merge', { object: 'DEV_DB.APP.T', actions: ['INSERT'] })], 'card'],
    ['a table created in a schema the target does not list', [f('create_table', { object: 'DEV_DB.OTHER.T' })], 'deny'],
    [
      'a view replaced outside the listed schemas',
      [f('create_view', { object: 'PROD_DB.APP.V', replaces: true })],
      'deny',
    ],
    ['a merge whose target has no three-part name', [f('merge', { object: 'T' })], 'deny'],
    ['a step with no named role', [f('grant', { role: null })], 'deny'],
    ['a step as a role the target does not allow', [f('grant', { role: 'OTHER_R' })], 'deny'],
    ['one denied statement denies the file', [f('grant'), f('account', { deny: 'account-level' })], 'deny'],
    ['unknown kind fails closed', [f('mystery')], 'deny'],
    ['context only runs nothing', [f('context')], 'deny'],
    ['a statement to run with no text', [f('grant', { text: '  ' })], 'deny'],
  ])('%s → %s', (_name, facts, tier) => {
    expect(classifyFacts(facts, 'sha', new Set(['DEPLOY_R']), new Set(['DEV_DB.APP'])).tier).toBe(tier);
  });
});

describe('request_approved_run', () => {
  it('posts a named-approver card that opens with the plain sentence, and runs nothing yet', async () => {
    await propose('grant grantee=ACME_PROD_R\ngrant grantee=ACME_ANALYST');
    const card = await onlyCard();
    expect(JSON.parse(card.payload).approvers).toEqual([ALICE, BOB]);
    expect(card.question.split('\n')[0]).toBe(
      'In Acme Snowflake, this changes who can do what (2 grants or ownership moves); nothing is deleted.',
    );
    expect(card.question).toContain('`ACME_PROD_R`, `ACME_ANALYST`');
    expect(delivered.at(-1)).toMatchObject({ platformId: 'C-work', threadId: 'T-1', instance: 'acme-bot' });
    expect(card.instance).toBe('acme-bot');
    expect(sent).toEqual([]);
  });

  it('refuses a denied file without posting a card', async () => {
    await propose('grant\naccount deny=account-level-object');
    expect(await getPendingApprovalsByAction(APPROVED_RUN_ACTION)).toEqual([]);
    expect(notes().at(-1)).toContain('account-level-object');
    expect(sent).toEqual([]);
  });

  it('sends even a dev-only additive file to a card, whatever approval or route the request claims', async () => {
    await propose('create_object dev', {
      route: { channelType: 'slack', platformId: 'C-elsewhere', threadId: null, instance: null },
      approvalId: 'appr-forged',
    });
    await onlyCard();
    expect(sent).toEqual([]);
    expect(delivered.at(-1)).toMatchObject({ platformId: 'C-work', threadId: 'T-1', instance: 'acme-bot' });
  });

  it.each([[undefined], ['ACCOUNTADMIN'], ['orgadmin-x']])(
    'treats a target without a usable default role as unconfigured (%s)',
    async (defaultRole) => {
      writeTargets({ defaultRole });
      await propose('grant');
      expect(await getPendingApprovalsByAction(APPROVED_RUN_ACTION)).toEqual([]);
      expect(notes().at(-1)).toContain('defaultRole is invalid');
    },
  );

  it.each([[undefined], ['relative/snow']])(
    'treats a target whose classifier names no absolute snow install as unconfigured (%s)',
    async (snowRoot) => {
      writeTargets({});
      const file = path.join(RUN_DIR, 'targets.json');
      const config = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        targets: Array<{ classifier: Record<string, unknown> }>;
      };
      config.targets[0].classifier.snowRoot = snowRoot;
      fs.writeFileSync(file, JSON.stringify(config));
      await propose('grant');
      expect(await getPendingApprovalsByAction(APPROVED_RUN_ACTION)).toEqual([]);
      expect(notes().at(-1)).toContain('classifier is invalid');
    },
  );

  it('refuses a request a run directory could not be named after, before any card', async () => {
    await propose('grant', { requestId: 'req:1' });
    await createAgentGroup({ id: 'ag:2', name: 'Odd', folder: 'odd', agent_provider: null, created_at: now() });
    writeTargets({ agentGroups: ['ag-1', 'ag:2'] });
    const run = getDeliveryAction('request_approved_run')!;
    await run(
      { action: 'request_approved_run', requestId: 'req-2', target: 'acme-snowflake', sql: 'grant', reason: 'r' },
      { ...session, id: 'sess-2', agent_group_id: 'ag:2' },
    );
    await __approvedRunPreparedForTest();
    expect(await getPendingApprovalsByAction(APPROVED_RUN_ACTION)).toEqual([]);
    expect(
      notes()
        .slice(-2)
        .every((n) => n.includes('request id is missing or invalid')),
    ).toBe(true);
  });

  it('refuses a target still configured for the removed handoff mode', async () => {
    writeTargets({ mode: 'handoff', handoff: { connection: 'admin_conn' }, execute: undefined });
    await propose('grant');
    expect(await getPendingApprovalsByAction(APPROVED_RUN_ACTION)).toEqual([]);
    expect(notes().at(-1)).toContain('mode is invalid');
  });

  it('refuses an agent group the target does not list', async () => {
    writeTargets({ agentGroups: ['ag-other'] });
    await propose('grant');
    expect(await getPendingApprovalsByAction(APPROVED_RUN_ACTION)).toEqual([]);
    expect(notes().at(-1)).toContain('may not propose runs for Acme Snowflake');
  });

  it('refuses when the installed classifier no longer matches its pinned sha256', async () => {
    writeTargets();
    fs.appendFileSync(path.join(RUN_DIR, 'fake_classifier.py'), '\n# edited\n');
    await propose('select dev');
    expect(sent).toEqual([]);
    expect(notes().at(-1)).toContain('does not match its pinned sha256');
  });
});

describe('the key check before a card', () => {
  it('posts no card while the lane key is not stored, and says the target is not set up', async () => {
    vi.mocked(agentsHoldingSecret).mockResolvedValue([]);
    await propose('grant grantee=ACME_PROD_R');
    expect(await getPendingApprovalsByAction(APPROVED_RUN_ACTION)).toEqual([]);
    expect(notes().at(-1)).toContain("Acme Snowflake isn't set up yet");
    expect(notes().at(-1)).toContain('nothing was proposed');
  });

  it('posts no card when the key is also granted to another agent', async () => {
    vi.mocked(agentsHoldingSecret).mockResolvedValue(['approved-run-acme', 'ag-agent']);
    await propose('grant grantee=ACME_PROD_R');
    expect(await getPendingApprovalsByAction(APPROVED_RUN_ACTION)).toEqual([]);
    expect(notes().at(-1)).toContain('also granted to ag-agent');
  });

  it('posts no card when the vault cannot be read, and says it could not check rather than that the key is missing', async () => {
    vi.mocked(agentsHoldingSecret).mockRejectedValue(new Error('gateway unreachable'));
    await propose('grant grantee=ACME_PROD_R');
    expect(await getPendingApprovalsByAction(APPROVED_RUN_ACTION)).toEqual([]);
    expect(notes().at(-1)).toContain("couldn't check whether Acme Snowflake is set up");
    expect(notes().at(-1)).not.toContain("isn't set up yet");
  });

  it('refuses an empty file for what is wrong with it, before reading the vault', async () => {
    vi.mocked(agentsHoldingSecret).mockResolvedValue([]);
    await propose('   ');
    expect(notes().at(-1)).toContain('the file is empty');
    expect(vi.mocked(agentsHoldingSecret)).not.toHaveBeenCalled();
  });

  it('returns to the delivery loop before reading the vault, and posts the card once the key checks out', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.mocked(agentsHoldingSecret).mockImplementation(async () => {
      await gate;
      return ['approved-run-acme'];
    });
    await getDeliveryAction('request_approved_run')!(
      { action: 'request_approved_run', requestId: 'req-gated', target: 'acme-snowflake', sql: 'grant', reason: 'r' },
      session,
    );
    expect(await getPendingApprovalsByAction(APPROVED_RUN_ACTION)).toEqual([]);
    release();
    await __approvedRunPreparedForTest();
    expect(await getPendingApprovalsByAction(APPROVED_RUN_ACTION)).toHaveLength(1);
  });
});

describe('answering the card', () => {
  it('only a named approver may answer', async () => {
    await propose('grant');
    const card = await onlyCard();
    expect(await canAnswerApproval(card, ALICE)).toBe(true);
    expect(await canAnswerApproval(card, BOB)).toBe(true);
    expect(await canAnswerApproval(card, OTHER_ADMIN)).toBe(false);
  });

  it('Run it sends the approved statement once, and a second replay of the same grant runs nothing', async () => {
    const sql = 'grant grantee=ACME_PROD_R';
    await propose(sql);
    const card = await onlyCard();
    await resolveChoice(card, 'run', ALICE);
    await runsSettled();
    expect(sent).toEqual([sql]);
    expect(await getPendingApprovalsByAction(APPROVED_RUN_ACTION)).toEqual([]);

    await reenterGuardedDeliveryAction('request_approved_run')({
      session,
      payload: JSON.parse(card.payload),
      approval: card,
    });
    expect(sent).toEqual([sql]);
  });

  it('runs each statement as its own request, in order, under the role and database it was classified under', async () => {
    await propose('read_metadata db=DEV_DB role=SYSADMIN\ncontext\ncreate_object dev db=DEV_DB');
    await resolveChoice(await onlyCard(), 'run', ALICE);
    await runsSettled();
    expect(sentContext).toEqual([
      { statement: 'read_metadata db=DEV_DB role=SYSADMIN', role: 'SYSADMIN', database: 'DEV_DB' },
      { statement: 'create_object dev db=DEV_DB', role: 'ACME_DEPLOY', database: 'DEV_DB' },
    ]);
  });

  it('a request re-delivered as a second card still runs once', async () => {
    await propose('grant', { requestId: 'req-dup' });
    await propose('grant', { requestId: 'req-dup' });
    const cards = await getPendingApprovalsByAction(APPROVED_RUN_ACTION);
    expect(cards).toHaveLength(2);
    await resolveChoice(cards[0], 'run', ALICE);
    await resolveChoice(cards[1], 'run', BOB);
    await runsSettled();
    expect(sent).toEqual(['grant']);
    expect(posts().at(-1)).toContain('Nothing ran: run ag-1--req-dup already ran');
  });

  it('runs nothing when the stored file changed after the card was posted', async () => {
    await propose('grant');
    const card = await onlyCard();
    const tampered = { ...JSON.parse(card.payload), sql: 'grant\ngrant grantee=SOMEONE_ELSE' };
    await getDb().run(
      'UPDATE pending_approvals SET payload = ? WHERE approval_id = ?',
      JSON.stringify(tampered),
      card.approval_id,
    );

    await resolveChoice({ ...card, payload: JSON.stringify(tampered) }, 'run', ALICE);
    expect(sent).toEqual([]);
    expect(posts().at(-1)).toContain('Nothing ran: the stored file no longer matches');
  });

  it('runs nothing when the card is older than its 24h window', async () => {
    await propose('grant');
    const card = await onlyCard();
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await getDb().run('UPDATE pending_approvals SET created_at = ? WHERE approval_id = ?', stale, card.approval_id);

    await resolveChoice({ ...card, created_at: stale }, 'run', ALICE);
    expect(sent).toEqual([]);
    expect(posts().at(-1)).toMatch(
      /^Nothing ran: this approval no longer covers the request .*Propose it again for a fresh card\.$/,
    );
    expect(notes().at(-1)).toMatch(/^Alice chose Run it, but nothing ran: this approval no longer covers/);
  });

  it('Don’t run closes the card and runs nothing', async () => {
    await propose('grant');
    const card = await onlyCard();
    await resolveChoice(card, 'decline', BOB);
    expect(sent).toEqual([]);
    expect(await getPendingApprovalsByAction(APPROVED_RUN_ACTION)).toEqual([]);
    expect(notes().at(-1)).toContain('Bob chose not to run');
  });

  it('a config change during classification never reaches the card', async () => {
    await propose('grant swap');
    const card = await onlyCard();
    expect(JSON.parse(card.payload).approvers).toEqual([ALICE, BOB]);
    expect(card.question).toContain('Only Alice or Bob can answer');
    expect(await canAnswerApproval(card, OTHER_ADMIN)).toBe(false);
  });

  it('runs nothing when the target was reconfigured after the card was posted', async () => {
    await propose('grant');
    const card = await onlyCard();
    writeTargets({ execute: { ...EXECUTE, user: 'OTHER_SERVICE_USER' } });
    await resolveChoice(card, 'run', ALICE);
    expect(sent).toEqual([]);
    const why =
      "Acme Snowflake's entry in the approved-run config changed after the card was posted (its connection, approvers, roles or classifier pin), so this approval no longer covers it. Propose it again for a fresh card.";
    expect(posts().at(-1)).toBe(`Nothing ran: ${why}`);
    expect(notes().at(-1)).toBe(`Alice chose Run it, but nothing ran: ${why}`);
  });

  it('a refused Run it reaches the agent when the thread post fails, on the next delivery pass', async () => {
    await propose('grant');
    const card = await onlyCard();
    writeTargets({ approvers: [ALICE] });
    failDeliveries = 1;
    await resolveChoice(card, 'run', ALICE);
    await new Promise((resolve) => setImmediate(resolve));
    expect(posts().filter((p) => p.startsWith('Nothing ran:'))).toHaveLength(0);
    await deliverQueued(undefined, { now: () => Date.now() + 11 * 60 * 1000 });
    expect(sent).toEqual([]);
    expect(posts().filter((p) => p.startsWith('Nothing ran:'))).toHaveLength(1);
    expect(notes().filter((n) => n.startsWith('Alice chose Run it, but nothing ran:'))).toHaveLength(1);
  });

  it('binds the card to the target entry as the file holds it, not to the parsed target', async () => {
    const entry = JSON.parse(fs.readFileSync(path.join(RUN_DIR, 'targets.json'), 'utf8')).targets[0];
    const reordered = Object.fromEntries(Object.entries(entry).reverse());
    fs.writeFileSync(path.join(RUN_DIR, 'targets.json'), JSON.stringify({ targets: [reordered] }));
    await propose('grant');
    expect(JSON.parse((await onlyCard()).payload).targetSha).toBe(
      createHash('sha256').update(JSON.stringify(reordered)).digest('hex'),
    );
  });

  it('a card still runs after the config file is rewritten without changing its target', async () => {
    await propose('grant');
    const card = await onlyCard();
    const file = JSON.parse(fs.readFileSync(path.join(RUN_DIR, 'targets.json'), 'utf8'));
    file.targets.push({ ...file.targets[0], id: 'acme-other', label: 'Acme Other' });
    fs.writeFileSync(path.join(RUN_DIR, 'targets.json'), JSON.stringify(file, null, 4));
    await resolveChoice(card, 'run', ALICE);
    expect(sent).toEqual(['grant']);
  });

  it('an expired grant never runs, even when the payload claims a looser tier', async () => {
    await propose('grant');
    const card = await onlyCard();
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await getDb().run('UPDATE pending_approvals SET created_at = ? WHERE approval_id = ?', stale, card.approval_id);
    const held = JSON.parse(card.payload) as Record<string, unknown>;
    const decision = await withCentralSync(
      () =>
        guard(approvedRunExecute, {
          actor: { kind: 'agent', agentGroupId: 'ag-1', sessionId: session.id },
          payload: {
            ...held,
            classification: { tier: 'auto', statements: [], denyReasons: [], classifierSha256: 'x' },
          },
          grant: { ...card, created_at: stale },
        }),
      'test',
    );
    expect(decision.effect).toBe('deny');
  });

  it('a grant whose stored payload cannot be read covers nothing', async () => {
    await propose('grant');
    const card = await onlyCard();
    const decision = await withCentralSync(
      () =>
        guard(approvedRunExecute, {
          actor: { kind: 'agent', agentGroupId: 'ag-1', sessionId: session.id },
          payload: JSON.parse(card.payload) as Record<string, unknown>,
          grant: { ...card, payload: '{not json' },
        }),
      'test',
    );
    expect(decision.effect).toBe('deny');
  });
});

const MERGE_FACT = {
  text: 'merge',
  kind: 'merge',
  role: 'R',
  object: 'DEV_DB.APP.T',
  actions: ['INSERT'],
  sources: [],
};

describe('classifier output', () => {
  it.each([
    ['output that is not JSON', 'grant\n!garbage', "returned output the host can't read"],
    ['a classifier that exits non-zero', 'grant\n!crash', 'Acme Snowflake classifier failed'],
    ...(
      [
        ['statements that are not a list', { statements: {} }],
        ['a statement with no kind', { statements: [{ text: 'grant', role: 'R' }] }],
        ['a MERGE whose sources are not names', { statements: [{ ...MERGE_FACT, sources: [1] }] }],
        ['an empty list of cut VALUES lists', { statements: [{ ...MERGE_FACT, display: 'x', collapsed: [] }] }],
        [
          'a cut VALUES list without its hash',
          { statements: [{ ...MERGE_FACT, display: 'x', collapsed: [{ rows: 3, sha256: 'zz' }] }] },
        ],
        ['a shown text with nothing cut from it', { statements: [{ ...MERGE_FACT, display: 'x' }] }],
      ] as const
    ).map(([name, out]) => [name, `!raw ${JSON.stringify(out)}`, "returned output the host can't read"]),
  ])('refuses %s without a card', async (_name, sql, reason) => {
    await propose(sql);
    expect(await getPendingApprovalsByAction(APPROVED_RUN_ACTION)).toEqual([]);
    expect(sent).toEqual([]);
    expect(notes().at(-1)).toContain(reason);
  });

  it('refuses when the classifier is not installed', async () => {
    fs.rmSync(path.join(RUN_DIR, 'fake_classifier.py'));
    await propose('grant');
    expect(await getPendingApprovalsByAction(APPROVED_RUN_ACTION)).toEqual([]);
    expect(notes().at(-1)).toContain('classifier is not installed on this host');
  });

  it('refuses a classifier that reports a context name the request fields could read as more than a name', async () => {
    await propose('grant role=SYS-ADMIN');
    expect(sent).toEqual([]);
    expect(notes().at(-1)).toContain("returned output the host can't read");
  });
});

describe('a tap while the run is still going', () => {
  const runDir = path.join(RUN_DIR, 'runs', 'ag-1--req-run');
  const edits = () =>
    delivered
      .map((d) => JSON.parse(d.content) as { operation?: string; text?: string })
      .filter((c) => c.operation === 'edit')
      .map((c) => c.text ?? '');

  it('marks the card answered before the run ends, and a second tap in that window runs nothing more', async () => {
    let release!: () => void;
    statementStall = new Promise((resolve) => (release = resolve));
    await propose('create_role a', { requestId: 'req-run' });
    const card = await onlyCard();

    await resolveChoice(card, 'run', ALICE);
    await vi.waitFor(() => expect(sent).toEqual(['create_role a']));
    expect(fs.existsSync(path.join(runDir, 'finished.json'))).toBe(false);
    expect(await getPendingApprovalsByAction(APPROVED_RUN_ACTION)).toEqual([]);
    expect(edits().at(-1)).toContain('✅ Run it — Alice');

    await resolveChoice(card, 'run', BOB);
    release();
    await runsSettled();
    expect(sent).toEqual(['create_role a']);
    expect(posts().filter((p) => p.startsWith('Approved by'))).toHaveLength(1);
    expect(edits().filter((e) => e.includes('✅ Run it'))).toHaveLength(1);
  });

  it('a run that throws after its claim still tells the thread and the agent, from its step log', async () => {
    let release!: () => void;
    identityStall = new Promise((resolve) => (release = resolve));
    await propose('create_role a', { requestId: 'req-run' });
    await resolveChoice(await onlyCard(), 'run', ALICE);
    await vi.waitFor(() => expect(fs.existsSync(path.join(runDir, 'meta.json'))).toBe(true));
    fs.mkdirSync(path.join(runDir, 'log.jsonl'));
    release();

    await runsSettled();
    expect(sent).toEqual([]);
    const said =
      /^An error \(EISDIR\) stopped approved run `ag-1--req-run` and its step log cannot be read, so what ran is unknown; check Snowflake query history/;
    expect(posts().at(-1)).toMatch(said);
    expect(notes().at(-1)).toMatch(said);
  });
});

describe('the card', () => {
  it('shows every statement that needs approval in full, within the smallest platform budget', async () => {
    await upsertUser({ id: ALICE, kind: 'slack', display_name: 'A'.repeat(200), created_at: now() });
    await upsertUser({ id: BOB, kind: 'slack', display_name: 'B'.repeat(200), created_at: now() });
    const longRole = 'R'.repeat(200);
    writeTargets({ allowedRoles: ['SECURITYADMIN', longRole], approvers: [ALICE, 'discord:U-bob'] });
    const card = [
      `grant role=${longRole} grantee=${'X'.repeat(100)}`,
      'ownership grantee=OWNER_R drops',
      'create_role',
      'revoke grantee=OLD_R',
      'alter',
    ];
    await propose(card.join('\n'));
    const question = (await onlyCard()).question;
    expect(question.length).toBeLessThanOrEqual(1900 - 140 - 4 - 160);
    for (const line of card) expect(question).toContain(line);
    for (const line of [
      '• Grants: 1',
      '• Revokes: 1',
      '• Ownership moves: 1',
      '• New roles: 1',
      '• Schemas switched to managed access: 1',
      'sha256 `',
      'Silence runs nothing',
    ]) {
      expect(question).toContain(line);
    }
    expect(question.split('\n')[0]).toContain(
      "nothing is deleted, but an ownership move can be undone only by the new owner or a role with MANAGE GRANTS, and one ownership move drops the object's existing grants, which only re-granting by hand restores",
    );
  });

  it('shows where each statement resolves its unqualified names', async () => {
    await propose('ownership db=PROD_DB role=SYSADMIN\ngrant');
    const question = (await onlyCard()).question;
    expect(question).toContain('▸ role SYSADMIN · in PROD_DB, default schema\nownership db=PROD_DB role=SYSADMIN');
    expect(question).toContain('▸ role ACME_DEPLOY · default database\ngrant');
  });

  it('warns that a role-to-role grant flows up to every role above the grantee', async () => {
    await propose('grant granted=READER grantee=ANALYST\ngrant grantee=OTHER');
    const question = (await onlyCard()).question;
    expect(question).toContain(
      '• Role-to-role grants: 1. Each grantee may sit under other roles, and what it gains flows up to all of them: `ANALYST`',
    );
  });

  it('posts no card when the statements that need approval cannot all be shown', async () => {
    await propose(Array.from({ length: 20 }, (_, i) => `grant grantee=${'G'.repeat(150)}${i}`).join('\n'));
    expect(await getPendingApprovalsByAction(APPROVED_RUN_ACTION)).toEqual([]);
    expect(notes().at(-1)).toContain('too long to show in full on one card; split the file');
    expect(sent).toEqual([]);
  });

  const grants = Array.from({ length: 12 }, (_, i) => `grant grantee=${'G'.repeat(120)}${i}`).join('\n');

  it('takes Slack’s larger budget when the thread and every approver are on Slack', async () => {
    await propose(grants);
    const question = (await onlyCard()).question;
    expect(question.length).toBeGreaterThan(1900 - 140 - 4 - 160);
    expect(question.length).toBeLessThanOrEqual(2800 - 140 - 4 - 160);
  });

  it('keeps Discord’s budget when an approver’s DM copy would land on Discord, though the thread is on Slack', async () => {
    await upsertUser({ id: 'discord:U-bob', kind: 'discord', display_name: 'Bob', created_at: now() });
    writeTargets({ approvers: [ALICE, 'discord:U-bob'] });
    await propose(grants);
    expect(await getPendingApprovalsByAction(APPROVED_RUN_ACTION)).toEqual([]);
    expect(notes().at(-1)).toContain('too long to show in full on one card');
  });

  it.each([
    ['a code fence', 'grant grantee=A```'],
    ['a right-to-left override', 'grant grantee=A\u202E'],
    ['a zero-width space', 'grant grantee=A\u200B'],
  ])('posts no card for a statement holding %s', async (_name, line) => {
    await propose(line);
    expect(await getPendingApprovalsByAction(APPROVED_RUN_ACTION)).toEqual([]);
    expect(notes().at(-1)).toContain('a card cannot show as written');
  });
});

describe('data statements', () => {
  it('by reference, leaves out first lines and summary lines that only repeat the entry, and skips leading comments', () => {
    const fact = (kind: string, text: string, object: string | null, extra: Partial<StatementFact> = {}) => ({
      text,
      kind,
      object,
      role: 'ACME_DEPLOY',
      tier: 'card' as const,
      ...extra,
    });
    const pad = `  ${'C'.repeat(600)} INT\n`;
    const c = {
      tier: 'card' as const,
      denyReasons: [],
      classifierSha256: 'x',
      statements: [
        fact('create_table', `-- why\nCREATE TABLE IF NOT EXISTS DEV_DB.APP.T (\n${pad.repeat(3)});`, 'DEV_DB.APP.T'),
        fact(
          'merge',
          `MERGE INTO DEV_DB.APP.T t\nUSING DEV_DB.APP.U s ON TRUE\n${pad}WHEN MATCHED THEN DELETE;`,
          'DEV_DB.APP.T',
          {
            actions: ['DELETE'],
            sources: ['DEV_DB.APP.U'],
          },
        ),
        fact('select', '-- verify\n\nSELECT COUNT(*) FROM DEV_DB.APP.T;', null),
      ],
    };
    const question = cardQuestion(
      { label: 'Acme Snowflake', execute: { user: 'SVC' }, repo: 'acme/warehouse' } as never,
      c,
      'f'.repeat(64),
      ['Alice'],
      { url: 'https://github.com/acme/warehouse/blob/x/y.sql', branch: 'develop' },
      QUESTION_MAX,
    );
    expect(question.split('\n')[0]).toBe('3 statements shown by reference; read them at the link.');
    expect(question).not.toContain('CREATE TABLE IF NOT EXISTS');
    expect(question).not.toContain('MERGE INTO DEV_DB.APP.T t');
    expect(question).toContain('  SELECT COUNT(*) FROM DEV_DB.APP.T;');
    expect(question).not.toContain('-- verify');
    expect(question).toContain('MERGE INTO DEV_DB.APP.T · sha256');
    expect(question).toContain('  WHEN: DELETE');
    expect(question).toContain('  READS: DEV_DB.APP.U');
    expect(question).not.toContain('• New tables');
    expect(question).not.toContain('• MERGE into');
  });

  const COMMIT = 'a1'.repeat(20);
  const FILE = 'migrations/2026-01-01-widgets.sql';
  let onBranch: 'develop' | 'main' | null;
  let merged: string | null;

  beforeEach(() => {
    writeTargets({ schemas: ['DEV_DB.APP'], repo: 'acme/warehouse' });
    onBranch = 'develop';
    merged = null;
    vi.mocked(repoReader).mockReturnValue({
      refresh: async () => undefined,
      branchOf: async () => onBranch,
      blob: async (_c, f) => (f === FILE && merged !== null ? Buffer.from(merged) : null),
      blobId: async () => null,
      names: async () => [],
      extract: async () => undefined,
    });
  });

  async function proposeMerged(sql: string, extra: Record<string, unknown> = {}): Promise<void> {
    merged = sql;
    await propose(sql, { source: { commit: COMMIT, path: FILE }, ...extra });
  }

  it('names what each statement creates or writes, flags a rebuild, and says a MERGE deletes rows', async () => {
    await propose(
      [
        'create_table obj=DEV_DB.APP.T',
        'create_view obj=DEV_DB.APP.V replaces',
        'merge obj=DEV_DB.APP.T actions=INSERT,UPDATE_2_columns,DELETE sources=DEV_DB.APP.U',
        'select',
      ].join('\n'),
    );
    const question = (await onlyCard()).question;
    expect(question.split('\n')[0]).toBe(
      'In Acme Snowflake, this creates 1 table, creates or replaces 1 view, writes rows into 1 table with MERGE, runs 1 read-only query; one MERGE deletes the rows its WHEN … THEN DELETE matches, but one statement replaces any existing view or dynamic table of the same name.',
    );
    for (const line of [
      '• New tables: 1: `DEV_DB.APP.T`',
      '• OR REPLACE, rebuilding any existing one: 1: `DEV_DB.APP.V`',
      '• MERGE into `DEV_DB.APP.T`: INSERT, UPDATE 2 columns, DELETE; reads `DEV_DB.APP.U`',
      '• Read-only queries: 1',
      'what SELECT returns goes to the agent',
    ]) {
      expect(question).toContain(line);
    }
  });

  it('counts the tables MERGEs write into, not the MERGE statements', async () => {
    await propose(
      'merge obj=DEV_DB.APP.T actions=INSERT\nmerge obj=DEV_DB.APP.T actions=DELETE\nmerge obj=DEV_DB.APP.U actions=INSERT',
    );
    expect((await onlyCard()).question.split('\n')[0]).toContain('writes rows into 2 tables with MERGE');
  });

  it('posts no card for a statement that writes outside the schemas the target lists', async () => {
    await propose('create_table obj=DEV_DB.APP.T\ncreate_table obj=DEV_DB.OTHER.T');
    expect(await getPendingApprovalsByAction(APPROVED_RUN_ACTION)).toEqual([]);
    expect(notes().at(-1)).toContain('writes DEV_DB.OTHER.T, outside the schemas this target lists');
  });

  it('posts no card for a MERGE that reads a table outside the listed schemas, since it would consume a stream', async () => {
    await propose('merge obj=DEV_DB.APP.T actions=INSERT sources=DEV_DB.APP.U,PROD_DB.APP.EVENTS');
    expect(await getPendingApprovalsByAction(APPROVED_RUN_ACTION)).toEqual([]);
    expect(notes().at(-1)).toContain('a MERGE reads PROD_DB.APP.EVENTS, outside the schemas this target lists');
  });

  it('posts no card for a table or merge on a target that lists no schemas', async () => {
    writeTargets({ repo: 'acme/warehouse' });
    await propose('merge obj=DEV_DB.APP.T actions=INSERT');
    expect(await getPendingApprovalsByAction(APPROVED_RUN_ACTION)).toEqual([]);
    expect(notes().at(-1)).toContain('outside the schemas this target lists');
  });

  it('refuses classifier output whose MERGE does not say what it does to rows', async () => {
    await propose('merge obj=DEV_DB.APP.T');
    expect(await getPendingApprovalsByAction(APPROVED_RUN_ACTION)).toEqual([]);
    expect(notes().at(-1)).toContain("returned output the host can't read");
  });

  it('posts no card for a cut VALUES list unless the file is linked where it is merged', async () => {
    await propose('merge obj=DEV_DB.APP.T actions=INSERT cut=1800');
    expect(await getPendingApprovalsByAction(APPROVED_RUN_ACTION)).toEqual([]);
    expect(notes().at(-1)).toContain(
      'a long VALUES list is shown cut, so the card must link the file: propose it again with source { commit, path } for the file merged to develop or main in acme/warehouse',
    );
  });

  it('links the merged file and states the cut when the source checks out', async () => {
    const sql = 'merge obj=DEV_DB.APP.T actions=INSERT cut=1800';
    await proposeMerged(sql);
    const question = (await onlyCard()).question;
    expect(question).toContain(
      `Source (on develop, same bytes): https://github.com/acme/warehouse/blob/${COMMIT}/${FILE}`,
    );
    expect(question).toContain(
      `${sql} [cut]\n▸ VALUES list: 1800 rows, first and last 3 shown · sha256 \`aaaaaaaaaaaa\``,
    );
  });

  it('ignores a link the agent supplies itself', async () => {
    await propose('merge obj=DEV_DB.APP.T actions=INSERT cut=1800', {
      sourceLink: { url: 'https://example.test/anything', branch: 'main' },
    });
    expect(await getPendingApprovalsByAction(APPROVED_RUN_ACTION)).toEqual([]);
    expect(notes().at(-1)).toContain('the card must link the file');
  });

  it.each([
    [
      'the merged bytes differ',
      () => (merged = 'merge obj=DEV_DB.APP.T actions=DELETE'),
      'differs from the proposed file',
    ],
    [
      'the commit is on neither develop nor main',
      () => (onBranch = null),
      'is not on develop or main of acme/warehouse',
    ],
  ])('posts no card when %s', async (_name, plant, why) => {
    const sql = 'merge obj=DEV_DB.APP.T actions=INSERT cut=1800';
    merged = sql;
    plant();
    await propose(sql, { source: { commit: COMMIT, path: FILE } });
    expect(await getPendingApprovalsByAction(APPROVED_RUN_ACTION)).toEqual([]);
    expect(notes().at(-1)).toContain(why);
  });

  it('posts no card for a source on a target that names no repository', async () => {
    writeTargets({ schemas: ['DEV_DB.APP'] });
    await proposeMerged('select');
    expect(await getPendingApprovalsByAction(APPROVED_RUN_ACTION)).toEqual([]);
    expect(notes().at(-1)).toContain('names no repository');
  });

  const longData = Array.from(
    { length: 5 },
    (_, i) => `create_view obj=DEV_DB.APP.V${i} replaces ${'x'.repeat(600)}`,
  ).join('\n');

  it('shows data statements by reference when they cannot all fit, and opens by saying so', async () => {
    await proposeMerged(`${longData}\ngrant grantee=READER role=SYSADMIN`);
    const question = (await onlyCard()).question;
    expect(question.length).toBeLessThanOrEqual(1900 - 140 - 4 - 160);
    expect(question.split('\n')[0]).toBe('5 statements shown by reference; read them at the link.');
    const first = longData.split('\n')[0];
    expect(question).toContain(
      `CREATE VIEW DEV_DB.APP.V0 (OR REPLACE) · sha256 \`${createHash('sha256').update(first).digest('hex').slice(0, 12)}\``,
    );
    expect(question).not.toContain(first);
    expect(question.split('▸ role ACME_DEPLOY · default database').length).toBe(2);
    expect(question).toContain('▸ role SYSADMIN · default database\ngrant grantee=READER role=SYSADMIN');
  });

  it('posts no card for statements too long to show in full when there is no source to link', async () => {
    await propose(longData);
    expect(await getPendingApprovalsByAction(APPROVED_RUN_ACTION)).toEqual([]);
    expect(notes().at(-1)).toContain('too long to show in full on one card, so the card must link the file');
  });

  it.each([
    ['a schema that is not DB.SCHEMA', { schemas: ['APP'] }],
    ['an empty schema list', { schemas: [] }],
    ['a repo that is not owner/name', { repo: 'warehouse' }],
  ])('refuses a target with %s', async (_name, overrides) => {
    writeTargets(overrides);
    await propose('select');
    expect(await getPendingApprovalsByAction(APPROVED_RUN_ACTION)).toEqual([]);
    expect(notes().at(-1)).toMatch(/target acme-snowflake: (schemas|repo) is invalid/);
  });
});

describe('executing on approval', () => {
  it('says on the card that the host runs it, then runs each statement once and posts which ran', async () => {
    snowflake();
    await propose('create_role a\ncontext\ngrant grantee=B');
    const card = await onlyCard();
    expect(card.question).toContain(
      'on approval: the host runs it now as `APPROVED_RUN_ACME`, one statement at a time, stopping at the first failure\n',
    );
    await resolveChoice(card, 'run', ALICE);
    await runsSettled();
    expect(sent).toEqual(['create_role a', 'grant grantee=B']);
    expect(posts().at(-1)).toMatch(
      /^Approved by Alice\. Acme Snowflake run .* as `APPROVED_RUN_ACME`: all 2 steps ran and are committed\./,
    );

    await resolveChoice(card, 'run', BOB);
    await runsSettled();
    expect(sent).toHaveLength(2);
  });

  it('stops at the failing statement and tells the thread what ran and what a retry covers', async () => {
    snowflake('grant grantee=B');
    await propose('create_role a\ngrant grantee=B\ngrant grantee=C');
    await resolveChoice(await onlyCard(), 'run', ALICE);
    await runsSettled();
    expect(sent).toEqual(['create_role a', 'grant grantee=B']);
    const report = posts().at(-1) ?? '';
    expect(report).toContain('step 1 of 3 ran and is committed');
    expect(report).toContain(
      'Step 2 failed: HTTP 422: SQL compilation error. Nothing after it ran. A retry is a new proposal for steps 2–3.',
    );
  });

  it('logs a run that stopped at a failed statement as stopped there, not done', async () => {
    const info = vi.spyOn(log, 'info');
    try {
      snowflake('grant grantee=B');
      await propose('create_role a\ngrant grantee=B\ngrant grantee=C');
      await resolveChoice(await onlyCard(), 'run', ALICE);
      await runsSettled();
      await vi.waitFor(() =>
        expect(info).toHaveBeenCalledWith(
          'Approved run executed',
          expect.objectContaining({ result: 'stopped at step 2 of 3 (failed)' }),
        ),
      );
    } finally {
      info.mockRestore();
    }
  });

  it('tells the approver that what a read returns goes back to the agent', async () => {
    snowflake();
    await propose('read_metadata\ncreate_role a');
    expect((await onlyCard()).question).toContain('stopping at the first failure; what SHOW returns goes to the agent');
  });

  it('refuses an execute target whose agent is outside the reserved family, so its token could not be reserved', async () => {
    writeTargets({ execute: { ...EXECUTE, onecliAgent: 'ag-1' } });
    await propose('create_role a');
    expect(await getPendingApprovalsByAction(APPROVED_RUN_ACTION)).toHaveLength(0);
    expect(notes().at(-1)).toContain('execute is invalid');
  });

  it('refuses a target whose execute settings are malformed', async () => {
    writeTargets({ execute: { ...EXECUTE, account: 'evil.example.com/x' } });
    await propose('create_role a');
    expect(await getPendingApprovalsByAction(APPROVED_RUN_ACTION)).toHaveLength(0);
    expect(notes().at(-1)).toContain('execute is invalid');
  });

  it("removes a dead run's connection file at host start, past a stray entry in the runs folder", async () => {
    const runs = path.join(RUN_DIR, 'runs');
    fs.mkdirSync(path.join(runs, 'run-dead', 'connection'), { recursive: true });
    fs.writeFileSync(path.join(runs, 'run-dead', 'connection', 'app.json'), '{}');
    fs.writeFileSync(path.join(runs, 'stray-file'), '');
    const start = getHostStartCallbacks().find((cb) => cb.name === 'approvedRunInterruptedHostStart');
    await start!({ db: getDb(), signal: new AbortController().signal });
    expect(fs.existsSync(path.join(runs, 'run-dead', 'connection'))).toBe(false);
  });

  it('tells the thread, after a host restart, which steps of a cut-off run ran, skipping records it cannot read', async () => {
    const dir = path.join(RUN_DIR, 'runs', 'ag-1--req-x');
    fs.mkdirSync(dir, { recursive: true });
    const route = { channelType: 'slack', platformId: 'C-work', threadId: 'T-1', instance: 'acme-bot' };
    fs.writeFileSync(
      path.join(dir, 'meta.json'),
      JSON.stringify({ runId: 'ag-1--req-x', sessionId: 'sess-1', route, steps: 2 }),
    );
    fs.writeFileSync(path.join(dir, 'log.jsonl'), `${JSON.stringify({ step: 1, status: 'sending' })}\n`);
    for (const [name, meta] of [
      ['ag-1--req-null', 'null'],
      ['ag-1--req-list', '[1, 2]'],
      ['ag-1--req-foreign', JSON.stringify({ runId: 'someone-else', sessionId: 'sess-1', steps: 1 })],
    ]) {
      fs.mkdirSync(path.join(RUN_DIR, 'runs', name), { recursive: true });
      fs.writeFileSync(path.join(RUN_DIR, 'runs', name, 'meta.json'), meta);
    }
    const start = getHostStartCallbacks().find((cb) => cb.name === 'approvedRunInterruptedHostStart');
    await start!({ db: getDb(), signal: new AbortController().signal });
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toBe(
      'The host restarted during approved run `ag-1--req-x`: none of its 2 steps completed. Step 1 was sent and its outcome is unknown; check Snowflake query history for query tag `approved-run ag-1--req-x step 1`. Nothing after that ran; a retry is a new proposal for the rest.',
    );
    expect(fs.existsSync(path.join(dir, 'finished.json'))).toBe(true);
  });

  const outbox = () => path.join(RUN_DIR, 'outbox');
  const queued = () => (fs.existsSync(outbox()) ? fs.readdirSync(outbox()) : []);

  it('leaves a cut-off run open for the next boot when its report cannot be queued', async () => {
    const route = { channelType: 'slack', platformId: 'C-work', threadId: 'T-1', instance: 'acme-bot' };
    const dir = path.join(RUN_DIR, 'runs', 'ag-1--req-q');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'meta.json'),
      JSON.stringify({ runId: 'ag-1--req-q', sessionId: 'sess-1', route, steps: 1 }),
    );
    fs.writeFileSync(outbox(), 'not a directory');
    const start = getHostStartCallbacks().find((cb) => cb.name === 'approvedRunInterruptedHostStart');
    await start!({ db: getDb(), signal: new AbortController().signal });
    expect(fs.existsSync(path.join(dir, 'finished.json'))).toBe(false);

    fs.rmSync(outbox());
    await start!({ db: getDb(), signal: new AbortController().signal });
    expect(fs.existsSync(path.join(dir, 'finished.json'))).toBe(true);
    await vi.waitFor(() => expect(posts()).toEqual([expect.stringContaining('`ag-1--req-q`')]));
  });

  it("keeps a run's report queued when the thread post fails, and the next pass posts it without telling the agent twice", async () => {
    snowflake();
    await propose('create_role a');
    failDeliveries = 1;
    await resolveChoice(await onlyCard(), 'run', ALICE);
    await vi.waitFor(() => expect(failDeliveries).toBe(0));
    await vi.waitFor(() => expect(notes().some((n) => n.includes('step ran and is committed'))).toBe(true));
    expect(sent).toEqual(['create_role a']);
    expect(posts().filter((p) => p.includes('ran and'))).toEqual([]);
    expect(queued()).toHaveLength(1);
    const toldAgent = () => notes().filter((n) => n.includes('step ran and is committed') || n.includes('steps ran'));
    expect(toldAgent()).toHaveLength(1);

    await deliverQueued(undefined, { now: () => Date.now() + 11 * 60 * 1000 });
    expect(posts().at(-1)).toMatch(/^Approved by Alice\. Acme Snowflake run /);
    // A report split into chunks is delivered only when every chunk landed.
    expect(JSON.parse(delivered.at(-1)!.content)).toMatchObject({ requireCompleteDelivery: true });
    expect(toldAgent()).toHaveLength(1);
    expect(queued()).toEqual([]);
  });

  it('closes a cut-off run at boot even when nothing can be delivered, and reports it once delivery works', async () => {
    const route = { channelType: 'slack', platformId: 'C-work', threadId: 'T-1', instance: 'acme-bot' };
    for (const name of ['ag-1--req-a', 'ag-1--req-b']) {
      const dir = path.join(RUN_DIR, 'runs', name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'meta.json'),
        JSON.stringify({ runId: name, sessionId: 'sess-1', route, steps: 1 }),
      );
    }
    // A log that cannot be read still closes and reports its run, and does not hide the other one.
    fs.mkdirSync(path.join(RUN_DIR, 'runs', 'ag-1--req-a', 'log.jsonl'));
    failDeliveries = 10;
    const start = getHostStartCallbacks().find((cb) => cb.name === 'approvedRunInterruptedHostStart');
    await start!({ db: getDb(), signal: new AbortController().signal });
    const agentTold = (id: string) =>
      (
        JSON.parse(fs.readFileSync(path.join(outbox(), `run-${id}.json`), 'utf8')) as {
          legs: Array<{ to: string; delivered?: boolean }>;
        }
      ).legs.find((l) => l.to === 'agent')?.delivered === true;
    await vi.waitFor(() => expect(['ag-1--req-a', 'ag-1--req-b'].every(agentTold)).toBe(true));
    for (const name of ['ag-1--req-a', 'ag-1--req-b']) {
      expect(fs.existsSync(path.join(RUN_DIR, 'runs', name, 'finished.json'))).toBe(true);
    }
    expect(queued().sort()).toEqual(['run-ag-1--req-a.json', 'run-ag-1--req-b.json']);
    expect(posts()).toEqual([]);

    failDeliveries = 0;
    await deliverQueued(undefined, { now: () => Date.now() + 11 * 60 * 1000 });
    expect(posts().sort()).toEqual([
      expect.stringContaining('`ag-1--req-a` and its step log cannot be read, so what ran is unknown'),
      expect.stringContaining('The host restarted during approved run `ag-1--req-b`: none of its one step completed.'),
    ]);
    expect(queued()).toEqual([]);
  });
});

describe('Render targets', () => {
  const SRV = 'srv-aaaaaaaaaaaaaaaaaaaa';
  const ADMIN = 'usr-aaaaaaaaaaaaaaaaaaaa';
  let sent: Array<{ method: string; path: string; body: unknown }>;

  function writeRenderTarget(agentGroups = ['ag-1']): void {
    fs.writeFileSync(
      path.join(RUN_DIR, 'targets.json'),
      JSON.stringify({
        targets: [
          {
            id: 'acme-render',
            label: 'Acme Render',
            kind: 'render',
            mode: 'execute',
            agentGroups,
            approvers: [ALICE, BOB],
            execute: { onecliAgent: 'approved-run-acme-render', adminUserId: ADMIN },
            resources: { [SRV]: { label: 'Acme backend', plaintextEnv: ['NODE_ENV'] } },
          },
        ],
      }),
    );
  }

  /** Render through the gateway: the admin check passes, env reads list two keys, writes succeed. */
  function render(): void {
    sent = [];
    const api: RenderApi = async (method, p, body) => {
      if (method === 'GET' && p === '/v1/users') return { status: 200, body: { id: ADMIN } };
      if (method === 'GET') {
        return {
          status: 200,
          body: [
            { envVar: { key: 'NODE_ENV', value: 'production' }, cursor: 'c1' },
            { envVar: { key: 'JWT_SECRET', value: 's3cret' }, cursor: 'c2' },
          ],
        };
      }
      sent.push({ method, path: p, body });
      if (statementStall) await statementStall;
      return { status: 200, body: { key: 'JWT_SECRET', value: (body as { value?: string } | undefined)?.value } };
    };
    vi.mocked(renderApiFor).mockResolvedValue(api);
    vi.mocked(agentsHoldingSecret).mockResolvedValue(['approved-run-acme-render']);
  }

  async function proposeRender(request: Record<string, unknown>): Promise<void> {
    await getDeliveryAction('request_approved_run')!(
      {
        action: 'request_approved_run',
        requestId: `req-${++seq}`,
        target: 'acme-render',
        request,
        reason: 'rotate jwt',
      },
      session,
    );
    await __approvedRunPreparedForTest();
  }

  const SET_SECRET = { method: 'PUT', path: `/v1/services/${SRV}/env-vars/JWT_SECRET`, body: { value: 's3cret-new' } };

  beforeEach(async () => {
    await grantRole({ user_id: ALICE, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
    writeRenderTarget();
    render();
  });

  it('marks the card answered before the Render write returns, and a second tap then sends nothing', async () => {
    let release!: () => void;
    statementStall = new Promise((resolve) => (release = resolve));
    await proposeRender(SET_SECRET);
    const card = await onlyCard();
    await resolveChoice(card, 'run', ALICE);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(await getPendingApprovalsByAction(APPROVED_RUN_ACTION)).toEqual([]);
    await resolveChoice(card, 'run', BOB);
    release();
    await runsSettled();
    expect(sent).toHaveLength(1);
    expect(posts().at(-1)).toMatch(/^Approved by Alice\. Acme Render run .*: done \(HTTP 200\)\.$/);
  });

  it('a named approver who is an admin of the group, not an owner, may answer and run it', async () => {
    await proposeRender(SET_SECRET);
    const card = await onlyCard();
    expect(await canAnswerApproval(card, BOB)).toBe(true);
    await resolveChoice(card, 'run', BOB);
    await runsSettled();
    expect(sent).toEqual([{ method: 'PUT', path: SET_SECRET.path, body: { value: 's3cret-new' } }]);
  });

  it('an admin of the group who is not a named approver may not answer', async () => {
    await proposeRender(SET_SECRET);
    expect(await canAnswerApproval(await onlyCard(), OTHER_ADMIN)).toBe(false);
  });

  it('a named approver who is no longer an admin of the group may not answer', async () => {
    await proposeRender(SET_SECRET);
    const card = await onlyCard();
    await revokeRole(BOB, 'admin', 'ag-1');
    expect(await canAnswerApproval(card, BOB)).toBe(false);
    expect(await canAnswerApproval(card, ALICE)).toBe(true);
  });

  it('warns on the card when a listed value is shown masked, and not when it is shown whole', async () => {
    const setListed = (value: string) => ({
      method: 'PUT',
      path: `/v1/services/${SRV}/env-vars/NODE_ENV`,
      body: { value },
    });
    await proposeRender(setListed('https://peer.example.com/hook?token=abc'));
    expect((await onlyCard()).question).toContain('The card masks all or part of the new value');
    await getDb().run('DELETE FROM pending_approvals');
    await proposeRender(setListed('production'));
    const card = await onlyCard();
    expect(card.question).toContain('"value": "production"');
    expect(card.question).not.toContain('masks all or part');
  });

  it("tells the approver a one-off job's output is readable by the agents", async () => {
    await proposeRender({ method: 'POST', path: `/v1/services/${SRV}/jobs`, body: { startCommand: 'npm run task' } });
    expect((await onlyCard()).question).toContain("job logs the agents' own key can read");
  });

  it('posts a card that masks a secret value, and sends nothing before approval', async () => {
    await proposeRender(SET_SECRET);
    const card = await onlyCard();
    expect(card.question).toContain(`PUT /v1/services/${SRV}/env-vars/JWT_SECRET`);
    expect(card.question).toContain(maskValue('s3cret-new', maskKey('acme-render')));
    expect(card.question).not.toContain('s3cret-new');
    const sha = (JSON.parse(card.payload) as { sha256: string }).sha256;
    expect(card.question).not.toContain(sha.slice(0, 12));
    expect(sent).toEqual([]);
  });

  it('refuses an operation outside the list without a card', async () => {
    await proposeRender({ method: 'DELETE', path: `/v1/services/${SRV}` });
    expect(await getPendingApprovalsByAction(APPROVED_RUN_ACTION)).toHaveLength(0);
    expect(notes().at(-1)).toMatch(
      /^Approved run refused: DELETE \/v1\/services\/srv-a+ is not an operation this lane runs/,
    );
  });

  it('Run it sends the exact request once as the admin key, and a second click on the card sends nothing', async () => {
    await proposeRender(SET_SECRET);
    const card = await onlyCard();
    await resolveChoice(card, 'run', ALICE);
    await runsSettled();
    expect(sent).toEqual([{ method: 'PUT', path: SET_SECRET.path, body: { value: 's3cret-new' } }]);
    expect(posts().at(-1)).toMatch(/^Approved by Alice\. Acme Render run .*: done \(HTTP 200\)\.$/);
    expect(notes().at(-1)).not.toContain('s3cret-new');
    await resolveChoice(card, 'run', BOB);
    await runsSettled();
    expect(sent).toHaveLength(1);
  });

  it('leaves a value set through the lane in no file under the runs folder', async () => {
    await proposeRender(SET_SECRET);
    await resolveChoice(await onlyCard(), 'run', ALICE);
    await runsSettled();
    const runs = path.join(RUN_DIR, 'runs');
    const files = fs.readdirSync(runs, { recursive: true, encoding: 'utf8' }).map((f) => path.join(runs, f));
    const stored = files.filter((f) => fs.statSync(f).isFile());
    expect(stored.map((f) => path.basename(f)).sort()).toEqual(['finished.json', 'log.jsonl', 'meta.json']);
    for (const f of stored) expect(fs.readFileSync(f, 'utf8'), f).not.toContain('s3cret-new');
    expect(fs.readFileSync(stored.find((f) => f.endsWith('finished.json'))!, 'utf8')).toContain(
      maskValue('s3cret-new', maskKey('acme-render')),
    );
  });

  it('runs nothing when the stored request changed after the card was posted', async () => {
    await proposeRender(SET_SECRET);
    const card = await onlyCard();
    const tampered = { ...JSON.parse(card.payload), request: { ...SET_SECRET, body: { value: 'swapped' } } };
    await getDb().run(
      'UPDATE pending_approvals SET payload = ? WHERE approval_id = ?',
      JSON.stringify(tampered),
      card.approval_id,
    );
    await resolveChoice({ ...card, payload: JSON.stringify(tampered) }, 'run', ALICE);
    expect(sent).toEqual([]);
    expect(posts().at(-1)).toContain('Nothing ran: the stored request no longer matches');
  });

  it('answers an env read with every key, masking all but the listed ones, and no card', async () => {
    await getDeliveryAction('request_render_env_read')!(
      { action: 'request_render_env_read', requestId: 'r-1', target: 'acme-render', service: SRV },
      session,
    );
    const reply = notes().at(-1) as string;
    expect(reply).toContain('NODE_ENV=production');
    expect(reply).toContain(`JWT_SECRET=${maskValue('s3cret', maskKey('acme-render'))}`);
    expect(reply).not.toContain('s3cret\n');
    expect(await getPendingApprovalsByAction(APPROVED_RUN_ACTION)).toHaveLength(0);
  });

  it.each([
    [
      [{ step: 1, status: 'sending' }],
      ', and whether Render applied its request is unknown; check the resource in the Render dashboard before proposing it again.',
    ],
    [
      [
        { step: 1, status: 'sending' },
        { step: 1, status: 'ok', http: 200 },
      ],
      ' after Render accepted its request; it is done.',
    ],
    [[], '; its request was not sent or Render refused it, so nothing changed, and a retry is a new proposal.'],
    [
      [
        { step: 1, status: 'sending' },
        { step: 1, status: 'failed', http: 404 },
      ],
      '; its request was not sent or Render refused it, so nothing changed, and a retry is a new proposal.',
    ],
  ])('tells the thread how a Render run the host restarted during ended (%j)', async (log, ending) => {
    const dir = path.join(RUN_DIR, 'runs', 'ag-1--req-r');
    fs.mkdirSync(dir, { recursive: true });
    const route = { channelType: 'slack', platformId: 'C-work', threadId: 'T-1', instance: 'acme-bot' };
    fs.writeFileSync(
      path.join(dir, 'meta.json'),
      JSON.stringify({ runId: 'ag-1--req-r', sessionId: 'sess-1', route, steps: 1, kind: 'render' }),
    );
    fs.writeFileSync(path.join(dir, 'log.jsonl'), log.map((e) => `${JSON.stringify(e)}\n`).join(''));
    const start = getHostStartCallbacks().find((cb) => cb.name === 'approvedRunInterruptedHostStart');
    await start!({ db: getDb(), signal: new AbortController().signal });
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toBe(`The host restarted during approved Render run \`ag-1--req-r\`${ending}`);
  });

  async function envRead(extra: Record<string, unknown>): Promise<string> {
    await getDeliveryAction('request_render_env_read')!(
      { action: 'request_render_env_read', requestId: `r-${++seq}`, target: 'acme-render', service: SRV, ...extra },
      session,
    );
    return notes().at(-1) as string;
  }

  it('reads one key when asked, and follows the cursor across pages for a full read', async () => {
    const calls: string[] = [];
    vi.mocked(renderApiFor).mockResolvedValue(async (_method, p) => {
      calls.push(p);
      if (p.endsWith('/env-vars/NODE_ENV')) return { status: 200, body: { key: 'NODE_ENV', value: 'production' } };
      const page = p.includes('cursor=c100') ? 1 : 0;
      const rows = Array.from({ length: page === 0 ? 100 : 1 }, (_, i) => ({
        envVar: { key: `K${page}_${i}`, value: 'v' },
        cursor: `c${page === 0 ? i + 1 : 999}`,
      }));
      return { status: 200, body: rows };
    });
    expect(await envRead({ key: 'NODE_ENV' })).toContain('NODE_ENV=production');
    expect(await envRead({})).toContain('101 keys');
    expect(calls).toEqual([
      `/v1/services/${SRV}/env-vars/NODE_ENV`,
      `/v1/services/${SRV}/env-vars?limit=100`,
      `/v1/services/${SRV}/env-vars?limit=100&cursor=c100`,
    ]);
  });

  it('says a read that hit its page cap is incomplete', async () => {
    vi.mocked(renderApiFor).mockResolvedValue(async () => ({
      status: 200,
      body: Array.from({ length: 100 }, (_, i) => ({ envVar: { key: `K${i}`, value: 'v' }, cursor: `c${i}` })),
    }));
    expect(await envRead({})).toContain('the read stopped at its page cap; the list is incomplete');
  });

  it('reports a Render error to the agent instead of a partial list', async () => {
    vi.mocked(renderApiFor).mockResolvedValue(async () => ({ status: 403, body: {} }));
    expect(await envRead({})).toBe('Render env read failed: Render answered HTTP 403');
  });

  it.each([
    [{ service: 'srv-zzzzzzzzzzzzzzzzzzzz' }, 'service must be one of the resources this target lists'],
    [{ key: 'not a key' }, 'key must be a plain env var name'],
    [{ target: 'nope' }, 'unknown approved-run target "nope"'],
  ])('refuses a read it cannot scope (%j)', async (extra, why) => {
    expect(await envRead(extra)).toBe(`Render env read refused: ${why}`);
  });

  it('refuses an env read from an agent group the target does not list', async () => {
    writeRenderTarget(['ag-other']);
    await getDeliveryAction('request_render_env_read')!(
      { action: 'request_render_env_read', requestId: 'r-2', target: 'acme-render', service: SRV },
      session,
    );
    expect(notes().at(-1)).toBe('Render env read refused: this agent may not read Acme Render');
  });
});

describe('migration targets', () => {
  const COMMIT = 'c'.repeat(40);
  const SQL = 'CREATE TABLE widgets (id int);';
  const FILE = {
    database: 'app',
    migration: '301_add_widgets',
    sha256: createHash('sha256').update(SQL).digest('hex'),
  };
  let applies: string[][];
  let renderCalls: Array<[string, string]>;
  let fetchGate: Promise<void> | null;

  function writeMigrateTarget(overrides: Record<string, unknown> = {}): void {
    fs.writeFileSync(
      path.join(RUN_DIR, 'targets.json'),
      JSON.stringify({ targets: [migrateTargetConfig([ALICE, BOB], overrides)] }),
    );
  }

  async function proposeMigration(migration: Record<string, unknown>): Promise<void> {
    await getDeliveryAction('request_approved_run')!(
      {
        action: 'request_approved_run',
        requestId: `req-${++seq}`,
        target: 'acme-migrate',
        migration,
        reason: 'add widgets',
      },
      session,
    );
  }

  /** The card is posted once the background classification finishes. */
  async function cardShown(): Promise<PendingApproval> {
    await vi.waitFor(async () => expect(await getPendingApprovalsByAction(APPROVED_RUN_ACTION)).toHaveLength(1));
    return onlyCard();
  }

  const PROPOSAL = { commit: COMMIT, goLink: 'https://example.invalid/go', files: [FILE] };

  beforeEach(() => {
    applies = [];
    const repo: RepoReader = {
      refresh: async () => {
        if (fetchGate) await fetchGate;
      },
      branchOf: async () => 'develop',
      blob: async (_c, f) =>
        f === 'backend/migrations/301_add_widgets.sql' || f === 'tools/migrate/apply.mjs' ? Buffer.from(SQL) : null,
      blobId: async () => null,
      names: async () => [],
      extract: async (_c, _p, into) => {
        fs.mkdirSync(path.join(into, 'backend/migrations'), { recursive: true });
        fs.writeFileSync(path.join(into, 'backend/migrations/301_add_widgets.sql'), SQL);
      },
    };
    vi.mocked(repoReader).mockReturnValue(repo);
    applies = [];
    renderCalls = [];
    fetchGate = null;
    vi.mocked(migrationFacts).mockResolvedValue([{ refuse: null, classes: [], irreversible: [] }]);
    vi.mocked(renderApiFor).mockImplementation(async (agent) => async (method, p) => {
      renderCalls.push([agent, `${method} ${p}`]);
      return {
        status: 200,
        body: { externalConnectionString: `postgresql://app_user:${DB_PASSWORD}@db.acme.test:5432/app` },
      };
    });
    vi.mocked(docker).mockImplementation(async (args) => {
      applies.push(args);
      if (statementStall) await statementStall;
      return {
        code: 0,
        timedOut: false,
        overflowed: false,
        stdout: 'app: identity ok, 1 pending, sha256 ok\n',
        stderr: '',
      };
    });
    vi.mocked(agentsHoldingSecret).mockResolvedValue(['approved-run-acme-app']);
    writeMigrateTarget();
  });

  const APP_DB = {
    folder: 'backend/migrations',
    onecliAgent: 'approved-run-acme-app',
    postgresId: 'dpg-aaaaaaaaaaaaaaaaaaaa',
    checked: true,
  };
  it.each([
    [
      'production and dev databases on one target',
      { databases: { app: APP_DB, 'hub-dev': { ...APP_DB, onecliAgent: 'approved-run-acme-hub' } } },
      'databases is invalid',
    ],
    [
      'a database with no identity',
      { databases: { app: { folder: 'backend/migrations', postgresId: 'dpg-aaaaaaaaaaaaaaaaaaaa', checked: true } } },
      'databases.app is invalid',
    ],
    [
      'an identity that is not a reserved lane agent',
      { databases: { app: { ...APP_DB, onecliAgent: 'ag-agent' } } },
      'databases.app is invalid',
    ],
    [
      'a Postgres id that is not a Render database',
      { databases: { app: { ...APP_DB, postgresId: 'srv-aaaaaaaaaaaaaaaaaaaa' } } },
      'databases.app is invalid',
    ],
    [
      'a folder that leaves the repository',
      { databases: { app: { ...APP_DB, folder: '../outside' } } },
      'databases.app is invalid',
    ],
    ['a comparison target that is not a target id', { compareWith: 'Not An Id' }, 'compareWith is invalid'],
    ['a target that compares with itself', { compareWith: 'acme-migrate' }, 'compareWith is invalid'],
    [
      'an apply script outside the repository',
      {
        layout: {
          applyScript: '/etc/apply.mjs',
          extract: ['x'],
          watched: ['x'],
          factsModule: 'f.mjs',
        },
      },
      'layout is invalid',
    ],
  ])('refuses a target with %s, without a card', async (_name, overrides, reason) => {
    writeMigrateTarget(overrides);
    await proposeMigration(PROPOSAL);
    expect(await getPendingApprovalsByAction(APPROVED_RUN_ACTION)).toHaveLength(0);
    expect(notes().at(-1)).toContain(reason);
  });

  it('shows the file, database and sha256 on the card, and runs nothing before approval', async () => {
    await proposeMigration(PROPOSAL);
    const card = await cardShown();
    expect(card.question).toContain(
      `https://github.com/acme/widgets/blob/${COMMIT}/backend/migrations/301_add_widgets.sql`,
    );
    expect(card.question).toContain(`\`app\``);
    expect(card.question).toContain(`sha256 \`${FILE.sha256.slice(0, 12)}\``);
    expect(applies).toEqual([]);
  });

  it('checks the key of the database the proposal names, and fetches nothing while it is missing', async () => {
    vi.mocked(agentsHoldingSecret).mockResolvedValue([]);
    const refresh = vi.spyOn(vi.mocked(repoReader)('acme/widgets'), 'refresh');
    await proposeMigration(PROPOSAL);
    await vi.waitFor(() => expect(notes().at(-1)).toContain("isn't set up yet"));
    expect(vi.mocked(agentsHoldingSecret)).toHaveBeenCalledWith('approved-run-acme-app token');
    expect(refresh).not.toHaveBeenCalled();
    expect(await getPendingApprovalsByAction(APPROVED_RUN_ACTION)).toHaveLength(0);
  });

  it('returns to the delivery loop before fetching the repository, and posts the card once classification finishes', async () => {
    let release!: () => void;
    fetchGate = new Promise((resolve) => (release = resolve));
    await proposeMigration(PROPOSAL);
    expect(await getPendingApprovalsByAction(APPROVED_RUN_ACTION)).toHaveLength(0);
    release();
    await cardShown();
  });

  it('runs nothing and says why in the thread when Render will not give the connection details', async () => {
    vi.mocked(renderApiFor).mockImplementation(async () => async () => ({ status: 403, body: {} }));
    await proposeMigration(PROPOSAL);
    await resolveChoice(await cardShown(), 'run', ALICE);
    await runsSettled();
    expect(applies).toEqual([]);
    expect(posts().at(-1)).toMatch(/nothing ran\. Render answered 403 for dpg-a+'s connection details/);
  });

  it('tells the agent when the card cannot be posted after classification', async () => {
    vi.mocked(requestApprovalOutcome).mockRejectedValueOnce(new Error('approval store unavailable'));
    await proposeMigration(PROPOSAL);
    await vi.waitFor(() => expect(notes().at(-1)).toContain('approval store unavailable'));
    expect(await getPendingApprovalsByAction(APPROVED_RUN_ACTION)).toHaveLength(0);
  });

  it('classifies one proposal per target at a time', async () => {
    let refreshes = 0;
    let release!: () => void;
    fetchGate = new Promise((resolve) => (release = resolve));
    const repo = vi.mocked(repoReader)('acme/widgets');
    vi.mocked(repoReader).mockReturnValue({
      ...repo,
      refresh: async () => {
        refreshes++;
        await repo.refresh();
      },
    });
    await proposeMigration(PROPOSAL);
    await proposeMigration({ ...PROPOSAL, goLink: 'https://example.invalid/go2' });
    await new Promise((r) => setTimeout(r, 20));
    expect(refreshes).toBe(1);
    release();
    await vi.waitFor(async () => expect(await getPendingApprovalsByAction(APPROVED_RUN_ACTION)).toHaveLength(2));
  });

  it("refuses a card when the target's config changed while its files were being checked", async () => {
    let release!: () => void;
    fetchGate = new Promise((resolve) => (release = resolve));
    await proposeMigration(PROPOSAL);
    writeMigrateTarget({ label: 'Acme migrate, edited' });
    release();
    await vi.waitFor(() => expect(notes().at(-1)).toContain('config changed while the request was being checked'));
    expect(await getPendingApprovalsByAction(APPROVED_RUN_ACTION)).toHaveLength(0);
  });

  it('an admin of the group who is not a named approver may not answer', async () => {
    await proposeMigration(PROPOSAL);
    expect(await canAnswerApproval(await cardShown(), OTHER_ADMIN)).toBe(false);
  });

  it('Run it applies the file once, and a second press while it runs applies nothing more', async () => {
    let release!: () => void;
    statementStall = new Promise((resolve) => (release = resolve));
    await proposeMigration(PROPOSAL);
    const card = await cardShown();
    await resolveChoice(card, 'run', ALICE);
    await vi.waitFor(() => expect(applies).toHaveLength(1));
    await resolveChoice(card, 'run', BOB);
    release();
    await runsSettled();
    expect(applies).toHaveLength(1);
    expect(applies[0][applies[0].indexOf('--target') + 1]).toBe('app');
    expect(renderCalls).toEqual([
      ['approved-run-acme-app', 'GET /v1/postgres/dpg-aaaaaaaaaaaaaaaaaaaa/connection-info'],
    ]);
    expect(posts().at(-1)).toMatch(/^Approved by Alice\./);
  });

  it('logs a migration whose file failed as stopped there, not done', async () => {
    const info = vi.spyOn(log, 'info');
    try {
      vi.mocked(docker).mockResolvedValue({
        code: 1,
        timedOut: false,
        overflowed: false,
        stdout: '',
        stderr: 'connection lost',
      });
      await proposeMigration(PROPOSAL);
      await resolveChoice(await cardShown(), 'run', ALICE);
      await runsSettled();
      await vi.waitFor(() =>
        expect(info).toHaveBeenCalledWith(
          'Approved migration executed',
          expect.objectContaining({ result: 'stopped at step 1 of 1 (failed)' }),
        ),
      );
    } finally {
      info.mockRestore();
    }
  });
});

describe('targets by identity', () => {
  const file = () => path.join(RUN_DIR, 'targets.json');

  it('finds every valid target that runs as an identity, a migration through any of its databases', () => {
    const migrate = migrateTargetConfig([ALICE]);
    fs.writeFileSync(
      file(),
      JSON.stringify({ targets: [JSON.parse(fs.readFileSync(file(), 'utf8')).targets[0], migrate, { id: 'broken' }] }),
    );
    expect(targetsUsing('approved-run-acme', file()).map((t) => t.id)).toEqual(['acme-snowflake']);
    const migrateAgent = Object.values(migrate.databases as Record<string, { onecliAgent: string }>)[0].onecliAgent;
    expect(targetsUsing(migrateAgent, file()).map((t) => t.id)).toEqual([migrate.id]);
    expect(targetsUsing('approved-run-nobody', file())).toEqual([]);
  });

  it.each([
    ['a missing config', null],
    ['a config that is not JSON', '{'],
    ['a config with no target list', '{"targets":{}}'],
  ])('finds nothing in %s', (_name, body) => {
    if (body === null) fs.rmSync(file(), { force: true });
    else fs.writeFileSync(file(), body);
    expect(targetsUsing('approved-run-acme', file())).toEqual([]);
  });
});
