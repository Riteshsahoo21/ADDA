import { createHmac, randomUUID } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import { auth } from '../auth/auth.js';
import { pool } from '../../db/pool.js';
import { ensureProfile, validUsername } from './profile.js';
import { publishFriendUpdate } from '../realtime/server.js';
import { env } from '../../config/env.js';

export const socialRoutes = Router();

const authenticated: RequestHandler = async (request, response, next) => {
  try {
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value === 'string') headers.set(key, value);
    }
    const session = await auth.api.getSession({ headers });
    if (!session) { response.status(401).json({ error: 'Sign in to continue.' }); return; }
    response.locals.userId = session.user.id;
    next();
  } catch (error) { next(error); }
};

const run = (handler: RequestHandler): RequestHandler => (request, response, next) => {
  Promise.resolve(handler(request, response, next)).catch(next);
};

socialRoutes.use(authenticated);

socialRoutes.get('/calls/ice', run(async (_request, response) => {
  const iceServers: { urls: string; username?: string; credential?: string }[] = [{ urls: env.stunUrl }];
  if (env.turnUrl && env.turnSharedSecret) {
    const username = `${Math.floor(Date.now() / 1000) + 3600}:${response.locals.userId}`;
    const credential = createHmac('sha1', env.turnSharedSecret).update(username).digest('base64');
    iceServers.push({ urls: env.turnUrl, username, credential });
  }
  response.json({ iceServers });
}));

socialRoutes.get('/me', run(async (_request, response) => {
  const profile = await ensureProfile(response.locals.userId);
  if (!profile) { response.status(404).json({ error: 'User not found.' }); return; }
  response.json(profile);
}));

socialRoutes.patch('/me', run(async (request, response) => {
  const name = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
  const username = typeof request.body?.username === 'string' ? request.body.username.trim().toLowerCase() : '';
  if (name.length < 2 || name.length > 60 || !validUsername(username)) {
    response.status(400).json({ error: 'Use a name of 2–60 characters and a username of 3–24 letters, numbers, dots or underscores.' }); return;
  }
  await ensureProfile(response.locals.userId);
  try {
    const result = await pool.query(
      'UPDATE "user" SET name = $2, username = $3, "updatedAt" = NOW() WHERE id = $1 RETURNING id, name, username, "friendCode"',
      [response.locals.userId, name, username],
    );
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
    `SELECT u.id, u.name, u.username, last.body AS "lastMessage", last."createdAt" AS "lastAt" FROM "contact" c
     JOIN "user" u ON u.id = CASE WHEN c."userA" = $1 THEN c."userB" ELSE c."userA" END
     LEFT JOIN LATERAL (SELECT m.body, m."createdAt" FROM "chat_message" m
       WHERE (m."senderId" = $1 AND m."recipientId" = u.id) OR (m."senderId" = u.id AND m."recipientId" = $1)
       ORDER BY m."createdAt" DESC LIMIT 1) last ON TRUE
     WHERE c."userA" = $1 OR c."userB" = $1 ORDER BY last."createdAt" DESC NULLS LAST, u.name`,
    [response.locals.userId],
  );
  response.json(result.rows);
}));

socialRoutes.get('/people', run(async (request, response) => {
  const search = typeof request.query.search === 'string' ? request.query.search.trim().toLowerCase().slice(0, 24) : '';
  const result = await pool.query(
    `SELECT u.id, u.name, u.username FROM "user" u WHERE u.id <> $1 AND u.username IS NOT NULL
     AND ($2 = '' OR LOWER(u.username) LIKE $2 || '%')
     AND NOT EXISTS (SELECT 1 FROM "contact" c WHERE (c."userA" = $1 AND c."userB" = u.id) OR (c."userB" = $1 AND c."userA" = u.id))
     ORDER BY u."createdAt" DESC LIMIT 20`,
    [response.locals.userId, search],
  );
  response.json(result.rows);
}));

