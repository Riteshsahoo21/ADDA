import { randomBytes } from 'node:crypto';
import { pool } from '../../db/pool.js';

export type PublicProfile = { id: string; username: string; name: string };
export type OwnProfile = PublicProfile & { friendCode: string };

function candidateUsername(name: string, id: string) {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9._]/g, '').replace(/^[._]+|[._]+$/g, '').slice(0, 20);
  return `${base || 'adda'}_${id.replace(/[^a-z0-9]/gi, '').slice(0, 6).toLowerCase()}`;
}

export async function ensureProfile(id: string): Promise<OwnProfile | null> {
  const existing = await pool.query<OwnProfile>(
    'SELECT id, name, username, "friendCode" FROM "user" WHERE id = $1', [id],
  );
  const user = existing.rows[0];
  if (!user) return null;
  if (user.username && user.friendCode) return user;
  const username = user.username || candidateUsername(user.name, id);
  const friendCode = user.friendCode || randomBytes(24).toString('hex');
  const result = await pool.query<OwnProfile>(
    'UPDATE "user" SET username = COALESCE(username, $2), "friendCode" = COALESCE("friendCode", $3) WHERE id = $1 RETURNING id, name, username, "friendCode"',
    [id, username, friendCode],
  );
  return result.rows[0];
}

export function validUsername(value: string) {
  return /^[a-z0-9._]{3,24}$/.test(value) && !/^[._]|[._]$/.test(value);
}
