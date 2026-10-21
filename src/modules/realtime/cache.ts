import { pool } from '../../db/pool.js';
import { isBlockedPair } from '../social/safety.js';

export type ChatTarget = { kind: 'direct' | 'group'; id: string };
export type CachedDevice = { deviceId: string; userId: string; publicKey: string };

const deviceCache = new Map<string, { devices: CachedDevice[]; expiresAt: number }>();
const devicePublicKeyCache = new Map<string, { publicKey: string; expiresAt: number }>();

export async function getRecipientDevices(userIds: string[]): Promise<CachedDevice[]> {
  const missingUsers: string[] = [];
  const results: CachedDevice[] = [];
  const now = Date.now();

  for (const uid of userIds) {
    const cached = deviceCache.get(uid);
    if (cached && cached.expiresAt > now) {
      results.push(...cached.devices);
    } else {
      missingUsers.push(uid);
    }
  }

  if (missingUsers.length > 0) {
    const dbRes = await pool.query<{ id: string; userId: string; publicKey: string }>(
      'SELECT id, "userId", "publicKey" FROM chat_device WHERE "userId" = ANY($1::text[]) AND "revokedAt" IS NULL',
      [missingUsers]
    );

    const userMap = new Map<string, CachedDevice[]>();
    for (const row of dbRes.rows) {
      const dev = { deviceId: row.id, userId: row.userId, publicKey: row.publicKey };
      const list = userMap.get(row.userId) ?? [];
      list.push(dev);
      results.push(dev);
      // Cache public key by deviceId
      devicePublicKeyCache.set(row.id, { publicKey: row.publicKey, expiresAt: now + 3600 * 1000 });
    }

    for (const uid of missingUsers) {
      deviceCache.set(uid, {
        devices: userMap.get(uid) ?? [],
        expiresAt: now + 30 * 1000 // 30 seconds cache (rapid key sync)
      });
    }
  }

  return results;
}

export function invalidateUserDeviceCache(userId: string): void {
  deviceCache.delete(userId);
}

export async function getDevicePublicKey(deviceId: string, userId: string): Promise<string | null> {
  const now = Date.now();
  const cached = devicePublicKeyCache.get(deviceId);
  if (cached && cached.expiresAt > now) {
    return cached.publicKey;
  }
  const dbRes = await pool.query<{ publicKey: string }>(
    'SELECT "publicKey" FROM chat_device WHERE id = $1 AND "userId" = $2 AND "revokedAt" IS NULL',
    [deviceId, userId]
  );
  if (!dbRes.rows[0]) return null;
  const key = dbRes.rows[0].publicKey;
  devicePublicKeyCache.set(deviceId, { publicKey: key, expiresAt: now + 3600 * 1000 });
  return key;
}

const groupMembersCache = new Map<string, { members: string[]; expiresAt: number }>();

export async function getCachedGroupMembers(groupId: string): Promise<string[]> {
  const now = Date.now();
  const cached = groupMembersCache.get(groupId);
  if (cached && cached.expiresAt > now) {
    return cached.members;
  }
  const dbRes = await pool.query<{ userId: string }>(
    'SELECT "userId" FROM "chat_group_member" WHERE "groupId" = $1',
    [groupId]
  );
  const members = dbRes.rows.map(r => r.userId);
  groupMembersCache.set(groupId, {
    members,
    expiresAt: now + 15 * 1000 // 15 seconds cache (rapid membership sync)
  });
  return members;
}

export function invalidateGroupMembersCache(groupId: string): void {
  groupMembersCache.delete(groupId);
}

const contactAccessCache = new Map<string, { allowed: boolean; expiresAt: number }>();

export async function checkCanAccessCached(userId: string, target: ChatTarget): Promise<boolean> {
  if (target.kind === 'group') {
    const members = await getCachedGroupMembers(target.id);
    return members.includes(userId);
  }
  const [a, b] = [userId, target.id].sort();
  const cacheKey = `${a}:${b}`;
  const now = Date.now();
  const cached = contactAccessCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.allowed;
  }
  if (await isBlockedPair(userId, target.id)) {
    contactAccessCache.set(cacheKey, { allowed: false, expiresAt: now + 30 * 1000 });
    return false;
  }
  const result = await pool.query('SELECT 1 FROM "contact" WHERE "userA" = $1 AND "userB" = $2', [a, b]);
  const allowed = result.rowCount === 1;
  contactAccessCache.set(cacheKey, { allowed, expiresAt: now + 60 * 1000 });
  return allowed;
}

export function invalidateContactAccessCache(userA: string, userB: string): void {
  const [a, b] = [userA, userB].sort();
  contactAccessCache.delete(`${a}:${b}`);
}

// In-memory deduplication of recent message IDs (5 min TTL)
const processedMessageIds = new Map<string, { senderId: string; timestamp: string; expiresAt: number }>();

export function isMessageProcessed(messageId: string): { senderId: string; timestamp: string } | null {
  const hit = processedMessageIds.get(messageId);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    processedMessageIds.delete(messageId);
    return null;
  }
  return { senderId: hit.senderId, timestamp: hit.timestamp };
}

export function markMessageProcessed(messageId: string, senderId: string, timestamp: string): void {
  if (processedMessageIds.size > 20000) {
    const now = Date.now();
    for (const [id, entry] of processedMessageIds) {
      if (entry.expiresAt < now) processedMessageIds.delete(id);
    }
  }
  processedMessageIds.set(messageId, {
    senderId,
    timestamp,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });
}

// In-memory tracker for delivery receipts to handle race condition where ACK arrives before DB spool commits
const deliveryAckTracker = new Map<string, number>(); // key: `${messageId}:${recipientId}` -> expiresAt

export function markDeliveryAcked(messageId: string, recipientId: string): void {
  if (deliveryAckTracker.size > 20000) {
    const now = Date.now();
    for (const [key, exp] of deliveryAckTracker) {
      if (exp < now) deliveryAckTracker.delete(key);
    }
  }
  deliveryAckTracker.set(`${messageId}:${recipientId}`, Date.now() + 60 * 1000);
}

export function isDeliveryAcked(messageId: string, recipientId: string): boolean {
  const exp = deliveryAckTracker.get(`${messageId}:${recipientId}`);
  if (!exp) return false;
  if (exp < Date.now()) {
    deliveryAckTracker.delete(`${messageId}:${recipientId}`);
    return false;
  }
  return true;
}
