/**
 * Deliver one host-ops alert with a VERIFIED receipt, depending on neither the nanoclaw-v2 host nor the OneCLI
 * gateway. `data/cli.sock` cannot do this: it queues an inbound message whose reply needs a container spawn, which is
 * refused while the gateway is down, and `sendall()` reports success regardless. CLI: scripts/notify-owner.ts; exit 0
 * delivered, 2 cannot try (no owner DM, non-Slack, no token), 1 tried and failed. A token value is NEVER printed or
 * logged.
 */
import path from 'path';
import { fileURLToPath } from 'url';

import Database from 'better-sqlite3';

import { readEnvValue } from './env-file.js';
import { botTokenKeyForChannelType, slackPostMessage } from './channels/slack-lib.js';
import { extractSlackChannelId } from './channels/slack.js';
import { formatLocalStamp, isValidTimezone } from './timezone.js';
import { discordApiBase, discordBotTokenKey, isDiscordChannelType } from './discord-bot.js';

/**
 * From THIS FILE's location, not `src/config.ts`'s cwd-derived paths: invoked from elsewhere, an alerting primitive
 * would read another install's DB and exit 2 exactly when the alert matters.
 */
export const INSTALL_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
export const OWNER_DB_PATH = path.join(INSTALL_ROOT, 'data', 'v2.db');

const ALERT_CHANNEL_KEY = 'OPERATOR_ALERT_CHANNEL';
const DISCORD_CONTENT_LIMIT = 2000;
const DISCORD_POST_TIMEOUT_MS = 15_000;

interface OwnerDm {
  platformId: string;
  channelType: string;
}

function resolveAlertChannel(dbPath: string, messagingGroupId: string): OwnerDm | undefined {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare(`SELECT platform_id AS platformId, channel_type AS channelType FROM messaging_groups WHERE id = ?`)
      .get(messagingGroupId) as OwnerDm | undefined;
  } finally {
    db.close();
  }
}

async function discordPostMessage(token: string, channelId: string, content: string): Promise<void> {
  const base = discordApiBase();
  const res = await fetch(`${base}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: content.slice(0, DISCORD_CONTENT_LIMIT), allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(DISCORD_POST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`discord channel message failed: HTTP ${res.status}`);
}

async function postToAlertChannel(
  dbPath: string,
  rootDir: string,
  messagingGroupId: string,
  title: string,
  body: string,
  stamp: string,
): Promise<NotifyResult> {
  let channel: OwnerDm | undefined;
  try {
    channel = resolveAlertChannel(dbPath, messagingGroupId);
  } catch (err) {
    return { code: 2, message: `could not read messaging group: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!channel) return { code: 2, message: 'no such messaging group' };

  const discord = isDiscordChannelType(channel.channelType);
  if (!discord && !isSlackChannelType(channel.channelType)) {
    return { code: 2, message: `${channel.channelType} is not a platform this script can post to` };
  }
  const key = discord ? discordBotTokenKey(channel.channelType) : botTokenKeyForChannelType(channel.channelType);
  let token: string | undefined;
  try {
    token = readEnvValue(rootDir, key);
  } catch {
    return { code: 2, message: `could not read ${key}` };
  }
  if (!token) return { code: 2, message: `no ${key} configured` };

  const channelId = discord ? channel.platformId.split(':').pop()! : extractSlackChannelId(channel.platformId);
  try {
    if (discord) await discordPostMessage(token, channelId, `**${title}** (${stamp})\n\n${body}`);
    else await slackPostMessage(token, channelId, `*${title}* (${stamp})\n\n${body}`, 'notify-owner');
  } catch (err) {
    // fetch rejects a malformed header value (e.g. an embedded newline) by quoting the whole value.
    const message = err instanceof Error ? err.message : String(err);
    return { code: 1, message: message.split(token).join('[redacted]') };
  }
  return { code: 0, message: `delivered to ${channel.channelType}:${channelId}` };
}

