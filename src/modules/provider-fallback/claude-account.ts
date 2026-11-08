/**
 * A Claude container reports the fingerprint of the OAuth token it is rotating off at an account-wide limit. The
 * mark is taken only for a token this group still forwards: a container spawned before a token was replaced in `.env`
 * reports the old one, and must not mark its replacement.
 */
import { claudeOauthSlots, claudeTokenFingerprint, markClaudeAccountSpent } from '../../claude-accounts.js';
import { readContainerConfig } from '../../container-config.js';
import { resolveAnthropicAuth } from '../../container-runner.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { readEnvFileMatching } from '../../env.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';

export async function handleClaudeAccountExhausted(content: Record<string, unknown>, session: Session): Promise<void> {
  const slot = typeof content.slot === 'string' ? content.slot : null;
  const fingerprint = typeof content.fingerprint === 'string' ? content.fingerprint : null;
  const resetAt = typeof content.resetAt === 'string' ? content.resetAt : null;
  const agentGroup = await getAgentGroup(session.agent_group_id);
  if (!slot || !fingerprint || !agentGroup) return;

  const containerConfig = readContainerConfig(agentGroup.folder);
  const auth = resolveAnthropicAuth(
    containerConfig.credentialFolder ?? agentGroup.folder,
    process.env,
    readEnvFileMatching(/^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)(_|$)/),
  );
  const forwarded = claudeOauthSlots(auth).some((entry) => claudeTokenFingerprint(entry.value) === fingerprint);
  if (!forwarded) {
    log.warn('claude_account_exhausted: rejected — not a token this group still forwards', {
      sessionId: session.id,
      agentGroup: agentGroup.name,
      slot,
    });
    return;
  }
  const until = markClaudeAccountSpent(fingerprint, resetAt);
  log.warn('Claude account at its limit — new containers start past it until the mark ends', {
    sessionId: session.id,
    agentGroup: agentGroup.name,
    slot,
    until: new Date(until).toISOString(),
  });
}
