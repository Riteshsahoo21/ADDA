import { createHmac, randomUUID } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import { auth } from '../auth/auth.js';
import { pool } from '../../db/pool.js';
import { ensureProfile, validUsername } from './profile.js';
import { getCachedSocialBundle, setCachedSocialBundle, invalidateSocialBundleCache } from './cache.js';
import { publishFriendUpdate, publishGroupUpdate, publishGroupRoomUpdate, getIO, publishPublicRoomsUpdate } from '../realtime/server.js';
import { groupRoomOwners, getShardPeerCount, deleteGroupRoomInstance, channel } from '../realtime/rooms.js';
import { canJoinCallMedia, callMediaKind } from '../realtime/calls.js';
import { sendRoomInvitePush } from '../realtime/push.js';
import { getCachedGroupMembers, invalidateGroupMembersCache } from '../realtime/cache.js';
import { env } from '../../config/env.js';
import { deleteAccount } from './account-deletion.js';
import { hasAcceptedPolicy, isBlockedPair, POLICY_VERSION } from './safety.js';

export const socialRoutes = Router();

const sessionCache = new Map<string, { userId: string; expiresAt: number }>();

const authenticated: RequestHandler = async (request, response, next) => {
  try {
    const authHeader = request.headers.authorization;
    const cookieHeader = request.headers.cookie;
    const cacheKey = authHeader || cookieHeader;
    if (cacheKey) {
      const cached = sessionCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        response.locals.userId = cached.userId;
        next();
        return;
      }
    }

    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value === 'string') headers.set(key, value);
    }
    const session = await auth.api.getSession({ headers });
    if (!session) { response.status(401).json({ error: 'Sign in to continue.' }); return; }

    if (cacheKey) {
      sessionCache.set(cacheKey, { userId: session.user.id, expiresAt: Date.now() + 60 * 1000 });
      if (sessionCache.size > 2000) {
        const now = Date.now();
        for (const [k, v] of sessionCache.entries()) {
          if (v.expiresAt <= now) sessionCache.delete(k);
        }
      }
    }

    response.locals.userId = session.user.id;
    next();
  } catch (error) { next(error); }
};

const run = (handler: RequestHandler): RequestHandler => (request, response, next) => {
  Promise.resolve(handler(request, response, next)).catch(next);
};

socialRoutes.use(authenticated);

// The API key and host credentials never leave this server. A short-lived
// MiroTalk URL is issued only to a user already present in an ADDA call/room.
socialRoutes.post('/mirotalk/join', run(async (request, response) => {
  const userId = response.locals.userId as string;
  const { kind, id } = request.body ?? {};
  if ((kind !== 'call' && kind !== 'room') || typeof id !== 'string' || id.length < 1 || id.length > 120) {
    response.status(400).json({ error: 'Invalid meeting.' }); return;
  }
  if (!env.mirotalkInternalUrl || !env.mirotalkPublicUrl || !env.mirotalkApiKey || !env.mirotalkHostUser || !env.mirotalkHostPassword) {
    response.status(503).json({ error: 'Meeting service is unavailable.' }); return;
  }
  const allowed = kind === 'call'
    ? canJoinCallMedia(id, userId)
    : [...(getIO()?.sockets.adapter.rooms.get(channel(id)) ?? [])]
      .some(socketId => getIO()?.sockets.sockets.get(socketId)?.data.userId === userId);
  if (!allowed) { response.status(403).json({ error: 'Join the ADDA call or room first.' }); return; }
  const meeting = `adda-${kind}-${Buffer.from(id).toString('base64url')}`;
  const query = {
    room: meeting,
    name: userId,
    audio: true,
    video: kind === 'call' && callMediaKind(id) === 'video',
    chat: false,
    notify: false,
    token: { username: env.mirotalkHostUser, password: env.mirotalkHostPassword, presenter: false, expire: '15m' },
  };
  const upstream = await fetch(new URL('/api/v1/join', env.mirotalkInternalUrl), {
    method: 'POST',
    headers: { authorization: env.mirotalkApiKey, 'content-type': 'application/json' },
    body: JSON.stringify(query),
    signal: AbortSignal.timeout(8000),
  });
  if (!upstream.ok) { response.status(502).json({ error: 'Meeting service rejected the request.' }); return; }
  const payload = await upstream.json() as { join?: string };
  if (!payload.join) { response.status(502).json({ error: 'Meeting service returned no link.' }); return; }
  const join = new URL(payload.join);
  const publicUrl = new URL(env.mirotalkPublicUrl);
  response.json({ url: `${publicUrl.origin}${join.pathname}${join.search}${kind === 'room' ? '&addaBridge=room' : ''}` });
}));

socialRoutes.get('/social/bundle', run(async (_request, response) => {
  const userId = response.locals.userId;
  const cached = getCachedSocialBundle(userId);
  if (cached) {
    response.json(cached);
    return;
  }

  const [me, contacts, groups, friendRequests] = await Promise.all([
    ensureProfile(userId),
    pool.query(
      `SELECT u.id, u.name, u.username, u.image AS "avatarUrl", u.about FROM "contact" c
       JOIN "user" u ON u.id = CASE WHEN c."userA" = $1 THEN c."userB" ELSE c."userA" END
       WHERE c."userA" = $1 OR c."userB" = $1 ORDER BY u.name`,
      [userId],
    ),
    pool.query(
      `SELECT g.id, g.name, g."avatarUrl", g."createdAt", COUNT(m2."userId")::int AS "memberCount"
       FROM "chat_group" g JOIN "chat_group_member" mine ON mine."groupId" = g.id AND mine."userId" = $1
       JOIN "chat_group_member" m2 ON m2."groupId" = g.id
       GROUP BY g.id, g.name, g."avatarUrl", g."createdAt" ORDER BY g."createdAt" DESC`,
      [userId],
    ),
    pool.query(
      `SELECT r.id, r."senderId", r."recipientId", r."createdAt", r.status,
         sender.name AS "senderName", sender.username AS "senderUsername", sender.image AS "senderAvatarUrl",
         recipient.name AS "recipientName", recipient.username AS "recipientUsername", recipient.image AS "recipientAvatarUrl"
       FROM "friend_request" r JOIN "user" sender ON sender.id = r."senderId"
         JOIN "user" recipient ON recipient.id = r."recipientId"
       WHERE (r."senderId" = $1 OR r."recipientId" = $1) AND r.status = 'pending'
       ORDER BY r."createdAt" DESC LIMIT 100`,
      [userId],
    ),
  ]);

  if (!me) { response.status(404).json({ error: 'User not found.' }); return; }

  const result = {
    me,
    contacts: contacts.rows,
    groups: groups.rows,
    people: [],
    friendRequests: friendRequests.rows,
  };

  setCachedSocialBundle(userId, result);
  response.json(result);
}));

socialRoutes.get('/calls/ice', run(async (_request, response) => {
  const iceServers: { urls: string | string[]; username?: string; credential?: string }[] = [
    {
      urls: [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
        'stun:stun2.l.google.com:19302',
        'stun:stun3.l.google.com:19302',
        'stun:stun4.l.google.com:19302',
        'stun:stun.cloudflare.com:3478',
        env.stunUrl,
      ].filter(Boolean),
    },
  ];
  if (env.turnUrl && env.turnSharedSecret) {
    const username = `${Math.floor(Date.now() / 1000) + 86400}:${response.locals.userId}`;
    const credential = createHmac('sha1', env.turnSharedSecret).update(username).digest('base64');
    const udpUrl = env.turnUrl;
    const tcpUrl = env.turnUrl.replace('transport=udp', 'transport=tcp');
    iceServers.push(
      { urls: udpUrl, username, credential },
      { urls: tcpUrl, username, credential },
    );
  }
  response.json({ iceServers });
}));