async function requestContact(selfId: string, targetId: string, response: Parameters<RequestHandler>[1]) {
  if (selfId === targetId) { response.status(400).json({ error: 'You cannot add yourself.' }); return; }
  const [userA, userB] = [selfId, targetId].sort();
  const existing = await pool.query('SELECT 1 FROM "contact" WHERE "userA" = $1 AND "userB" = $2', [userA, userB]);
  if (existing.rowCount) { response.status(409).json({ error: 'You are already friends.' }); return; }
  const incoming = await pool.query('SELECT 1 FROM "friend_request" WHERE "senderId" = $1 AND "recipientId" = $2 AND status = $3', [targetId, selfId, 'pending']);
  if (incoming.rowCount) { response.status(409).json({ error: 'This person has sent you a friend request. Open Updates to accept it.' }); return; }
  await pool.query(`INSERT INTO "friend_request" (id, "senderId", "recipientId") VALUES ($1, $2, $3)
    ON CONFLICT ("senderId", "recipientId") DO UPDATE SET status = 'pending', "updatedAt" = NOW()`, [randomUUID(), selfId, targetId]);
  const result = await pool.query('SELECT id, name, username FROM "user" WHERE id = $1', [targetId]);
  response.status(201).json(result.rows[0]);
  publishFriendUpdate([selfId, targetId]);
}

socialRoutes.post('/contacts/username', run(async (request, response) => {
  const username = typeof request.body?.username === 'string' ? request.body.username.trim().toLowerCase() : '';
  if (!validUsername(username)) { response.status(400).json({ error: 'Enter a valid username.' }); return; }
  const result = await pool.query<{id: string}>('SELECT id FROM "user" WHERE LOWER(username) = $1', [username]);
  if (!result.rows[0]) { response.status(404).json({ error: 'No user has that username.' }); return; }
  await requestContact(response.locals.userId, result.rows[0].id, response);
}));

socialRoutes.post('/contacts/qr', run(async (request, response) => {
  const raw = typeof request.body?.code === 'string' ? request.body.code.trim() : '';
  const code = /^adda:friend:v1:([a-f0-9]{48})$/.exec(raw)?.[1];
  if (!code) { response.status(400).json({ error: 'This is not an ADDA friend QR.' }); return; }
  const result = await pool.query<{id: string}>('SELECT id FROM "user" WHERE "friendCode" = $1', [code]);
  if (!result.rows[0]) { response.status(404).json({ error: 'Friend QR not found.' }); return; }
  await requestContact(response.locals.userId, result.rows[0].id, response);
}));

socialRoutes.get('/friend-requests', run(async (_request, response) => {
  const result = await pool.query(
    `SELECT r.id, r."senderId", r."recipientId", r."createdAt", r.status,
       sender.name AS "senderName", sender.username AS "senderUsername",
       recipient.name AS "recipientName", recipient.username AS "recipientUsername"
     FROM "friend_request" r JOIN "user" sender ON sender.id = r."senderId"
       JOIN "user" recipient ON recipient.id = r."recipientId"
     WHERE (r."senderId" = $1 OR r."recipientId" = $1) AND r.status = 'pending'
     ORDER BY r."createdAt" DESC LIMIT 100`, [response.locals.userId],
  );
  response.json(result.rows);
}));

socialRoutes.post('/friend-requests/:id/respond', run(async (request, response) => {
  const decision = request.body?.decision;
  if (decision !== 'accept' && decision !== 'decline') { response.status(400).json({ error: 'Choose accept or decline.' }); return; }
  const client = await pool.connect();
  let parties: string[] = [];
  try {
    await client.query('BEGIN');
    const result = await client.query<{ senderId: string; recipientId: string }>(
      'SELECT "senderId", "recipientId" FROM "friend_request" WHERE id = $1 AND "recipientId" = $2 AND status = $3 FOR UPDATE',
      [request.params.id, response.locals.userId, 'pending'],
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
    response.json({ status: decision === 'accept' ? 'accepted' : 'declined' });
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  publishFriendUpdate(parties);
}));

socialRoutes.get('/groups', run(async (_request, response) => {
  const result = await pool.query(
    `SELECT g.id, g.name, g."createdAt", COUNT(m2."userId")::int AS "memberCount", last.body AS "lastMessage", last."createdAt" AS "lastAt"
     FROM "chat_group" g JOIN "chat_group_member" mine ON mine."groupId" = g.id AND mine."userId" = $1
     JOIN "chat_group_member" m2 ON m2."groupId" = g.id
     LEFT JOIN LATERAL (SELECT body, "createdAt" FROM "chat_message" WHERE "groupId" = g.id ORDER BY "createdAt" DESC LIMIT 1) last ON TRUE
     GROUP BY g.id, last.body, last."createdAt" ORDER BY COALESCE(last."createdAt", g."createdAt") DESC`,
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
    for (const userId of [response.locals.userId, ...ids]) {
      await client.query('INSERT INTO "chat_group_member" ("groupId", "userId") VALUES ($1, $2)', [id, userId]);
    }
    await client.query('COMMIT');
    response.status(201).json({ id, name, memberCount: ids.length + 1 });
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
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
