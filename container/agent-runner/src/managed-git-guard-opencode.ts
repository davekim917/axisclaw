import { writeFileSync } from 'fs';
import { join } from 'path';

import { guardManagedGitCommandOrThrow } from './managed-git-guard.js';

type ToolBeforeInput = { tool: string };
type ToolBeforeOutput = { args?: Record<string, unknown> };

// OpenCode calls every export of a plugin file as a plugin, so this file exports the plugin alone.
export const ManagedGitWorktreeGuard = async () => {
  const receipts = process.env.NANOCLAW_OPENCODE_PLUGIN_RECEIPTS;
  if (receipts) writeFileSync(join(receipts, 'managed-git-guard'), new Date().toISOString());
  return {
    'tool.execute.before': async (input: ToolBeforeInput, output: ToolBeforeOutput) => {
      if (input.tool !== 'bash') return;
      const command = output.args?.command;
      if (typeof command === 'string') guardManagedGitCommandOrThrow(command);
    },
  };
};
