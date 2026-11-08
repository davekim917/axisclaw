/**
 * A scheduled fire whose pre-task script answers wakeAgent:false needs no agent. Run the batch's scripts before the
 * agent boots, so a non-waking fire skips the provider, its MCP servers, Codex plugin registration and the idle wait
 * for the reaper, and the container exits. Anything else in the batch, or arriving while the scripts run, takes the
 * normal boot.
 *
 * A script here runs before the boot's agent-facing setup: Codex fails closed instead of getting the guarded runtime
 * home, there is no Claude review socket, and the Claude credential is the spawn's primary, not a rotated slot.
 */
import { evaluateAdmission } from '../admission-gate.js';
import { trustGatewayCaForChromium } from '../browser-trust.js';
import { FAILED_CODEX_HOME } from '../codex-home-sentinel.js';
import { clearStaleProcessingAcks } from '../db/container-state.js';
import { getPendingMessages, type MessageInRow } from '../db/messages-in.js';
import { activateGcpServiceAccount } from '../gcp-auth-setup.js';
import { getWorkContinuation } from '../modules/mailbox/index.js';
import { isAdmissibleTrigger, pollableRows } from '../pending-batch.js';
import { snapshotWorktrees, type WorktreeBaseline } from '../worktree-in-flight.js';
import { carryWokenTasks, gateBatchScripts } from './task-script.js';

/** Set when the gate ran scripts and the agent must still boot. */
export interface AfterGateScripts {
  /** Taken before the scripts, so their writes are never attributed to the agent. */
  worktreeBaseline: WorktreeBaseline | null;
}

export type EarlyGateResult = { exit: true } | { exit: false; afterScripts?: AfterGateScripts };

function isContainerScriptTask(m: MessageInRow): boolean {
  if (m.kind !== 'task') return false;
  try {
    const content = JSON.parse(m.content) as Record<string, unknown>;
    return typeof content.script === 'string' && content.script !== '' && content.scriptOutput === undefined;
  } catch {
    return false;
  }
}

/** Every trigger is a task whose script runs in this container: anything else needs the agent whatever it answers. */
function isGatedFireBatch(messages: MessageInRow[]): boolean {
  const triggers = messages.filter((m) => m.trigger === 1 && m.kind !== 'system');
  return triggers.length > 0 && triggers.every(isContainerScriptTask);
}

/**
 * Before the full boot nothing has set CODEX_HOME, and an unset one runs `codex` against the staged home, without the
 * runtime's config or plugin hooks.
 */
async function withFailClosedCodexHome<T>(run: () => Promise<T>): Promise<T> {
  if (process.env.CODEX_HOME !== undefined) return run();
  process.env.CODEX_HOME = FAILED_CODEX_HOME;
  try {
    return await run();
  } finally {
    delete process.env.CODEX_HOME;
  }
}

/** Not a first poll: the gate's read was this container's, so an `on_wake` row written since is the replacement's. */
function needsAgent(): boolean {
  if (evaluateAdmission()) return true;
  if (getWorkContinuation() !== undefined) return true;
  return pollableRows(getPendingMessages(false)).some((m) => m.trigger === 1);
}

export interface EarlyGateDeps {
  log: (msg: string) => void;
  snapshot?: () => Promise<WorktreeBaseline | null>;
}

/** Expects a started mailbox. `exit: true` means every trigger was a task its script gated and nothing else is due. */
export async function runEarlyTaskGate(deps: EarlyGateDeps): Promise<EarlyGateResult> {
  const { log } = deps;
  // The poll loop clears these too; a crashed predecessor's claim must reappear here, or its row is never seen.
  clearStaleProcessingAcks();
  if (evaluateAdmission() || getWorkContinuation() !== undefined) return { exit: false };

  const batch = pollableRows(getPendingMessages(true));
  if (!isGatedFireBatch(batch)) return { exit: false };

  activateGcpServiceAccount(log);
  trustGatewayCaForChromium({ log });
  const afterScripts = { worktreeBaseline: await (deps.snapshot ?? (() => snapshotWorktrees(undefined, { log })))() };
  const { keep } = await withFailClosedCodexHome(() => gateBatchScripts(batch));
  carryWokenTasks(keep);
  if (keep.some(isAdmissibleTrigger)) return { exit: false, afterScripts };

  // A script can run for minutes; whatever arrived meanwhile gets the agent.
  if (needsAgent()) return { exit: false, afterScripts };
  log(`Gated task fire: nothing woke and nothing else is due; exiting before the agent boots`);
  return { exit: true };
}
