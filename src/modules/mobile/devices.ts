import { createHash, randomBytes, randomUUID } from 'crypto';

import { getDb } from '../../db/connection.js';

const KEY_PREFIX = 'nca_';
const SEND_KEY_PREFIX = 'ncs_';

export interface MobileDevice {
  id: string;
  user_id: string;
  label: string | null;
  created_at: string;
}

const DEVICE_COLUMNS = 'id, user_id, label, created_at';

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** The key leaves here once, for the device that paired; the row keeps only its hash. */
export async function createDevice(userId: string, label: string | null): Promise<{ key: string; deviceId: string }> {
  const key = `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  const deviceId = randomUUID();
  await getDb().run(
    'INSERT INTO mobile_devices (id, user_id, key_hash, label, created_at) VALUES (?, ?, ?, ?, ?)',
    deviceId,
    userId,
    sha256(key),
    label,
    new Date().toISOString(),
  );
  return { key, deviceId };
}

export function findDeviceByKey(key: string): Promise<MobileDevice | undefined> {
  return getDb().get<MobileDevice>(`SELECT ${DEVICE_COLUMNS} FROM mobile_devices WHERE key_hash = ?`, sha256(key));
}

/** Only the send key opens a send, and it opens nothing else: each key is looked up in its own column. */
export function findDeviceBySendKey(key: string): Promise<MobileDevice | undefined> {
  return getDb().get<MobileDevice>(`SELECT ${DEVICE_COLUMNS} FROM mobile_devices WHERE send_key_hash = ?`, sha256(key));
}

export async function hasSendKey(deviceId: string): Promise<boolean> {
  const row = await getDb().get<{ held: number }>(
    'SELECT send_key_hash IS NOT NULL AS held FROM mobile_devices WHERE id = ?',
    deviceId,
  );
  return row?.held === 1;
}

export async function issueSendKey(deviceId: string): Promise<string | null> {
  const key = `${SEND_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  const result = await getDb().run('UPDATE mobile_devices SET send_key_hash = ? WHERE id = ?', sha256(key), deviceId);
  return result.changes > 0 ? key : null;
}

const anyOf = (userIds: string[]) => `user_id IN (${userIds.map(() => '?').join(', ')})`;

/** Everyone's when no user ids are named. */
export function listDevices(userIds?: string[]): Promise<MobileDevice[]> {
  return userIds
    ? getDb().all<MobileDevice>(
        `SELECT ${DEVICE_COLUMNS} FROM mobile_devices WHERE ${anyOf(userIds)} ORDER BY created_at DESC`,
        ...userIds,
      )
    : getDb().all<MobileDevice>(`SELECT ${DEVICE_COLUMNS} FROM mobile_devices ORDER BY created_at DESC`);
}

/** With user ids named, only a device of theirs goes; false says nothing about why no row matched. */
export async function deleteDevice(id: string, userIds?: string[]): Promise<boolean> {
  const result = userIds
    ? await getDb().run(`DELETE FROM mobile_devices WHERE id = ? AND ${anyOf(userIds)}`, id, ...userIds)
    : await getDb().run('DELETE FROM mobile_devices WHERE id = ?', id);
  return result.changes > 0;
}
