/**
 * NanoClaw Agent Runner v2 — process entry.
 *
 * Boots the mailbox, runs the early task gate, and loads the agent (runner-main.ts) only when the gate leaves work
 * for it. Keep this file's static imports to what the gate needs: most container spawns are scheduled fires that
 * never wake an agent, and every module loaded here is paid for by each one.
 */
// Module barrel — loads registration modules, including the singular mailbox slot.
import './modules/index.js';
import { loadConfig } from './config.js';
import { getAgentMailbox, readMailboxContext } from './mailbox/index.js';
import { runEarlyTaskGate } from './scheduling/early-gate.js';

function log(msg: string): void {
  console.error(`[agent-runner] ${msg}`);
}

async function main(): Promise<void> {
  loadConfig();
  const mailbox = getAgentMailbox();
  await mailbox.start(await readMailboxContext());
  const gate = await runEarlyTaskGate({ log });
  if (gate.exit) {
    await mailbox.stop();
    process.exit(0);
  }
  const { runAgent } = await import('./runner-main.js');
  try {
    await runAgent({ afterScripts: gate.afterScripts });
  } finally {
    await mailbox.stop();
  }
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
