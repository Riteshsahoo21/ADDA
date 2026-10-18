import { pool } from './pool.js';
import { createAuthTablesSql } from './migrations/001_auth.js';
import { createSocialTablesSql } from './migrations/002_social.js';
import { createRealtimeTablesSql } from './migrations/003_realtime.js';
import { createFriendRequestTablesSql } from './migrations/004_friend_requests.js';
import { createPushDevicesSql } from './migrations/005_push_devices.js';
import { createEncryptedChatTablesSql } from './migrations/006_encrypted_chat.js';
import { createChatSpoolTableSql } from './migrations/007_chat_spool.js';
import { createGroupEnhancementsSql } from './migrations/008_group_enhancements.js';
import { ensureProfile } from '../modules/social/profile.js';

async function migrate() {
  console.log('[ADDA Migration] Connecting to PostgreSQL database...');
  try {
    await pool.query(createAuthTablesSql);
    await pool.query(createSocialTablesSql);
    await pool.query(createRealtimeTablesSql);
    await pool.query(createFriendRequestTablesSql);
    await pool.query(createPushDevicesSql);
    await pool.query(createEncryptedChatTablesSql);
    await pool.query(createChatSpoolTableSql);
    await pool.query(createGroupEnhancementsSql);
    const users = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE username IS NULL OR "friendCode" IS NULL');
    for (const user of users.rows) await ensureProfile(user.id);
    console.log('[ADDA Migration] Auth and social tables are ready.');
  } finally {
    await pool.end();
  }
}

migrate().catch((error: unknown) => {
  console.error('[ADDA Migration] Failed:', error);
  process.exitCode = 1;
});