/** Every owner DM, newest first: one unusable row (non-Slack, no token) must not silence the alert. Read-only. */
function resolveOwnerDms(dbPath: string): OwnerDm[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare(
        `SELECT mg.platform_id AS platformId, ud.channel_type AS channelType
           FROM user_roles ur
           JOIN user_dms ud ON ud.user_id = ur.user_id
           JOIN messaging_groups mg ON mg.id = ud.messaging_group_id
          WHERE ur.role = 'owner'
          ORDER BY ud.resolved_at DESC`,
      )
      .all() as OwnerDm[];
  } finally {
    db.close();
  }
}

/** The install timezone from THIS install's `.env`, with `resolveConfigTimezone`'s precedence and validator. */
function resolveInstallTimezone(rootDir: string): string {
  const candidates = [process.env.TZ, readEnvValue(rootDir, 'TZ'), Intl.DateTimeFormat().resolvedOptions().timeZone];
  for (const tz of candidates) if (tz && isValidTimezone(tz)) return tz;
  return 'UTC';
}

function isSlackChannelType(channelType: string): boolean {
  return channelType === 'slack' || channelType.startsWith('slack-');
}

export interface NotifyResult {
  code: 0 | 1 | 2;
  message: string;
}

export interface NotifyOwnerOptions {
  title: string;
  body: string;
  dbPath?: string;
  rootDir?: string;
  timezone?: string;
  now?: Date;
}

/** Never throws: every failure mode returns a NotifyResult. */
export async function notifyOwner(opts: NotifyOwnerOptions): Promise<NotifyResult> {
  const dbPath = opts.dbPath ?? OWNER_DB_PATH;
  const rootDir = opts.rootDir ?? INSTALL_ROOT;
  const timezone = opts.timezone ?? resolveInstallTimezone(rootDir);
  const now = opts.now ?? new Date();
  const stamp = formatLocalStamp(now, timezone);

  let alertChannelId: string | undefined;
  try {
    alertChannelId = readEnvValue(rootDir, ALERT_CHANNEL_KEY);
  } catch {
    alertChannelId = undefined;
  }
  if (!alertChannelId) return notifyOwnerDm(opts, dbPath, rootDir, stamp);

  const channel = await postToAlertChannel(dbPath, rootDir, alertChannelId, opts.title, opts.body, stamp);
  if (channel.code === 0) return channel;
  const dm = await notifyOwnerDm(opts, dbPath, rootDir, stamp);
  return {
    code: dm.code === 0 ? 0 : channel.code === 1 || dm.code === 1 ? 1 : 2,
    message: `${ALERT_CHANNEL_KEY}=${alertChannelId} failed (${channel.message}); owner DM: ${dm.message}`,
  };
}

async function notifyOwnerDm(
  opts: NotifyOwnerOptions,
  dbPath: string,
  rootDir: string,
  stamp: string,
): Promise<NotifyResult> {
  let owners: OwnerDm[];
  try {
    owners = resolveOwnerDms(dbPath);
  } catch (err) {
    return {
      code: 2,
      message: `could not read the owner DM from ${dbPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (owners.length === 0) return { code: 2, message: 'no owner DM resolved in user_dms — nobody to notify' };

  let owner: OwnerDm | undefined;
  let token: string | undefined;
  const skipped: string[] = [];
  for (const candidate of owners) {
    if (!isSlackChannelType(candidate.channelType)) {
      skipped.push(`${candidate.channelType} (not a platform this script can post to)`);
      continue;
    }
    const key = botTokenKeyForChannelType(candidate.channelType);
    const value = readEnvValue(rootDir, key);
    if (!value) {
      skipped.push(`${candidate.channelType} (no ${key} configured)`);
      continue;
    }
    owner = candidate;
    token = value;
    break;
  }
  if (!owner || !token) {
    return {
      code: 2,
      message: `no reachable owner DM among ${owners.length} candidate(s): ${skipped.join('; ')}`,
    };
  }

  const channelId = extractSlackChannelId(owner.platformId);
  const text = `*${opts.title}* (${stamp})\n\n${opts.body}`;

  try {
    await slackPostMessage(token, channelId, text, 'notify-owner');
  } catch (err) {
    return { code: 1, message: err instanceof Error ? err.message : String(err) };
  }

  return { code: 0, message: `delivered to ${owner.channelType}:${channelId}` };
}
