/**
 * Reserved OneCLI secrets, by naming rule: a secret named `<agent> token`, where `<agent>` is an `approved-run-*`
 * identifier, may be injected for that one agent and no other, and no container may run as any `approved-run-*`
 * agent. The rule is code, not configuration, so nothing a config file says, or fails to say, can release a token.
 */
const RESERVED_AGENT = /^approved-run-[a-z0-9][a-z0-9-]{0,62}$/;
const RESERVED_SECRET = /^(approved-run-[a-z0-9][a-z0-9-]{0,62}) token$/;

/** The one agent a secret is reserved to, or null when its name is not a reserved token's. */
export function reservedOwner(secretName: string): string | null {
  return RESERVED_SECRET.exec(secretName)?.[1] ?? null;
}

/** Whether an identifier belongs to the reserved family no container may run as. */
export function isReservedAgent(identifier: string): boolean {
  return RESERVED_AGENT.test(identifier);
}

/** The name a reserved agent's token must carry. */
export function reservedTokenName(agent: string): string {
  return `${agent} token`;
}
