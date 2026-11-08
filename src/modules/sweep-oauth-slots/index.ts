/**
 * Sweep duty: once a day, ask the API whether each CLAUDE_CODE_OAUTH_TOKEN* in .env is still accepted, and tell the
 * owner about a refused one by slot NAME. A runner skips a refused slot and moves on, so nothing else would surface
 * the lost capacity. Only a 401 counts: a network failure, 5xx or 429 says nothing about the token. A token value is
 * never logged, stored or sent anywhere but as its own bearer to the API.
 */
import fs from 'fs';
import path from 'path';

import { Agent, fetch as undiciFetch } from 'undici';

import { DATA_DIR } from '../../config.js';
import { readEnvFileMatching } from '../../env.js';
import { DEFAULT_HAIKU_MODEL } from '../../flag-parser.js';
import { registerSweepDuty, registerSweepDutySource, SWEEP_DUTY_INVENTORY } from '../../host-sweep.js';
import { log } from '../../log.js';
import { notifyOwner } from '../../notify-owner.js';

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RETRY_INTERVAL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const COUNT_TOKENS_URL = 'https://api.anthropic.com/v1/messages/count_tokens';
const OAUTH_SLOT_RE = /^CLAUDE_CODE_OAUTH_TOKEN(_|$)/;
const ONECLI_PLACEHOLDER = 'placeholder';

// An explicit dispatcher, so no proxy env applies: OneCLI's proxy would swap this bearer for its own vault entry and
// the answer would be about that credential instead.
const direct = new Agent();

function statePath(): string {
  return path.join(DATA_DIR, 'oauth-slot-health.json');
}

export async function probeOAuthToken(token: string): Promise<number | null> {
  try {
    const response = await undiciFetch(COUNT_TOKENS_URL, {
      method: 'POST',
      dispatcher: direct,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: DEFAULT_HAIKU_MODEL, messages: [{ role: 'user', content: 'ok' }] }),
    });
    await response.body?.cancel();
    return response.status;
    // eslint-disable-next-line no-catch-all/no-catch-all -- an unreachable API is an unknown result, retried tomorrow
  } catch {
    return null;
  }
}

export interface OAuthSlotCheckDeps {
  slots: () => Record<string, string>;
  probe: (token: string) => Promise<number | null>;
  notify: (title: string, body: string) => Promise<boolean>;
}

export async function checkOAuthSlots(
  deps: OAuthSlotCheckDeps,
  alerted: readonly string[],
): Promise<{ alerted: string[]; delivered: boolean }> {
  const slots = Object.entries(deps.slots()).filter(([, token]) => token !== ONECLI_PLACEHOLDER);
  const standing = new Set(alerted.filter((name) => slots.some(([slot]) => slot === name)));
  let delivered = true;
  for (const [name, token] of slots) {
    const status = await deps.probe(token);
    if (status !== null && status >= 200 && status < 300) {
      standing.delete(name);
      continue;
    }
    if (status !== 401) {
      log.warn('OAuth slot check got no verdict', { slot: name, status });
      continue;
    }
    log.warn('OAuth slot was refused by the API', { slot: name });
    if (standing.has(name)) continue;
    const told = await deps.notify(
      'Claude token refused',
      `${name} in .env was refused with a 401, so that account is out of the rotation. Running sessions skip it and move to the next slot. Replace the token in .env; containers pick it up at their next spawn.`,
    );
    if (told) standing.add(name);
    else delivered = false;
  }
  return { alerted: [...standing], delivered };
}

interface SlotHealthState {
  nextCheckAt: string;
  alerted: string[];
}

/** Kept on disk: a host restarted more than daily would otherwise never reach the interval, and would re-alert. */
function readState(): SlotHealthState {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), 'utf8')) as Partial<SlotHealthState>;
    return { nextCheckAt: parsed.nextCheckAt ?? '', alerted: Array.isArray(parsed.alerted) ? parsed.alerted : [] };
    // eslint-disable-next-line no-catch-all/no-catch-all -- no readable state means check now, and at worst alert again
  } catch {
    return { nextCheckAt: '', alerted: [] };
  }
}

function writeState(state: SlotHealthState): void {
  const tmp = `${statePath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, statePath());
}

let state: SlotHealthState | undefined;
let running = false;

function registerOAuthSlotHealthDuty(): void {
  registerSweepDuty({
    name: SWEEP_DUTY_INVENTORY.FORK11,
    phase: 'tick:housekeeping',
    order: 139,
    run: () => {
      state ??= readState();
      if (running || Date.now() < Date.parse(state.nextCheckAt)) return;
      running = true;
      const current = state;
      // Detached: one request per slot must never hold the tick.
      void checkOAuthSlots(
        {
          slots: () => readEnvFileMatching(OAUTH_SLOT_RE),
          probe: probeOAuthToken,
          notify: async (title, body) => (await notifyOwner({ title, body })).code === 0,
        },
        current.alerted,
      )
        .then(({ alerted, delivered }) => {
          const wait = delivered ? CHECK_INTERVAL_MS : RETRY_INTERVAL_MS;
          state = { nextCheckAt: new Date(Date.now() + wait).toISOString(), alerted };
          writeState(state);
        })
        .catch((err) => {
          state = { ...current, nextCheckAt: new Date(Date.now() + RETRY_INTERVAL_MS).toISOString() };
          log.warn('OAuth slot check failed', { err });
        })
        .finally(() => {
          running = false;
        });
    },
  });
}

registerSweepDutySource('oauth-slot-health', registerOAuthSlotHealthDuty);
