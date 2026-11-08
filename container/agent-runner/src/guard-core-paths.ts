/**
 * Where the shared guard cores live. Never read from the environment: the Codex guard hook runs with the env of
 * whoever started codex, so an env override would let that caller load a stub in place of the guard.
 */
const GUARD_CORE_DIR = '/workspace/plugins/bootstrap/plugins/workflow-agents/hooks/guards';

export interface GuardCorePaths {
  /** `file-protection-core.ts` is loaded from this file's directory. */
  destructive: string;
  emailGate: string;
}

const INSTALLED: GuardCorePaths = Object.freeze({
  destructive: `${GUARD_CORE_DIR}/block-destructive-core.ts`,
  emailGate: `${GUARD_CORE_DIR}/email-gate-core.ts`,
});

let testOverrides: Partial<GuardCorePaths> = {};

export function guardCorePaths(): GuardCorePaths {
  return { ...INSTALLED, ...testOverrides };
}

/** Test seam. In-process state, so a caller outside the process (the hook's env, argv or cwd) cannot reach it. */
export function setGuardCorePathsForTest(overrides: Partial<GuardCorePaths>): void {
  testOverrides = { ...testOverrides, ...overrides };
}

export function resetGuardCorePathsForTest(): void {
  testOverrides = {};
}