socialRoutes.get('/me', run(async (_request, response) => {
  const profile = await ensureProfile(response.locals.userId);
  if (!profile) { response.status(404).json({ error: 'User not found.' }); return; }
  response.json(profile);
}));

socialRoutes.delete('/me', run(async (request, response) => {
  if (request.body?.confirm !== 'DELETE') {
    response.status(400).json({ error: 'Confirm account deletion in the app.' }); return;
  }
  const deleted = await deleteAccount(response.locals.userId);
  if (!deleted) { response.status(404).json({ error: 'Account no longer exists.' }); return; }
  for (const [key, entry] of sessionCache) if (entry.userId === response.locals.userId) sessionCache.delete(key);
  response.json({ deleted: true });
}));

socialRoutes.get('/safety/policy', (_request, response) => {
  response.json({ version: POLICY_VERSION });
});

socialRoutes.post('/safety/accept', run(async (request, response) => {
  if (request.body?.version !== POLICY_VERSION) {
    response.status(400).json({ error: 'Review the latest ADDA rules before continuing.', version: POLICY_VERSION }); return;
  }
  await pool.query('UPDATE "user" SET "policyVersion" = $2, "policyAcceptedAt" = now() WHERE id = $1',
    [response.locals.userId, POLICY_VERSION]);
  invalidateSocialBundleCache(response.locals.userId);
  response.json({ version: POLICY_VERSION });
}));

socialRoutes.get('/safety/blocks', run(async (_request, response) => {
  const result = await pool.query(
    `SELECT u.id, u.name, u.username FROM user_block b JOIN "user" u ON u.id = b."blockedId"
     WHERE b."blockerId" = $1 ORDER BY b."createdAt" DESC`, [response.locals.userId]);
  response.json(result.rows);
}));

socialRoutes.use(run(async (_request, response, next) => {
  if (!(await hasAcceptedPolicy(response.locals.userId))) {
    response.status(403).json({ error: 'Accept the ADDA Community Guidelines before continuing.', code: 'POLICY_REQUIRED' });
    return;
  }
  next();
}));

socialRoutes.post('/safety/blocks', run(async (request, response) => {
  const selfId = response.locals.userId as string;
  const targetId = request.body?.userId;
  if (typeof targetId !== 'string' || targetId.length > 100 || targetId === selfId) {
    response.status(400).json({ error: 'Choose another user to block.' }); return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const target = await client.query('SELECT 1 FROM "user" WHERE id = $1', [targetId]);
    if (!target.rowCount) { await client.query('ROLLBACK'); response.status(404).json({ error: 'User not found.' }); return; }
    await client.query('INSERT INTO user_block ("blockerId", "blockedId") VALUES ($1, $2) ON CONFLICT DO NOTHING', [selfId, targetId]);
    const [a, b] = [selfId, targetId].sort();
    await client.query('DELETE FROM contact WHERE "userA" = $1 AND "userB" = $2', [a, b]);
    await client.query('DELETE FROM friend_request WHERE ("senderId" = $1 AND "recipientId" = $2) OR ("senderId" = $2 AND "recipientId" = $1)', [selfId, targetId]);
    await client.query('DELETE FROM chat_spool WHERE ("senderId" = $1 AND "recipientId" = $2) OR ("senderId" = $2 AND "recipientId" = $1)', [selfId, targetId]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  publishFriendUpdate([selfId, targetId]);
  response.status(201).json({ blocked: true });
}));

socialRoutes.delete('/safety/blocks/:id', run(async (request, response) => {
  await pool.query('DELETE FROM user_block WHERE "blockerId" = $1 AND "blockedId" = $2',
    [response.locals.userId, request.params.id]);
  response.json({ blocked: false });
}));

socialRoutes.post('/safety/reports', run(async (request, response) => {
  const selfId = response.locals.userId as string;
  const { userId, kind, reason, messageId, roomId, details, evidenceText } = request.body ?? {};
  if (typeof userId !== 'string' || userId.length > 100 || userId === selfId ||
    !['user', 'message', 'room'].includes(kind) ||
    !['harassment', 'hate', 'sexual', 'child_safety', 'violence', 'spam', 'other'].includes(reason) ||
    (details != null && (typeof details !== 'string' || details.length > 1000)) ||
    (evidenceText != null && (typeof evidenceText !== 'string' || evidenceText.length > 2000))) {
    response.status(400).json({ error: 'Invalid report.' }); return;
  }
  const target = await pool.query('SELECT 1 FROM "user" WHERE id = $1', [userId]);
  if (!target.rowCount) { response.status(404).json({ error: 'User not found.' }); return; }
  const count = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM user_report WHERE "reporterId" = $1 AND "createdAt" > now() - interval '24 hours'`, [selfId]);
  if (Number(count.rows[0]?.count ?? 0) >= 10) { response.status(429).json({ error: 'Report limit reached. Try again tomorrow.' }); return; }
  await pool.query(
    `INSERT INTO user_report ("reporterId", "reportedUserId", kind, reason, "messageId", "roomId", details, "evidenceText")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [selfId, userId, kind, reason, typeof messageId === 'string' ? messageId.slice(0, 100) : null,
      typeof roomId === 'string' ? roomId.slice(0, 100) : null, details?.trim() ?? '', evidenceText?.trim() ?? '']);
  response.status(201).json({ reported: true });
}));

socialRoutes.patch('/me', run(async (request, response) => {
  const current = await ensureProfile(response.locals.userId);
  if (!current) { response.status(404).json({ error: 'User not found.' }); return; }

  const name = typeof request.body?.name === 'string' && request.body.name.trim() ? request.body.name.trim() : current.name;
  const usernameInput = typeof request.body?.username === 'string' && request.body.username.trim()
    ? request.body.username.trim().toLowerCase()
    : current.username;
  const about = typeof request.body?.about === 'string' ? request.body.about.trim().slice(0, 150) : undefined;
  const avatarUrl = request.body?.avatarUrl; // string or null

  if (name.length < 2 || name.length > 60) {
    response.status(400).json({ error: 'Use a name of 2–60 characters.' });
    return;
  }

  const isChangingUsername = usernameInput !== current.username;

  if (isChangingUsername) {
    if (!validUsername(usernameInput)) {
      response.status(400).json({ error: 'Username must be 3–24 characters: lowercase letters, numbers, dots, or underscores.' });
      return;
    }

    if (current.usernameChangedAt) {
      const lastChanged = new Date(current.usernameChangedAt).getTime();
      const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
      const remainingMs = lastChanged + fourteenDaysMs - Date.now();
      if (remainingMs > 0) {
        const remainingDays = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
        response.status(403).json({
          error: `You can only change your username once every 14 days. You can change it again in ${remainingDays} day${remainingDays === 1 ? '' : 's'}.`,
        });
        return;
      }
    }
  }

  const updates: string[] = ['name = $2', '"updatedAt" = NOW()'];
  const values: any[] = [response.locals.userId, name];
  let paramIdx = 3;

  if (isChangingUsername) {
    updates.push(`username = $${paramIdx++}`);
    values.push(usernameInput);
    updates.push(`"usernameChangedAt" = NOW()`);
  }

  if (avatarUrl !== undefined) {
    updates.push(`image = $${paramIdx++}`);
    values.push(typeof avatarUrl === 'string' ? avatarUrl : null);
  }
  if (about !== undefined) {
    updates.push(`about = $${paramIdx++}`);
    values.push(about);
  }

  try {
    const result = await pool.query(
      `UPDATE "user" SET ${updates.join(', ')} WHERE id = $1 RETURNING id, name, username, "friendCode", image AS "avatarUrl", about, "usernameChangedAt"`,
      values,
    );
    const contacts = await pool.query<{ id: string }>(
      'SELECT CASE WHEN "userA" = $1 THEN "userB" ELSE "userA" END AS id FROM "contact" WHERE "userA" = $1 OR "userB" = $1',
      [response.locals.userId]
    );
    const parties = [response.locals.userId, ...contacts.rows.map(r => r.id)];
    publishFriendUpdate(parties);
    response.json(result.rows[0]);
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && error.code === '23505') {
      response.status(409).json({ error: 'That username is taken.' }); return;
    }
    throw error;
  }
}));

