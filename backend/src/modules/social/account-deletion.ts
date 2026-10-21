import { pool } from '../../db/pool.js';
import { getIO } from '../realtime/server.js';
import { invalidateGroupMembersCache, invalidateUserDeviceCache } from '../realtime/cache.js';

/** Delete one account and its server data as one database transaction. */
export async function deleteAccount(userId: string): Promise<boolean> {
  const client = await pool.connect();
  const affectedGroups: string[] = [];
  try {
    await client.query('BEGIN');
    const groups = await client.query<{ id: string; successorId: string | null }>(
      `SELECT g.id, (SELECT m."userId" FROM "chat_group_member" m
        WHERE m."groupId" = g.id AND m."userId" <> $1
        ORDER BY m."joinedAt", m."userId" LIMIT 1) AS "successorId"
       FROM "chat_group" g WHERE g."ownerId" = $1 FOR UPDATE`, [userId]);
    for (const group of groups.rows) {
      affectedGroups.push(group.id);
      if (group.successorId) {
        await client.query('UPDATE "chat_group" SET "ownerId" = $2 WHERE id = $1', [group.id, group.successorId]);
        await client.query('UPDATE "chat_group_member" SET role = $2 WHERE "groupId" = $1 AND "userId" = $3',
          [group.id, 'admin', group.successorId]);
      }
    }

    await client.query(
      `INSERT INTO media_object_deletion ("objectKey")
       SELECT "objectKey" FROM chat_media WHERE "ownerId" = $1 ON CONFLICT DO NOTHING`, [userId]);
    // These legacy device references lack ON DELETE CASCADE and can belong to
    // messages sent by other users to this account's devices.
    await client.query(
      `DELETE FROM chat_pending_key WHERE "recipientDeviceId" IN
       (SELECT id FROM chat_device WHERE "userId" = $1)`, [userId]);
    await client.query(
      `DELETE FROM chat_receipt_event WHERE "recipientDeviceId" IN
       (SELECT id FROM chat_device WHERE "userId" = $1)`, [userId]);
    const deleted = await client.query('DELETE FROM "user" WHERE id = $1', [userId]);
    await client.query('COMMIT');
    invalidateUserDeviceCache(userId);
    for (const id of affectedGroups) invalidateGroupMembersCache(id);
    getIO()?.in(`user:${userId}`).disconnectSockets(true);
    return deleted.rowCount === 1;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
