/**
 * Writing a reserved token (`src/reserved-secrets.ts`): it counts as stored only once its agent holds it and no other
 * agent can be injected it. A new token that fails that is removed again, so it never sits in the vault half-granted.
 * The value is never logged, returned or put in an error.
 */
import { tokenHeldOnlyBy } from './modules/approved-run/execute.js';
import { agentsHoldingSecret, ensureOnecliAgent, grantOnecliSecretToAgent } from './onecli-secrets.js';
import {
  createOnecliSecret,
  deleteOnecliSecret,
  findOnecliSecretByName,
  findOnecliSecretsByName,
  updateOnecliSecretValue,
  type OnecliInjectionSpec,
  type OnecliSecretRef,
} from './onecli-secret-writer.js';
import { isReservedAgent, reservedTokenName } from './reserved-secrets.js';

/** The write may have gone through: only a look at the vault, or fixing a grant, settles what is live. */
export class ReservedTokenMayBeLive extends Error {}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function soleHolder(agent: string): Promise<void> {
  const problem = await tokenHeldOnlyBy(agentsHoldingSecret, reservedTokenName(agent), agent);
  if (problem) throw new Error(problem);
}

function removal(id: string): Promise<string> {
  return deleteOnecliSecret(id).then(
    () => 'it was removed from the vault',
    (err: unknown) => `removing it also failed (${messageOf(err)}); delete it by hand`,
  );
}

/** Only a reserved agent's own token is written here, so no write reaches an agent group's identity or its secrets. */
function assertTokenName(agent: string, name: string): void {
  if (!isReservedAgent(agent)) throw new Error(`${agent} is not a reserved agent`);
  if (name !== reservedTokenName(agent)) throw new Error(`"${name}" is not ${agent}'s token name`);
}

/** For a name the caller has just seen absent from the vault. */
export async function createReservedToken(agent: string, injection: OnecliInjectionSpec, value: string): Promise<void> {
  assertTokenName(agent, injection.name);
  let ref: OnecliSecretRef;
  try {
    ref = await createOnecliSecret(injection, value);
  } catch (err) {
    // The vault may have kept a create whose answer was lost; nothing by this name existed a moment ago.
    let leftover: OnecliSecretRef | undefined;
    try {
      leftover = await findOnecliSecretByName(injection.name);
    } catch (lookupErr) {
      throw new ReservedTokenMayBeLive(
        `${messageOf(err)}; the vault may have kept it, and checking failed (${messageOf(lookupErr)}): look for "${injection.name}" and delete it by hand`,
        { cause: err },
      );
    }
    if (!leftover) throw err;
    throw new Error(`${messageOf(err)}; ${await removal(leftover.id)}`, { cause: err });
  }
  try {
    await ensureOnecliAgent({ name: agent, identifier: agent });
    await grantOnecliSecretToAgent(agent, ref);
    await soleHolder(agent);
  } catch (err) {
    throw new Error(`${messageOf(err)}; ${await removal(ref.id)}`, { cause: err });
  }
}

/**
 * Replaces the value, and with `match` moves the token's host and path to it. Checked before the write too, so a stray
 * holder never receives the new one.
 */
export async function rotateReservedToken(
  agent: string,
  existing: OnecliSecretRef,
  value: string,
  match?: Pick<OnecliInjectionSpec, 'hostPattern' | 'pathPattern'>,
): Promise<void> {
  assertTokenName(agent, existing.name);
  await soleHolder(agent);
  await updateOnecliSecretValue(existing, value, match);
  try {
    await soleHolder(agent);
  } catch (err) {
    throw new ReservedTokenMayBeLive(
      `the new value is stored, but ${messageOf(err)}; approved runs refuse until it is fixed`,
      { cause: err },
    );
  }
}

const writing = new Map<string, Promise<void>>();

/**
 * Runs `write` once every earlier write for this agent has settled. A lookup and the write it decides cross awaits, so
 * any writer that checks the vault before writing goes through here.
 */
export function writeReservedTokenAlone<T>(agent: string, write: () => Promise<T>): Promise<T> {
  const next = (writing.get(agent) ?? Promise.resolve()).then(write);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  writing.set(agent, settled);
  void settled.then(() => {
    if (writing.get(agent) === settled) writing.delete(agent);
  });
  return next;
}

/** Creates the token, or replaces the value of the one already there and moves it to the injection's host and path. */
export function putReservedToken(agent: string, injection: OnecliInjectionSpec, value: string): Promise<void> {
  return writeReservedTokenAlone(agent, async () => {
    const copies = await findOnecliSecretsByName(injection.name);
    if (copies.length > 1) {
      throw new Error(`${copies.length} vault entries are named "${injection.name}"; leave exactly one`);
    }
    if (copies.length === 1) await rotateReservedToken(agent, copies[0], value, injection);
    else await createReservedToken(agent, injection, value);
  });
}