socialRoutes.get('/contacts', run(async (_request, response) => {
  const result = await pool.query(
    `SELECT u.id, u.name, u.username, u.image AS "avatarUrl", u.about FROM "contact" c
     JOIN "user" u ON u.id = CASE WHEN c."userA" = $1 THEN c."userB" ELSE c."userA" END
     WHERE c."userA" = $1 OR c."userB" = $1 ORDER BY u.name`,
    [response.locals.userId],
  );
  response.json(result.rows);
}));

async function requestContact(
  selfId: string,
  targetUser: { id: string; name: string; username: string; avatarUrl?: string | null },
  response: Parameters<RequestHandler>[1],
) {
  const targetId = targetUser.id;
  if (selfId === targetId) { response.status(400).json({ error: 'You cannot add yourself.' }); return; }
  if (await isBlockedPair(selfId, targetId)) { response.status(403).json({ error: 'This user is unavailable.' }); return; }
  const [userA, userB] = [selfId, targetId].sort();

  const check = await pool.query<{
    is_friend: boolean;
    has_incoming: boolean;
    sender_name: string;
    sender_username: string;
    sender_image: string | null;
  }>(
    `SELECT
       EXISTS(SELECT 1 FROM "contact" WHERE "userA" = $1 AND "userB" = $2) AS is_friend,
       EXISTS(SELECT 1 FROM "friend_request" WHERE "senderId" = $3 AND "recipientId" = $4 AND status = 'pending') AS has_incoming,
       (SELECT name FROM "user" WHERE id = $4) AS sender_name,
       (SELECT username FROM "user" WHERE id = $4) AS sender_username,
       (SELECT image FROM "user" WHERE id = $4) AS sender_image`,
    [userA, userB, targetId, selfId],
  );
  const row = check.rows[0];
  if (row?.is_friend) { response.status(409).json({ error: 'You are already friends.' }); return; }
  if (row?.has_incoming) { response.status(409).json({ error: 'This person has sent you a friend request. Open Updates to accept it.' }); return; }

  const reqId = randomUUID();
  const now = new Date().toISOString();
  await pool.query(
    `INSERT INTO "friend_request" (id, "senderId", "recipientId") VALUES ($1, $2, $3)
     ON CONFLICT ("senderId", "recipientId") DO UPDATE SET status = 'pending', "updatedAt" = NOW()`,
    [reqId, selfId, targetId],
  );

  response.status(201).json(targetUser);

  publishFriendUpdate([selfId, targetId], {
    type: 'request_created',
    request: {
      id: reqId,
      senderId: selfId,
      recipientId: targetId,
      senderName: row?.sender_name || '',
      senderUsername: row?.sender_username || '',
      senderAvatarUrl: row?.sender_image || null,
      recipientName: targetUser.name,
      recipientUsername: targetUser.username,
      recipientAvatarUrl: targetUser.avatarUrl || null,
      createdAt: now,
      status: 'pending',
    },
  });
}

socialRoutes.post('/contacts/username', run(async (request, response) => {
  const username = typeof request.body?.username === 'string' ? request.body.username.trim().toLowerCase() : '';
  if (!validUsername(username)) { response.status(400).json({ error: 'Enter a valid username.' }); return; }
  const result = await pool.query<{ id: string; name: string; username: string; avatarUrl: string | null }>(
    'SELECT id, name, username, image AS "avatarUrl" FROM "user" WHERE LOWER(username) = $1',
    [username],
  );
  if (!result.rows[0]) { response.status(404).json({ error: 'No user has that username.' }); return; }
  await requestContact(response.locals.userId, result.rows[0], response);
}));

socialRoutes.post('/contacts/user/:id', run(async (request, response) => {
  const targetId = request.params.id;
  const result = await pool.query<{ id: string; name: string; username: string; avatarUrl: string | null }>(
    'SELECT id, name, username, image AS "avatarUrl" FROM "user" WHERE id = $1',
    [targetId],
  );
  if (!result.rows[0]) { response.status(404).json({ error: 'User not found.' }); return; }
  await requestContact(response.locals.userId, result.rows[0], response);
}));

socialRoutes.post('/contacts/qr', run(async (request, response) => {
  const raw = typeof request.body?.code === 'string' ? request.body.code.trim() : '';
  const code = /^adda:friend:v1:([a-f0-9]{48})$/.exec(raw)?.[1];
  if (!code) { response.status(400).json({ error: 'This is not an ADDA friend QR.' }); return; }
  const result = await pool.query<{ id: string; name: string; username: string; avatarUrl: string | null }>(
    'SELECT id, name, username, image AS "avatarUrl" FROM "user" WHERE "friendCode" = $1',
    [code],
  );
  if (!result.rows[0]) { response.status(404).json({ error: 'Friend QR not found.' }); return; }
  await requestContact(response.locals.userId, result.rows[0], response);
}));

socialRoutes.get('/friend-requests', run(async (_request, response) => {
  const result = await pool.query(
    `SELECT r.id, r."senderId", r."recipientId", r."createdAt", r."updatedAt", r.status,
       sender.name AS "senderName", sender.username AS "senderUsername", sender.image AS "senderAvatarUrl",
       recipient.name AS "recipientName", recipient.username AS "recipientUsername", recipient.image AS "recipientAvatarUrl"
     FROM "friend_request" r JOIN "user" sender ON sender.id = r."senderId"
       JOIN "user" recipient ON recipient.id = r."recipientId"
     WHERE (
       (r."recipientId" = $1 AND r.status = 'pending')
       OR
       (r."senderId" = $1 AND r.status = 'pending')
       OR
       (r."senderId" = $1 AND r.status = 'accepted' AND (r."dismissedBySender" IS NOT TRUE))
     )
     ORDER BY r."updatedAt" DESC, r."createdAt" DESC LIMIT 100`, [response.locals.userId],
  );
  response.json(result.rows);
}));

socialRoutes.post('/friend-requests/:id/dismiss', run(async (request, response) => {
  await pool.query(
    'UPDATE "friend_request" SET "dismissedBySender" = true, "updatedAt" = NOW() WHERE id = $1 AND "senderId" = $2',
    [request.params.id, response.locals.userId],
  );
  response.json({ ok: true });
}));

