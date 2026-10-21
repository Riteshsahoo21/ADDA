import { pool } from '../../db/pool.js';

export const POLICY_VERSION = '2026-10-20';

export async function hasAcceptedPolicy(userId: string): Promise<boolean> {
  const result = await pool.query<{ policyVersion: string | null }>(
    'SELECT "policyVersion" FROM "user" WHERE id = $1', [userId]);
  return result.rows[0]?.policyVersion === POLICY_VERSION;
}

export async function isBlockedPair(a: string, b: string): Promise<boolean> {
  const result = await pool.query(
    'SELECT 1 FROM user_block WHERE ("blockerId" = $1 AND "blockedId" = $2) OR ("blockerId" = $2 AND "blockedId" = $1) LIMIT 1',
    [a, b]);
  return (result.rowCount ?? 0) > 0;
}
