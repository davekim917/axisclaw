/**
 * Canonical scope for the one choice-card meaning owned by the host: a human
 * release authorization.  The runner has an equivalent transport validator,
 * but every authority decision and receipt write re-validates through here.
 */

export interface ReleaseShipScope {
  purpose: 'release_ship';
  repository: string;
  pullRequest: number;
  base: string;
  headSha: string;
  /** The release-policy hold codes this card's Go accepts at this head; absent accepts none. */
  holds?: string[];
}

const REPOSITORY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
// Intentionally reject ASCII controls, including those not covered by whitespace.
// eslint-disable-next-line no-control-regex
const BASE_RE = /^[^\s\x00-\x1F\x7F]{1,255}$/;
const HEAD_RE = /^[a-f0-9]{40}$/;
const KEYS = ['purpose', 'repository', 'pullRequest', 'base', 'headSha'] as const;
const OPTIONAL_KEYS = ['holds'] as const;
const HOLD_RE = /^hold:[A-Za-z0-9_.:/@+-]{1,160}$/;
const MAX_SCOPE_HOLDS = 24;

/** Return a host-canonical scope or a deliberately non-specific validation error. */
export function parseReleaseShipScope(value: unknown): ReleaseShipScope | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const allowed: readonly string[] = [...KEYS, ...OPTIONAL_KEYS];
  if (keys.some((key) => !allowed.includes(key)) || KEYS.some((key) => !keys.includes(key))) return undefined;
  if (record.purpose !== 'release_ship') return undefined;
  if (typeof record.repository !== 'string' || !REPOSITORY_RE.test(record.repository)) return undefined;
  if (typeof record.pullRequest !== 'number' || !Number.isSafeInteger(record.pullRequest) || record.pullRequest <= 0) {
    return undefined;
  }
  if (typeof record.base !== 'string' || !BASE_RE.test(record.base)) return undefined;
  if (typeof record.headSha !== 'string' || !HEAD_RE.test(record.headSha)) return undefined;
  const holds = parseHolds(record.holds);
  if (holds === null) return undefined;
  return {
    purpose: 'release_ship',
    repository: record.repository,
    pullRequest: record.pullRequest,
    base: record.base,
    headSha: record.headSha,
    ...(holds ? { holds } : {}),
  };
}

function parseHolds(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_SCOPE_HOLDS) return null;
  if (!value.every((code) => typeof code === 'string' && HOLD_RE.test(code))) return null;
  const unique = [...new Set(value as string[])].sort();
  return unique.length === value.length ? unique : null;
}

/** Stable key order makes the durable field deterministic and cross-language friendly. */
function releaseShipScopeJson(scope: ReleaseShipScope): string {
  return JSON.stringify({
    purpose: scope.purpose,
    repository: scope.repository,
    pullRequest: scope.pullRequest,
    base: scope.base,
    headSha: scope.headSha,
    ...(scope.holds ? { holds: scope.holds } : {}),
  });
}

const SHIP_ANYWAY = 'Ship anyway — I accept ';

export function warningOptions(accept: string): Array<{ label: string; value: string; style: 'primary' | 'danger' }> {
  return [
    { label: `${SHIP_ANYWAY}${accept}`, value: 'ship', style: 'danger' },
    { label: 'Send back', value: 'send_back', style: 'primary' },
  ];
}

export const RELEASE_OPTIONS: Array<{ label: string; value: string; style: 'primary' | 'danger' }> = [
  { label: 'Ship release', value: 'ship', style: 'primary' },
  { label: 'Hold', value: 'hold', style: 'danger' },
];

function releaseCardKind(options: unknown): 'warning' | 'release' | undefined {
  if (!Array.isArray(options) || options.length !== 2) return undefined;
  const [a, b] = options as Array<{ label?: unknown; value?: unknown }>;
  const warning =
    a?.value === 'ship' &&
    typeof a.label === 'string' &&
    a.label.startsWith(SHIP_ANYWAY) &&
    b?.value === 'send_back' &&
    b.label === 'Send back';
  const release = RELEASE_OPTIONS.every((o, i) => options[i]?.label === o.label && options[i]?.value === o.value);
  return warning ? 'warning' : release ? 'release' : undefined;
}

/**
 * The canonical scope a click on this card carries, or undefined. A card posted
 * before warning cards existed (a bare Ship / Hold) carries none, so its click
 * never counts as a release decision; neither does a corrupt stored row.
 */
export function cardReleaseScopeJson(approval: { payload: string; options_json: string }): string | undefined {
  try {
    const scope = parseReleaseShipScope((JSON.parse(approval.payload) as { approvalScope?: unknown }).approvalScope);
    const kind = releaseCardKind(JSON.parse(approval.options_json));
    if (!scope || !kind || (kind === 'warning' && !scope.holds?.length)) return undefined;
    return releaseShipScopeJson(scope);
    // eslint-disable-next-line no-catch-all/no-catch-all -- a corrupt stored row is unscoped, never an authority grant
  } catch {
    return undefined;
  }
}

export function unscopedReleaseCard(approval: { payload: string; options_json: string }): boolean {
  if (cardReleaseScopeJson(approval) !== undefined) return false;
  const payload = parsed(approval.payload);
  if (payload !== CORRUPT) return (payload as { approvalScope?: unknown } | null)?.approvalScope !== undefined;
  const options = parsed(approval.options_json);
  return options !== CORRUPT && releaseCardKind(options) !== undefined;
}

const CORRUPT = Symbol('corrupt');

function parsed(json: string): unknown {
  try {
    return JSON.parse(json);
    // eslint-disable-next-line no-catch-all/no-catch-all -- the caller decides what an unreadable field means
  } catch {
    return CORRUPT;
  }
}