socialRoutes.post('/friend-requests/:id/respond', run(async (request, response) => {
  const decision = request.body?.decision;
  if (decision !== 'accept' && decision !== 'decline') { response.status(400).json({ error: 'Choose accept or decline.' }); return; }
  const client = await pool.connect();
  let parties: string[] = [];
  let payload: unknown = null;
  try {
    await client.query('BEGIN');
    const result = await client.query<{
      senderId: string;
      recipientId: string;
      senderName: string;
      senderUsername: string;
      senderImage: string | null;
      recipientName: string;
      recipientUsername: string;
      recipientImage: string | null;
    }>(
      `SELECT r."senderId", r."recipientId",
              s.name AS "senderName", s.username AS "senderUsername", s.image AS "senderImage",
              rec.name AS "recipientName", rec.username AS "recipientUsername", rec.image AS "recipientImage"
       FROM "friend_request" r
       JOIN "user" s ON s.id = r."senderId"
       JOIN "user" rec ON rec.id = r."recipientId"
       WHERE r.id = $1 AND r."recipientId" = $2 AND r.status = 'pending' FOR UPDATE`,
      [request.params.id, response.locals.userId],
    );
    const item = result.rows[0];
    if (!item) { await client.query('ROLLBACK'); response.status(404).json({ error: 'Friend request is no longer available.' }); return; }
    if (decision === 'accept') {
      const [userA, userB] = [item.senderId, item.recipientId].sort();
      await client.query('INSERT INTO "contact" ("userA", "userB") VALUES ($1, $2) ON CONFLICT DO NOTHING', [userA, userB]);
    }
    await client.query('UPDATE "friend_request" SET status = $2, "updatedAt" = NOW() WHERE id = $1', [request.params.id, decision === 'accept' ? 'accepted' : 'declined']);
    await client.query('COMMIT');
    parties = [item.senderId, item.recipientId];
    payload = {
      type: 'request_responded',
      decision,
      requestId: request.params.id,
      request: {
        id: request.params.id,
        senderId: item.senderId,
        recipientId: item.recipientId,
        senderName: item.senderName,
        senderUsername: item.senderUsername,
        senderAvatarUrl: item.senderImage,
        recipientName: item.recipientName,
        recipientUsername: item.recipientUsername,
        recipientAvatarUrl: item.recipientImage,
        status: decision === 'accept' ? 'accepted' : 'declined',
        updatedAt: new Date().toISOString(),
      },
      senderContact: decision === 'accept' ? {
        id: item.recipientId,
        name: item.recipientName,
        username: item.recipientUsername,
        avatarUrl: item.recipientImage,
      } : null,
      recipientContact: decision === 'accept' ? {
        id: item.senderId,
        name: item.senderName,
        username: item.senderUsername,
        avatarUrl: item.senderImage,
      } : null,
    };
    response.json({ status: decision === 'accept' ? 'accepted' : 'declined' });
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  publishFriendUpdate(parties, payload);
}));

socialRoutes.get('/groups', run(async (_request, response) => {
  const result = await pool.query(
    `SELECT g.id, g.name, g."avatarUrl", g."createdAt", COUNT(m2."userId")::int AS "memberCount"
     FROM "chat_group" g JOIN "chat_group_member" mine ON mine."groupId" = g.id AND mine."userId" = $1
     JOIN "chat_group_member" m2 ON m2."groupId" = g.id
     GROUP BY g.id, g.name, g."avatarUrl", g."createdAt" ORDER BY g."createdAt" DESC`,
    [response.locals.userId],
  );
  response.json(result.rows);
}));

socialRoutes.post('/groups', run(async (request, response) => {
  const name = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
  const members: unknown = request.body?.memberIds;
  if (name.length < 2 || name.length > 60 || !Array.isArray(members) || members.length < 1 || members.length > 50 || !members.every((id) => typeof id === 'string')) {
    response.status(400).json({ error: 'Choose a group name and at least one contact.' }); return;
  }
  const ids = [...new Set(members as string[])].filter((id) => id !== response.locals.userId);
  const verified = await pool.query<{id: string}>(
    `SELECT CASE WHEN "userA" = $1 THEN "userB" ELSE "userA" END AS id
     FROM "contact" WHERE ("userA" = $1 OR "userB" = $1)
     AND CASE WHEN "userA" = $1 THEN "userB" ELSE "userA" END = ANY($2::text[])`,
    [response.locals.userId, ids],
  );
  if (verified.rows.length !== ids.length) { response.status(400).json({ error: 'Groups can only include your contacts.' }); return; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = randomUUID();
    await client.query('INSERT INTO "chat_group" (id, name, "ownerId") VALUES ($1, $2, $3)', [id, name, response.locals.userId]);
    await client.query('INSERT INTO "chat_group_member" ("groupId", "userId", "role") VALUES ($1, $2, $3)', [id, response.locals.userId, 'admin']);
    for (const userId of ids) {
      await client.query('INSERT INTO "chat_group_member" ("groupId", "userId", "role") VALUES ($1, $2, $3)', [id, userId, 'member']);
    }
    await client.query('COMMIT');
    invalidateGroupMembersCache(id);
    invalidateSocialBundleCache([response.locals.userId, ...ids]);
    response.status(201).json({ id, name, memberCount: ids.length + 1 });
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}));

socialRoutes.get('/groups/:id', run(async (request, response) => {
  const groupId = String(request.params.id);
  const callerId = response.locals.userId as string;

  const groupRes = await pool.query<{
    id: string;
    name: string;
    description: string;
    avatarUrl: string | null;
    ownerId: string;
    createdAt: string;
  }>(
    'SELECT id, name, COALESCE(description, \'\') AS description, "avatarUrl", "ownerId", "createdAt" FROM "chat_group" WHERE id = $1',
    [groupId]
  );
  if (!groupRes.rows.length) {
    response.status(404).json({ error: 'Group not found.' });
    return;
  }
  const group = groupRes.rows[0];

  const callerMember = await pool.query<{ role: string }>(
    'SELECT role FROM "chat_group_member" WHERE "groupId" = $1 AND "userId" = $2',
    [groupId, callerId]
  );
  if (!callerMember.rows.length) {
    response.status(403).json({ error: 'You are not a member of this group.' });
    return;
  }
  const callerRole = callerMember.rows[0].role;
  const isAdmin = callerId === group.ownerId || callerRole === 'admin';

  const membersRes = await pool.query<{
    id: string;
    name: string;
    username: string;
    about: string;
    avatarUrl: string | null;
    role: 'admin' | 'member';
    joinedAt: string;
  }>(
    `SELECT u.id, u.name, u.username, COALESCE(u.about, 'Hey there! I am using ADDA.') AS about,
            u.image AS "avatarUrl", m.role, m."joinedAt"
     FROM "chat_group_member" m
     JOIN "user" u ON u.id = m."userId"
     WHERE m."groupId" = $1
     ORDER BY (m."userId" = $2) DESC, (m.role = 'admin') DESC, u.name ASC`,
    [groupId, callerId]
  );

  response.json({
    id: group.id,
    name: group.name,
    description: group.description,
    avatarUrl: group.avatarUrl,
    ownerId: group.ownerId,
    isAdmin,
    memberCount: membersRes.rows.length,
    members: membersRes.rows.map(m => ({
      ...m,
      isSelf: m.id === callerId
    }))
  });
}));

socialRoutes.patch('/groups/:id', run(async (request, response) => {
  const groupId = String(request.params.id);
  const callerId = response.locals.userId as string;
  const { name, description, avatarUrl } = request.body ?? {};

  const member = await pool.query<{ role: string }>(
    'SELECT role FROM "chat_group_member" WHERE "groupId" = $1 AND "userId" = $2',
    [groupId, callerId]
  );
  const groupRes = await pool.query<{ ownerId: string }>('SELECT "ownerId" FROM "chat_group" WHERE id = $1', [groupId]);
  if (!groupRes.rows.length || !member.rows.length) {
    response.status(404).json({ error: 'Group unavailable.' });
    return;
  }
  const isAdmin = callerId === groupRes.rows[0].ownerId || member.rows[0].role === 'admin';
  if (!isAdmin) {
    response.status(403).json({ error: 'Only admins can edit group settings.' });
    return;
  }

  const updates: string[] = [];
  const values: any[] = [];
  let paramIdx = 1;

  if (typeof name === 'string' && name.trim().length >= 2 && name.trim().length <= 60) {
    updates.push(`name = $${paramIdx++}`);
    values.push(name.trim());
  }
  if (typeof description === 'string' && description.length <= 500) {
    updates.push(`description = $${paramIdx++}`);
    values.push(description.trim());
  }
  if (typeof avatarUrl === 'string' || avatarUrl === null) {
    updates.push(`"avatarUrl" = $${paramIdx++}`);
    values.push(avatarUrl);
  }

  if (updates.length > 0) {
    values.push(groupId);
    await pool.query(`UPDATE "chat_group" SET ${updates.join(', ')} WHERE id = $${paramIdx}`, values);
  }

  const allMembers = await getCachedGroupMembers(groupId);
  publishGroupUpdate(groupId, allMembers);

  response.json({ ok: true });
}));

socialRoutes.post('/groups/:id/members', run(async (request, response) => {
  const groupId = String(request.params.id);
  const callerId = response.locals.userId as string;
  const memberIds: unknown = request.body?.memberIds;

  if (!Array.isArray(memberIds) || memberIds.length === 0 || !memberIds.every(id => typeof id === 'string')) {
    response.status(400).json({ error: 'Select at least one contact to add.' });
    return;
  }

  const member = await pool.query<{ role: string }>(
    'SELECT role FROM "chat_group_member" WHERE "groupId" = $1 AND "userId" = $2',
    [groupId, callerId]
  );
  const groupRes = await pool.query<{ ownerId: string }>('SELECT "ownerId" FROM "chat_group" WHERE id = $1', [groupId]);
  if (!groupRes.rows.length || !member.rows.length) {
    response.status(404).json({ error: 'Group unavailable.' });
    return;
  }
  const isAdmin = callerId === groupRes.rows[0].ownerId || member.rows[0].role === 'admin';
  if (!isAdmin) {
    response.status(403).json({ error: 'Only admins can add members.' });
    return;
  }

  for (const uid of memberIds as string[]) {
    await pool.query(
      'INSERT INTO "chat_group_member" ("groupId", "userId", role) VALUES ($1, $2, \'member\') ON CONFLICT ("groupId", "userId") DO NOTHING',
      [groupId, uid]
    );
  }

  invalidateGroupMembersCache(groupId);
  const allMembers = await getCachedGroupMembers(groupId);
  publishGroupUpdate(groupId, allMembers);

  response.json({ ok: true });
}));

socialRoutes.patch('/groups/:id/members/:userId', run(async (request, response) => {
  const groupId = String(request.params.id);
  const targetUserId = String(request.params.userId);
  const callerId = response.locals.userId as string;
  const { role } = request.body ?? {};

  if (role !== 'admin' && role !== 'member') {
    response.status(400).json({ error: 'Invalid role.' });
    return;
  }

  const groupRes = await pool.query<{ ownerId: string }>('SELECT "ownerId" FROM "chat_group" WHERE id = $1', [groupId]);
  const callerMember = await pool.query<{ role: string }>(
    'SELECT role FROM "chat_group_member" WHERE "groupId" = $1 AND "userId" = $2',
    [groupId, callerId]
  );
  if (!groupRes.rows.length || !callerMember.rows.length) {
    response.status(404).json({ error: 'Group unavailable.' });
    return;
  }
  const isCallerAdmin = callerId === groupRes.rows[0].ownerId || callerMember.rows[0].role === 'admin';
  if (!isCallerAdmin) {
    response.status(403).json({ error: 'Only admins can change roles.' });
    return;
  }

  if (targetUserId === groupRes.rows[0].ownerId && role !== 'admin') {
    response.status(403).json({ error: 'The group creator must remain an admin.' });
    return;
  }

  await pool.query(
    'UPDATE "chat_group_member" SET role = $1 WHERE "groupId" = $2 AND "userId" = $3',
    [role, groupId, targetUserId]
  );

  const allMembers = await getCachedGroupMembers(groupId);
  publishGroupUpdate(groupId, allMembers);

  response.json({ ok: true });
}));

socialRoutes.delete('/groups/:id/members/:userId', run(async (request, response) => {
  const groupId = String(request.params.id);
  const targetUserId = String(request.params.userId);
  const callerId = response.locals.userId as string;

  const groupRes = await pool.query<{ ownerId: string }>('SELECT "ownerId" FROM "chat_group" WHERE id = $1', [groupId]);
  if (!groupRes.rows.length) {
    response.status(404).json({ error: 'Group unavailable.' });
    return;
  }
  const ownerId = groupRes.rows[0].ownerId;

  // Case 1: Member leaves voluntarily
  if (callerId === targetUserId) {
    await pool.query('DELETE FROM "chat_group_member" WHERE "groupId" = $1 AND "userId" = $2', [groupId, callerId]);
    invalidateGroupMembersCache(groupId);
    const remaining = await pool.query<{ count: string }>('SELECT count(*)::int AS count FROM "chat_group_member" WHERE "groupId" = $1', [groupId]);
    if (parseInt(remaining.rows[0].count, 10) === 0) {
      await pool.query('DELETE FROM "chat_group" WHERE id = $1', [groupId]);
    } else {
      const allMembers = await getCachedGroupMembers(groupId);
      publishGroupUpdate(groupId, allMembers);
    }
    response.json({ ok: true, left: true });
    return;
  }

  // Case 2: Admin removes member
  const callerMember = await pool.query<{ role: string }>(
    'SELECT role FROM "chat_group_member" WHERE "groupId" = $1 AND "userId" = $2',
    [groupId, callerId]
  );
  const isCallerAdmin = callerId === ownerId || callerMember.rows[0]?.role === 'admin';
  if (!isCallerAdmin) {
    response.status(403).json({ error: 'Only admins can remove members.' });
    return;
  }
  if (targetUserId === ownerId) {
    response.status(403).json({ error: 'The group creator cannot be removed.' });
    return;
  }

  await pool.query('DELETE FROM "chat_group_member" WHERE "groupId" = $1 AND "userId" = $2', [groupId, targetUserId]);
  invalidateGroupMembersCache(groupId);
  const allMembers = await getCachedGroupMembers(groupId);
  publishGroupUpdate(groupId, allMembers);

  response.json({ ok: true, removed: true });
}));

socialRoutes.get('/groups/:id/media', run(async (request, response) => {
  const groupId = String(request.params.id);
  const callerId = response.locals.userId as string;

  const member = await pool.query('SELECT 1 FROM "chat_group_member" WHERE "groupId" = $1 AND "userId" = $2', [groupId, callerId]);
  if (!member.rows.length) {
    response.status(403).json({ error: 'You are not a member of this group.' });
    return;
  }

  const result = await pool.query<{
    id: string;
    ownerId: string;
    mediaKind: 'image' | 'video';
    contentLength: string;
    createdAt: string;
  }>(
    `SELECT id, "ownerId", "mediaKind", "contentLength", "createdAt"
     FROM "chat_media"
     WHERE "targetId" = $1 AND confirmed = true
     ORDER BY "createdAt" DESC LIMIT 100`,
    [groupId]
  );

  response.json(result.rows);
}));

async function canMessageDirect(selfId: string, otherId: string) {
  const [userA, userB] = [selfId, otherId].sort();
  const result = await pool.query('SELECT 1 FROM "contact" WHERE "userA" = $1 AND "userB" = $2', [userA, userB]);
  return result.rowCount === 1;
}

async function canMessageGroup(userId: string, groupId: string) {
  const result = await pool.query('SELECT 1 FROM "chat_group_member" WHERE "userId" = $1 AND "groupId" = $2', [userId, groupId]);
  return result.rowCount === 1;
}

socialRoutes.get('/chats/:kind/:id', run(async (request, response) => {
  const kind = request.params.kind;
  const id = request.params.id;
  const selfId = response.locals.userId;
  if ((kind !== 'direct' && kind !== 'group') || typeof id !== 'string') { response.status(400).json({ error: 'Invalid chat type.' }); return; }
  const permitted = kind === 'direct' ? await canMessageDirect(selfId, id) : await canMessageGroup(selfId, id);
  if (!permitted) { response.status(403).json({ error: 'This chat is not available to you.' }); return; }
  const result = await pool.query(
    kind === 'direct'
      ? `SELECT m.id, m.body, m."senderId", u.name AS "senderName", m."createdAt" FROM "chat_message" m JOIN "user" u ON u.id = m."senderId" WHERE (m."senderId" = $1 AND m."recipientId" = $2) OR (m."senderId" = $2 AND m."recipientId" = $1) ORDER BY m."createdAt" DESC LIMIT 100`
      : `SELECT m.id, m.body, m."senderId", u.name AS "senderName", m."createdAt" FROM "chat_message" m JOIN "user" u ON u.id = m."senderId" WHERE m."groupId" = $1 ORDER BY m."createdAt" DESC LIMIT 100`,
    kind === 'direct' ? [selfId, id] : [id],
  );
  response.json(result.rows.reverse());
}));

socialRoutes.post('/chats/:kind/:id', run(async (request, response) => {
  response.status(410).json({ error: 'Update ADDA to send encrypted messages.' });
}));

// ==========================================
// GROUP ROOMS & HANGOUT INVITES
// ==========================================

socialRoutes.post('/groups/:id/rooms', run(async (request, response) => {
  const groupId = String(request.params.id);
  const userId = response.locals.userId as string;
  const rawKind = request.body?.roomKind;
  const roomKind = (typeof rawKind === 'string' && ['loft', 'roof', 'tea', 'beach'].includes(rawKind)) ? rawKind : 'loft';

  // Check group membership
  const member = await pool.query('SELECT 1 FROM "chat_group_member" WHERE "groupId" = $1 AND "userId" = $2', [groupId, userId]);
  if (!member.rows.length) {
    response.status(403).json({ error: 'Only members of this group can create a room.' });
    return;
  }

  // Deactivate any currently active rooms for this group
  await pool.query('UPDATE "group_room" SET "isActive" = false, "updatedAt" = now() WHERE "groupId" = $1 AND "isActive" = true', [groupId]);

  const roomId = randomUUID();
  await pool.query(
    'INSERT INTO "group_room" (id, "groupId", "roomKind", "creatorId", "isActive") VALUES ($1, $2, $3, $4, true)',
    [roomId, groupId, roomKind, userId]
  );

  const shardId = `group:${groupId}:${roomKind}`;
  groupRoomOwners.set(shardId, userId);

  // Fetch creator info and group details
  const [creatorRes, groupRes, membersRes] = await Promise.all([
    pool.query<{ name: string; username: string }>('SELECT name, username FROM "user" WHERE id = $1', [userId]),
    pool.query<{ name: string }>('SELECT name FROM "chat_group" WHERE id = $1', [groupId]),
    pool.query<{ userId: string }>('SELECT "userId" FROM "chat_group_member" WHERE "groupId" = $1', [groupId]),
  ]);

  const creatorName = creatorRes.rows[0]?.name || 'Member';
  const groupName = groupRes.rows[0]?.name || 'Group';
  const memberIds = membersRes.rows.map(r => r.userId);

  const payload = {
    roomId,
    groupId,
    groupName,
    roomKind,
    creatorId: userId,
    creatorName,
    createdAt: new Date().toISOString(),
  };

  publishGroupRoomUpdate(memberIds, payload);

  const otherMemberIds = memberIds.filter(id => id !== userId);
  if (otherMemberIds.length) {
    void sendRoomInvitePush(otherMemberIds, {
      inviterName: creatorName,
      groupName,
      roomKind,
      groupId,
      roomId,
      ownerId: userId,
      roomName: `${groupName} Hangout`,
      isPrivate: true,
    }).catch(err => console.warn('[ADDA] Group room invite push error:', err));
  }

  response.status(201).json({
    ok: true,
    room: payload,
  });
}));

socialRoutes.get('/groups/:id/rooms/active', run(async (request, response) => {
  const groupId = String(request.params.id);
  const userId = response.locals.userId as string;

  const member = await pool.query('SELECT 1 FROM "chat_group_member" WHERE "groupId" = $1 AND "userId" = $2', [groupId, userId]);
  if (!member.rows.length) {
    response.status(403).json({ error: 'You are not a member of this group.' });
    return;
  }

  const roomRes = await pool.query<{
    id: string;
    groupId: string;
    roomKind: string;
    creatorId: string;
    createdAt: string;
    creatorName: string;
    groupName: string;
  }>(
    `SELECT r.id, r."groupId", r."roomKind", r."creatorId", r."createdAt",
            u.name AS "creatorName", g.name AS "groupName"
     FROM "group_room" r
     JOIN "user" u ON u.id = r."creatorId"
     JOIN "chat_group" g ON g.id = r."groupId"
     WHERE r."groupId" = $1 AND r."isActive" = true
     ORDER BY r."createdAt" DESC LIMIT 1`,
    [groupId]
  );

  response.json({
    active: roomRes.rows.length > 0,
    room: roomRes.rows[0] || null,
  });
}));

socialRoutes.delete('/groups/:id/rooms/active', run(async (request, response) => {
  const groupId = String(request.params.id);
  const userId = response.locals.userId as string;

  const roomRes = await pool.query<{ id: string; creatorId: string; roomKind: string }>(
    'SELECT id, "creatorId", "roomKind" FROM "group_room" WHERE "groupId" = $1 AND "isActive" = true ORDER BY "createdAt" DESC LIMIT 1',
    [groupId]
  );
  if (!roomRes.rows.length) {
    response.status(404).json({ error: 'No active room found.' });
    return;
  }
  const room = roomRes.rows[0];
  if (room.creatorId !== userId) {
    const adminCheck = await pool.query('SELECT 1 FROM "chat_group_member" WHERE "groupId" = $1 AND "userId" = $2 AND role = \'admin\'', [groupId, userId]);
    if (!adminCheck.rows.length) {
      response.status(403).json({ error: 'Only the room host or group admin can delete this room.' });
      return;
    }
  }

  await pool.query('UPDATE "group_room" SET "isActive" = false, "updatedAt" = now() WHERE id = $1', [room.id]);
  const membersRes = await pool.query<{ userId: string }>('SELECT "userId" FROM "chat_group_member" WHERE "groupId" = $1', [groupId]);
  publishGroupRoomUpdate(membersRes.rows.map(r => r.userId), { groupId, active: false });

  response.json({ ok: true, deleted: true });
}));

socialRoutes.get('/rooms/public', run(async (_request, response) => {
  const result = await pool.query<{
    id: string;
    roomKind: string;
    creatorId: string;
    name: string;
    code: string;
    isPrivate: boolean;
    maxPlayers: number;
    createdAt: string;
    creatorName: string;
    creatorAvatarUrl: string | null;
  }>(
    `SELECT r.id, r."roomKind", r."creatorId", r.name, r.code, r."isPrivate", r."createdAt", r."maxPlayers",
            u.name AS "creatorName", u.image AS "creatorAvatarUrl"
     FROM "group_room" r
     JOIN "user" u ON u.id = r."creatorId"
     WHERE r."isActive" = true AND r."isPrivate" = false
     ORDER BY r."createdAt" DESC LIMIT 50`
  );
  const io = getIO();
  const rooms = result.rows.map(room => ({
    ...room,
    maxPlayers: room.maxPlayers || 10,
    peerCount: io ? getShardPeerCount(io, `room:${room.id}`) : 0,
  }));
  response.json({ rooms });
}));

socialRoutes.post('/rooms', run(async (request, response) => {
  const userId = response.locals.userId as string;
  const rawKind = request.body?.roomKind;
  const roomKind = (typeof rawKind === 'string' && ['loft', 'roof', 'tea', 'beach'].includes(rawKind)) ? rawKind : 'loft';
  const isPrivate = Boolean(request.body?.isPrivate);
  const rawMax = Number(request.body?.maxPlayers);
  const maxPlayers = (!isNaN(rawMax) && rawMax >= 2 && rawMax <= 10) ? Math.floor(rawMax) : 10;
  const code = Math.floor(1000 + Math.random() * 9000).toString();
  const rawName = typeof request.body?.name === 'string' ? request.body.name.trim() : '';

  const themeTitles: Record<string, string> = {
    tea: 'Chai Shop',
    beach: 'Sunset Beach',
    loft: 'Lounge Loft',
    roof: 'Rooftop Lounge',
  };

  const name = rawName || (isPrivate ? `Private Server #${code}` : `ADDA Server ${themeTitles[roomKind] || 'Hangout'}#${code}`);

  const roomId = randomUUID();
  await pool.query(
    `INSERT INTO "group_room" (id, "roomKind", "creatorId", "isActive", name, "isPrivate", code, "maxPlayers", "lastActivityAt")
     VALUES ($1, $2, $3, true, $4, $5, $6, $7, now())`,
    [roomId, roomKind, userId, name, isPrivate, code, maxPlayers]
  );

  const shardId = `room:${roomId}`;
  groupRoomOwners.set(shardId, userId);

  const userRes = await pool.query<{ name: string; username: string }>('SELECT name, username FROM "user" WHERE id = $1', [userId]);
  const creatorName = userRes.rows[0]?.name || 'Host';

  const groupInvites = Array.isArray(request.body?.groupInvites) ? (request.body.groupInvites as string[]) : [];
  const userInvites = Array.isArray(request.body?.userInvites) ? (request.body.userInvites as string[]) : [];
  const notifiedUserIds = new Set<string>();

  for (const gId of groupInvites) {
    if (typeof gId !== 'string') continue;
    const memCheck = await pool.query('SELECT 1 FROM "chat_group_member" WHERE "groupId" = $1 AND "userId" = $2', [gId, userId]);
    if (!memCheck.rows.length) continue;

    const groupRes = await pool.query<{ name: string }>('SELECT name FROM "chat_group" WHERE id = $1', [gId]);
    const gName = groupRes.rows[0]?.name || 'Group';

    await pool.query(
      `INSERT INTO "room_invite" (id, "roomId", "groupId", "inviterId", "roomKind", "roomName", "isPrivate", status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
      [randomUUID(), roomId, gId, userId, roomKind, name, isPrivate]
    );

    const memsRes = await pool.query<{ userId: string }>('SELECT "userId" FROM "chat_group_member" WHERE "groupId" = $1 AND "userId" != $2', [gId, userId]);
    const memIds = memsRes.rows.map(r => r.userId).filter(id => !notifiedUserIds.has(id));
    if (memIds.length) {
      memIds.forEach(id => notifiedUserIds.add(id));
      publishGroupRoomUpdate(memIds, { roomId, roomKind, name, isPrivate, creatorId: userId, creatorName, groupId: gId, groupName: gName });
      void sendRoomInvitePush(memIds, {
        inviterName: creatorName,
        groupName: gName,
        roomKind,
        groupId: gId,
        roomId,
        ownerId: userId,
        roomName: name,
        isPrivate,
      });
    }
  }

  for (const targetUserId of userInvites) {
    if (typeof targetUserId !== 'string' || targetUserId === userId) continue;
    await pool.query(
      `INSERT INTO "room_invite" (id, "roomId", "inviteeId", "inviterId", "roomKind", "roomName", "isPrivate", status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
       ON CONFLICT ("roomId", "inviteeId") DO UPDATE SET status = 'pending', "updatedAt" = now()`,
      [randomUUID(), roomId, targetUserId, userId, roomKind, name, isPrivate]
    );
    if (!notifiedUserIds.has(targetUserId)) {
      notifiedUserIds.add(targetUserId);
      publishGroupRoomUpdate([targetUserId], { roomId, roomKind, name, isPrivate, creatorId: userId, creatorName });
      void sendRoomInvitePush([targetUserId], {
        inviterName: creatorName,
        roomKind,
        roomId,
        ownerId: userId,
        roomName: name,
        isPrivate,
      });
    }
  }

  if (!isPrivate) {
    publishPublicRoomsUpdate();
  }

  response.status(201).json({
    ok: true,
    room: {
      id: roomId,
      roomKind,
      creatorId: userId,
      creatorName,
      name,
      isPrivate,
      code,
      maxPlayers,
      createdAt: new Date().toISOString(),
    },
  });
}));

socialRoutes.post('/rooms/:id/invite', run(async (request, response) => {
  const roomId = String(request.params.id);
  const userId = response.locals.userId as string;

  const roomRes = await pool.query<{ id: string; creatorId: string; roomKind: string; name: string; isPrivate: boolean }>(
    'SELECT id, "creatorId", "roomKind", name, "isPrivate" FROM "group_room" WHERE id = $1 AND "isActive" = true',
    [roomId]
  );
  if (!roomRes.rows.length) {
    response.status(404).json({ error: 'Active room not found.' });
    return;
  }
  const room = roomRes.rows[0];
  if (room.creatorId !== userId) {
    response.status(403).json({ error: 'Only the room host can invite players.' });
    return;
  }

  const userRes = await pool.query<{ name: string }>('SELECT name FROM "user" WHERE id = $1', [userId]);
  const creatorName = userRes.rows[0]?.name || 'Host';

  const groupInvites = Array.isArray(request.body?.groupInvites) ? (request.body.groupInvites as string[]) : [];
  const userInvites = Array.isArray(request.body?.userInvites) ? (request.body.userInvites as string[]) : [];
  const notifiedUserIds = new Set<string>();

  for (const gId of groupInvites) {
    if (typeof gId !== 'string') continue;
    const memCheck = await pool.query('SELECT 1 FROM "chat_group_member" WHERE "groupId" = $1 AND "userId" = $2', [gId, userId]);
    if (!memCheck.rows.length) continue;

    const groupRes = await pool.query<{ name: string }>('SELECT name FROM "chat_group" WHERE id = $1', [gId]);
    const gName = groupRes.rows[0]?.name || 'Group';

    await pool.query(
      `INSERT INTO "room_invite" (id, "roomId", "groupId", "inviterId", "roomKind", "roomName", "isPrivate", status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
      [randomUUID(), roomId, gId, userId, room.roomKind, room.name, room.isPrivate]
    );

    const memsRes = await pool.query<{ userId: string }>('SELECT "userId" FROM "chat_group_member" WHERE "groupId" = $1 AND "userId" != $2', [gId, userId]);
    const memIds = memsRes.rows.map(r => r.userId).filter(id => !notifiedUserIds.has(id));
    if (memIds.length) {
      memIds.forEach(id => notifiedUserIds.add(id));
      publishGroupRoomUpdate(memIds, { roomId, roomKind: room.roomKind, name: room.name, isPrivate: room.isPrivate, creatorId: userId, creatorName, groupId: gId, groupName: gName });
      void sendRoomInvitePush(memIds, {
        inviterName: creatorName,
        groupName: gName,
        roomKind: room.roomKind,
        groupId: gId,
        roomId,
        ownerId: userId,
        roomName: room.name,
        isPrivate: room.isPrivate,
      });
    }
  }

  for (const targetUserId of userInvites) {
    if (typeof targetUserId !== 'string' || targetUserId === userId) continue;
    await pool.query(
      `INSERT INTO "room_invite" (id, "roomId", "inviteeId", "inviterId", "roomKind", "roomName", "isPrivate", status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
       ON CONFLICT ("roomId", "inviteeId") DO UPDATE SET status = 'pending', "updatedAt" = now()`,
      [randomUUID(), roomId, targetUserId, userId, room.roomKind, room.name, room.isPrivate]
    );
    if (!notifiedUserIds.has(targetUserId)) {
      notifiedUserIds.add(targetUserId);
      publishGroupRoomUpdate([targetUserId], { roomId, roomKind: room.roomKind, name: room.name, isPrivate: room.isPrivate, creatorId: userId, creatorName });
      void sendRoomInvitePush([targetUserId], {
        inviterName: creatorName,
        roomKind: room.roomKind,
        roomId,
        ownerId: userId,
        roomName: room.name,
        isPrivate: room.isPrivate,
      });
    }
  }

  response.json({ ok: true });
}));

socialRoutes.delete('/rooms/:id', run(async (request, response) => {
  const roomId = String(request.params.id);
  const userId = response.locals.userId as string;

  const roomRes = await pool.query<{ id: string; creatorId: string; groupId: string | null; roomKind: string }>(
    'SELECT id, "creatorId", "groupId", "roomKind" FROM "group_room" WHERE id = $1 AND "isActive" = true',
    [roomId]
  );
  if (!roomRes.rows.length) {
    response.status(404).json({ error: 'No active room found.' });
    return;
  }
  const room = roomRes.rows[0];
  if (room.creatorId !== userId) {
    response.status(403).json({ error: 'Only the host can close this room.' });
    return;
  }

  const io = getIO();
  if (io) {
    await deleteGroupRoomInstance(io, `room:${roomId}`, room.groupId || undefined, 'Host closed the room.', roomId);
  } else {
    await pool.query('UPDATE "group_room" SET "isActive" = false, "updatedAt" = now() WHERE id = $1', [roomId]);
  }

  publishPublicRoomsUpdate();
  response.json({ ok: true, deleted: true });
}));

socialRoutes.get('/updates/hangouts', run(async (_request, response) => {
  const userId = response.locals.userId as string;

  const [activeRoomsRes, invitesRes] = await Promise.all([
    pool.query<{
      id: string;
      groupId: string | null;
      groupName: string;
      groupAvatarUrl: string | null;
      roomKind: string;
      creatorId: string;
      creatorName: string;
      name: string;
      isPrivate: boolean;
      createdAt: string;
    }>(
      `SELECT r.id, r."groupId", COALESCE(g.name, r.name) AS "groupName", g."avatarUrl" AS "groupAvatarUrl",
              r."roomKind", r."creatorId", u.name AS "creatorName", r.name, r."isPrivate", r."createdAt"
       FROM "group_room" r
       LEFT JOIN "chat_group" g ON g.id = r."groupId"
       JOIN "user" u ON u.id = r."creatorId"
       WHERE r."isActive" = true
         AND (
           (r."isPrivate" = true AND r."creatorId" = $1)
           OR (r."groupId" IS NOT NULL AND EXISTS (SELECT 1 FROM "chat_group_member" m WHERE m."groupId" = r."groupId" AND m."userId" = $1))
           OR EXISTS (SELECT 1 FROM "room_invite" ri WHERE ri."roomId" = r.id AND (ri."inviteeId" = $1 OR (ri."groupId" IS NOT NULL AND EXISTS (SELECT 1 FROM "chat_group_member" m2 WHERE m2."groupId" = ri."groupId" AND m2."userId" = $1))))
         )
       ORDER BY r."createdAt" DESC LIMIT 30`,
      [userId]
    ),
    pool.query<{
      id: string;
      roomId: string;
      groupId: string | null;
      groupName: string;
      roomKind: string;
      roomName: string | null;
      inviterId: string;
      inviterName: string;
      inviterAvatarUrl: string | null;
      createdAt: string;
      isPrivate: boolean;
    }>(
      `SELECT i.id, i."roomId", i."groupId", COALESCE(g.name, i."roomName", 'Hangout') AS "groupName",
              i."roomKind", i."roomName", i."inviterId", u.name AS "inviterName", u.image AS "inviterAvatarUrl",
              i."createdAt", COALESCE(i."isPrivate", true) AS "isPrivate"
       FROM "room_invite" i
       LEFT JOIN "chat_group" g ON g.id = i."groupId"
       JOIN "user" u ON u.id = i."inviterId"
       JOIN "group_room" r ON r.id = i."roomId"
       WHERE r."isActive" = true AND i.status = 'pending'
         AND (
           i."inviteeId" = $1
           OR (i."groupId" IS NOT NULL AND EXISTS (SELECT 1 FROM "chat_group_member" gm WHERE gm."groupId" = i."groupId" AND gm."userId" = $1))
         )
       ORDER BY i."createdAt" DESC LIMIT 20`,
      [userId]
    ),
  ]);

  response.json({
    activeRooms: activeRoomsRes.rows,
    invites: invitesRes.rows,
  });
}));

socialRoutes.post('/room-invites/:id/respond', run(async (request, response) => {
  const inviteId = String(request.params.id);
  const userId = response.locals.userId as string;
  const decision = request.body?.decision === 'accept' ? 'accepted' : 'dismissed';

  const check = await pool.query<{ id: string; groupId: string | null; inviteeId: string | null }>(
    `SELECT i.id, i."groupId", i."inviteeId"
     FROM "room_invite" i
     WHERE i.id = $1
       AND (
         i."inviteeId" = $2
         OR (i."groupId" IS NOT NULL AND EXISTS (SELECT 1 FROM "chat_group_member" gm WHERE gm."groupId" = i."groupId" AND gm."userId" = $2))
       )`,
    [inviteId, userId]
  );
  if (!check.rows.length) {
    response.status(404).json({ error: 'Invite not found.' });
    return;
  }

  const row = check.rows[0];
  if (row.inviteeId === userId) {
    await pool.query(
      'UPDATE "room_invite" SET status = $1, "updatedAt" = now() WHERE id = $2',
      [decision, inviteId]
    );
  }

  response.json({ ok: true, status: decision });
}));
