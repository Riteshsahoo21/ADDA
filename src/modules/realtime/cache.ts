import { pool } from '../../db/pool.js';

export type CachedDevice = { deviceId: string; userId: string; publicKey: string };

const deviceCache = new Map<string, { devices: CachedDevice[]; expiresAt: number }>();

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
      userMap.set(row.userId, list);
      results.push(dev);
    }

    for (const uid of missingUsers) {
      deviceCache.set(uid, {
        devices: userMap.get(uid) ?? [],
        expiresAt: now + 5 * 60 * 1000 // 5 minutes cache
      });
    }
  }

  return results;
}

export function invalidateUserDeviceCache(userId: string): void {
  deviceCache.delete(userId);
}
