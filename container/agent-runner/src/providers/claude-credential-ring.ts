/**
 * Reads a container's Claude credential slots from env. Every OAuth ring comes from here; the provider's forward-only
 * API-key pool keeps its own reading. SDK-free: the `claude` launcher imports it without the SDK on its path. The host
 * forwards only a group's own set under these names, so a ring built from env cannot leave it.
 */
export interface CredentialSlot {
  name: string;
  value: string;
  envName: CredentialFamily;
}

type CredentialFamily = 'ANTHROPIC_API_KEY' | 'CLAUDE_CODE_OAUTH_TOKEN';

function slotsFor(env: NodeJS.ProcessEnv, family: CredentialFamily): CredentialSlot[] {
  const fallback = family === 'ANTHROPIC_API_KEY' ? /^ANTHROPIC_API_KEY_(\d+)$/ : /^CLAUDE_CODE_OAUTH_TOKEN_(\d+)$/;
  const slots = [
    { name: family, value: env[family] ?? '', envName: family },
    ...Object.entries(env)
      .filter(([name, value]) => fallback.test(name) && typeof value === 'string' && value.length > 0)
      .sort(([left], [right]) => Number(left.match(fallback)![1]) - Number(right.match(fallback)![1]))
      .map(([name, value]) => ({ name, value: value!, envName: family })),
  ];
  const seen = new Set<string>();
  return slots.filter((slot) => {
    // OneCLI uses placeholder as an intentional non-credential sentinel.
    if (!slot.value || slot.value === 'placeholder' || seen.has(slot.value)) return false;
    seen.add(slot.value);
    return true;
  });
}

export function oauthCredentialRing(env: NodeJS.ProcessEnv): CredentialSlot[] {
  return slotsFor(env, 'CLAUDE_CODE_OAUTH_TOKEN');
}

/** The ring the CLI would authenticate from: a set API key wins over OAuth. */
export function activeCredentialRing(env: NodeJS.ProcessEnv): CredentialSlot[] {
  if (env.ANTHROPIC_API_KEY) return slotsFor(env, 'ANTHROPIC_API_KEY');
  return env.CLAUDE_CODE_OAUTH_TOKEN ? slotsFor(env, 'CLAUDE_CODE_OAUTH_TOKEN') : [];
}
