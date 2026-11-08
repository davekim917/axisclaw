/** Deliberately nonexistent: codex refuses to start on it instead of falling back to the default home. */
export const FAILED_CODEX_HOME = '/nonexistent/codex-runtime-setup-failed';

/** The peer-mode home a Claude or OpenCode container runs codex in, once its plugins are registered. */
export const RUNTIME_CODEX_DIR = '/home/node/.codex-runtime';
/** Written last by a complete deferred registration; its absence means the home is not ready for codex. */
export const PLUGINS_REGISTERED_MARKER = '.nanoclaw-plugins-registered';

/**
 * Nonexistent too: until the first codex call registers the plugins, a codex reached around the shim refuses to start
 * unless its caller names a CODEX_HOME itself, which every home in the container permits.
 */
export const PENDING_CODEX_HOME = '/nonexistent/codex-plugins-register-on-first-codex-call';
