import { randomUUID } from 'node:crypto';
import type { Server, Socket } from 'socket.io';
import { pool } from '../../db/pool.js';
import { sendRoomInvitePush } from './push.js';
import { RoomMotionHub } from './motion-hub.js';
import { publishGroupRoomUpdate } from './server.js';
import { closeMediaSession } from './media.js';

export type RoomKind = 'loft' | 'roof' | 'tea' | 'beach';
export type AvatarBody = 'man' | 'uncle' | 'photo_boy' | 'self' | 'woman' | 'chinese_woman' | 'nepali_woman' | 'white_top_woman';
export type RoomPose = 'idle' | 'walk' | 'run' | 'jump' | 'crouch_idle' | 'crouch_walk' | 'sit_enter' | 'sit_idle' | 'sit_exit' | 'lounger_idle';
export type RoomPeer = { userId: string; name: string; avatar: AvatarBody; motionId: number; x: number; y?: number; z: number; yaw: number; vx?: number; vz?: number; pose?: RoomPose };
export type RoomMessage = { id: string; room: string; userId: string; name: string; body: string; createdAt: number };
export type Ack<T> = (reply: { ok: true; value: T } | { ok: false; error: string }) => void;

export type RoomRadioState = {
  enabled: boolean;
  trackIndex: number;
  seekSeconds: number;
  lastUpdated: number;
};

export type RoomJoinResponse = {
  peers: RoomPeer[];
  messages: RoomMessage[];
  radio?: RoomRadioState;
  shardId: string;
  shardIndex: number;
  totalInShard: number;
  ownerId?: string;
  motionProtocol: number;
};

export const BASE_ROOM_IDS = new Set<RoomKind>(['loft', 'roof', 'tea', 'beach']);
export const MAX_SHARD_PEERS = 35; // Maximum players per room shard before dynamically spinning up the next instance

export const groupRoomOwners = new Map<string, string>(); // shardId -> ownerId
export const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes of inactivity
export const roomInactivityTimers = new Map<string, NodeJS.Timeout>();

export async function deleteGroupRoomInstance(io: Server, shardId: string, groupId?: string, reason?: string, roomId?: string) {
  const timer = roomInactivityTimers.get(shardId);
  if (timer) {
    clearTimeout(timer);
    roomInactivityTimers.delete(shardId);
  }

  const effectiveRoomId = roomId || (shardId.startsWith('room:') ? shardId.slice(5) : undefined);
  if (effectiveRoomId) {
    await pool.query('UPDATE "group_room" SET "isActive" = false, "updatedAt" = now() WHERE id = $1', [effectiveRoomId]).catch(() => {});
  } else if (groupId) {
    await pool.query(
      'UPDATE "group_room" SET "isActive" = false, "updatedAt" = now() WHERE "groupId" = $1 AND "isActive" = true',
      [groupId]
    ).catch(() => {});
  }

  groupRoomOwners.delete(shardId);
  roomRadios.delete(shardId);
  messages.delete(shardId);

  const roomSockets = io.sockets.adapter.rooms.get(channel(shardId));
  if (roomSockets) {
    const motionHub = getRoomMotionHub(io);
    for (const sockId of [...roomSockets]) {
      const sock = io.sockets.sockets.get(sockId);
      if (sock) {
        sock.emit('room:deleted', { roomId: shardId, reason: reason || 'Room was closed.' });
        sock.leave(channel(shardId));
        motionHub.leave(shardId, sockId, peers.get(sockId)?.motionId);
        peers.delete(sockId);
        sock.data.roomId = undefined;
        sock.data.baseRoomId = undefined;
        sock.data.groupId = undefined;
        sock.data.motionProtocol = undefined;
      }
    }
  }

  if (groupId) {
    const mems = await pool.query<{ userId: string }>('SELECT "userId" FROM "chat_group_member" WHERE "groupId" = $1', [groupId]).catch(() => ({ rows: [] }));
    publishGroupRoomUpdate(mems.rows.map(r => r.userId), { groupId, active: false });
  }

  io.emit('room:public_closed', { shardId, roomId: effectiveRoomId });

  try {
    await closeMediaSession(shardId);
  } catch (err) {
    console.warn(`[rooms] Error closing media session for ${shardId}:`, err);
  }
}

export function scheduleRoomInactivity(io: Server, shardId: string, groupId?: string, roomId?: string) {
  if (roomInactivityTimers.has(shardId)) {
    clearTimeout(roomInactivityTimers.get(shardId)!);
  }
  const timer = setTimeout(() => {
    roomInactivityTimers.delete(shardId);
    const count = getShardPeerCount(io, shardId);
    if (count === 0) {
      console.log(`[rooms] Room ${shardId} inactive for 10 minutes. Deleting instance...`);
      void deleteGroupRoomInstance(io, shardId, groupId, 'Room was closed after 10 minutes of inactivity.', roomId);
    }
  }, INACTIVITY_TIMEOUT_MS);
  roomInactivityTimers.set(shardId, timer);
}

export function cancelRoomInactivity(shardId: string) {
  const timer = roomInactivityTimers.get(shardId);
  if (timer) {
    clearTimeout(timer);
    roomInactivityTimers.delete(shardId);
  }
}

let sweeperStarted = false;
export function initRoomInactivitySweeper(io: Server) {
  if (sweeperStarted) return;
  sweeperStarted = true;
  setInterval(async () => {
    try {
      const activeGroupRooms = await pool.query<{
        id: string;
        groupId: string;
        roomKind: string;
        updatedAt: string;
        createdAt: string;
      }>(
        `SELECT id, "groupId", "roomKind", "updatedAt", "createdAt"
         FROM "group_room"
         WHERE "isActive" = true`
      );

      for (const room of activeGroupRooms.rows) {
        const shardId = room.groupId ? `group:${room.groupId}:${room.roomKind}` : `room:${room.id}`;
        const count = getShardPeerCount(io, shardId);
        if (count === 0) {
          const lastActivity = new Date(room.updatedAt || room.createdAt).getTime();
          if (Date.now() - lastActivity > INACTIVITY_TIMEOUT_MS) {
            console.log(`[rooms sweeper] Room ${shardId} inactive for > 10m. Cleaning up...`);
            void deleteGroupRoomInstance(io, shardId, room.groupId, 'Room auto-closed after 10 minutes of inactivity.', room.id);
          }
        }
      }
    } catch (err) {
      console.warn('[rooms sweeper] Error checking inactive rooms:', err);
    }
  }, 2 * 60 * 1000);
}
const avatars = new Set<AvatarBody>(['man', 'uncle', 'photo_boy', 'self', 'woman', 'chinese_woman', 'nepali_woman', 'white_top_woman']);
const poses = new Set<RoomPose>(['idle', 'walk', 'run', 'jump', 'crouch_idle', 'crouch_walk', 'sit_enter', 'sit_idle', 'sit_exit', 'lounger_idle']);
const motionHubs = new WeakMap<Server, RoomMotionHub>();
export function getRoomMotionHub(io: Server) {
  let hub = motionHubs.get(io);
  if (!hub) { hub = new RoomMotionHub(io); motionHubs.set(io, hub); }
  return hub;
}
const peers = new Map<string, RoomPeer>();
const messages = new Map<string, RoomMessage[]>();
const roomRadios = new Map<string, RoomRadioState>();

// Default base radios
const defaultRadios: Record<RoomKind, RoomRadioState> = {
  tea: { enabled: false, trackIndex: 0, seekSeconds: 0, lastUpdated: Date.now() },
  beach: { enabled: false, trackIndex: 1, seekSeconds: 0, lastUpdated: Date.now() },
  loft: { enabled: false, trackIndex: 2, seekSeconds: 0, lastUpdated: Date.now() },
  roof: { enabled: false, trackIndex: 3, seekSeconds: 0, lastUpdated: Date.now() },
};

export const channel = (shardId: string) => `presence:${shardId}`;

export function parseRoomInput(roomInput: string): { baseRoom: RoomKind; shardIndex?: number; groupId?: string; roomId?: string } | null {
  if (!roomInput || typeof roomInput !== 'string') return null;
  const parts = roomInput.trim().split(':');
  if (parts[0] === 'room' && parts[1]) {
    const roomId = parts[1];
    const kind = (parts[2] || 'loft') as RoomKind;
    return { baseRoom: BASE_ROOM_IDS.has(kind) ? kind : 'loft', roomId };
  }
  if (parts[0] === 'group' && parts[1]) {
    const groupId = parts[1];
    const kind = (parts[2] || 'loft') as RoomKind;
    if (!BASE_ROOM_IDS.has(kind)) return null;
    return { baseRoom: kind, groupId };
  }
  const base = parts[0] as RoomKind;
  if (!BASE_ROOM_IDS.has(base)) return null;
  const shardNum = parts[1] ? parseInt(parts[1], 10) : undefined;
  return { baseRoom: base, shardIndex: shardNum && shardNum > 0 ? shardNum : undefined };
}

export function getShardPeerCount(io: Server, shardId: string): number {
  return io.sockets.adapter.rooms.get(channel(shardId))?.size ?? 0;
}

export function resolveShard(io: Server, baseRoom: RoomKind, preferredShardIndex?: number): { shardId: string; shardIndex: number } {
  // 1. If explicit shard requested, attempt to place user in that shard if below grace capacity
  if (preferredShardIndex && preferredShardIndex > 0) {
    const requestedShardId = `${baseRoom}:${preferredShardIndex}`;
    const count = getShardPeerCount(io, requestedShardId);
    if (count < MAX_SHARD_PEERS + 10) {
      return { shardId: requestedShardId, shardIndex: preferredShardIndex };
    }
  }

  // 2. Auto-assignment: Scan sequentially starting from Shard 1 to pack instances efficiently
  let candidateIndex = 1;
  while (candidateIndex <= 200) {
    const candidateId = `${baseRoom}:${candidateIndex}`;
    const count = getShardPeerCount(io, candidateId);
    if (count < MAX_SHARD_PEERS) {
      return { shardId: candidateId, shardIndex: candidateIndex };
    }
    candidateIndex++;
  }

  return { shardId: `${baseRoom}:1`, shardIndex: 1 };
}

export function attachRoomHandlers(io: Server, socket: Socket) {
  initRoomInactivitySweeper(io);
  const motionHub = getRoomMotionHub(io);
  const userId = socket.data.userId as string;
  const name = socket.data.name as string;

  const leave = () => {
    const shardId = socket.data.roomId as string | undefined;
    motionHub.leave(shardId, socket.id, peers.get(socket.id)?.motionId);
    socket.data.roomId = undefined;
    socket.data.baseRoomId = undefined;
    socket.data.groupId = undefined;
    socket.data.motionProtocol = undefined;
    peers.delete(socket.id);

    if (shardId) {
      socket.leave(channel(shardId));
      socket.to(channel(shardId)).emit('room:peer-left', { userId });
      const remaining = getShardPeerCount(io, shardId);
      if (remaining === 0) {
        const currentRadio = roomRadios.get(shardId);
        if (currentRadio) {
          currentRadio.enabled = false;
          currentRadio.seekSeconds = 0;
          currentRadio.lastUpdated = Date.now();
          roomRadios.set(shardId, currentRadio);
        }
        if (shardId.startsWith('group:')) {
          const parts = shardId.split(':');
          const gId = parts[1];
          scheduleRoomInactivity(io, shardId, gId);
        } else if (shardId.startsWith('room:')) {
          const rId = shardId.slice(5);
          scheduleRoomInactivity(io, shardId, undefined, rId);
        }
      }
    }
  };

  socket.on('room:join', async (input: { room?: string; avatar?: string; shard?: number | string; groupId?: string; roomId?: string; motionProtocol?: number }, ack?: Ack<RoomJoinResponse>) => {
    const parsed = parseRoomInput(input?.room ?? '');
    if (!parsed || !avatars.has(input?.avatar as AvatarBody)) {
      ack?.({ ok: false, error: 'Invalid room or avatar.' });
      return;
    }

    const targetRoomId = input?.roomId || parsed.roomId;
    const targetGroupId = input?.groupId || parsed.groupId;

    if (targetRoomId) {
      const roomRow = await pool.query<{ id: string; creatorId: string; roomKind: string; isPrivate: boolean; name: string }>(
        'SELECT id, "creatorId", "roomKind", "isPrivate", name FROM "group_room" WHERE id = $1 AND "isActive" = true LIMIT 1',
        [targetRoomId]
      );
      if (!roomRow.rows.length) {
        ack?.({ ok: false, error: 'This server has ended or does not exist.' });
        return;
      }
      const roomData = roomRow.rows[0];
      if (roomData.isPrivate && roomData.creatorId !== userId) {
        const invCheck = await pool.query(
          `SELECT 1 FROM "room_invite" WHERE "roomId" = $1 AND "inviteeId" = $2 AND status != 'dismissed'
           UNION
           SELECT 1 FROM "chat_group_member" m
           JOIN "room_invite" ri ON ri."groupId" = m."groupId"
           WHERE ri."roomId" = $1 AND m."userId" = $2 AND ri.status != 'dismissed'`,
          [targetRoomId, userId]
        );
        if (!invCheck.rows.length) {
          ack?.({ ok: false, error: 'This private server is invite-only.' });
          return;
        }
      }

      leave();
      let shardId: string = `room:${targetRoomId}`;
      cancelRoomInactivity(shardId);
      let shardIndex: number = 1;
      let ownerId: string | undefined = roomData.creatorId;
      groupRoomOwners.set(shardId, ownerId);

      const peer: RoomPeer = { userId, name, avatar: input.avatar as AvatarBody, motionId: motionHub.allocateId(), x: 0, z: 0, yaw: 0 };
      socket.data.roomId = shardId;
      socket.data.baseRoomId = parsed.baseRoom;
      socket.data.motionProtocol = input.motionProtocol === 2 ? 2 : 1;
      socket.join(channel(shardId));
      peers.set(socket.id, peer);
      motionHub.join(shardId, socket, peer);

      const existingPeers = [...io.sockets.adapter.rooms.get(channel(shardId)) ?? []]
        .filter(id => id !== socket.id)
        .map(id => peers.get(id))
        .filter((value): value is RoomPeer => !!value);

      let currentRadio = roomRadios.get(shardId);
      if (!currentRadio) {
        const baseRadio = defaultRadios[parsed.baseRoom];
        currentRadio = { ...baseRadio, enabled: true, lastUpdated: Date.now() };
        roomRadios.set(shardId, currentRadio);
      } else if (existingPeers.length === 0) {
        currentRadio.enabled = true;
        currentRadio.lastUpdated = Date.now();
      }

      const shardMessages = messages.get(shardId) ?? [];
      ack?.({
        ok: true,
        value: {
          peers: existingPeers,
          messages: shardMessages,
          radio: currentRadio,
          shardId,
          shardIndex,
          totalInShard: existingPeers.length + 1,
          ownerId,
          motionProtocol: socket.data.motionProtocol,
        },
      });

      socket.to(channel(shardId)).emit('room:peer', peer);
      return;
    }

    if (targetGroupId) {
      const mem = await pool.query('SELECT 1 FROM "chat_group_member" WHERE "groupId" = $1 AND "userId" = $2', [targetGroupId, userId]);
      if (!mem.rows.length) {
        const inv = await pool.query('SELECT 1 FROM "room_invite" WHERE "groupId" = $1 AND "inviteeId" = $2 AND status != \'dismissed\'', [targetGroupId, userId]);
        if (!inv.rows.length) {
          ack?.({ ok: false, error: 'Only members of this group or invited guests can enter this room.' });
          return;
        }
      }
    }

    leave();

    let shardId: string;
    let shardIndex: number;
    let ownerId: string | undefined;

    if (targetGroupId) {
      shardId = `group:${targetGroupId}:${parsed.baseRoom}`;
      cancelRoomInactivity(shardId);
      shardIndex = 1;
      ownerId = groupRoomOwners.get(shardId);
      if (!ownerId) {
        const roomRow = await pool.query<{ id: string; creatorId: string }>(
          'SELECT id, "creatorId" FROM "group_room" WHERE "groupId" = $1 AND "isActive" = true ORDER BY "createdAt" DESC LIMIT 1',
          [targetGroupId]
        );
        if (roomRow.rows.length) {
          ownerId = roomRow.rows[0].creatorId;
        } else {
          ownerId = userId;
          const rId = input.roomId || randomUUID();
          await pool.query(
            'INSERT INTO "group_room" (id, "groupId", "roomKind", "creatorId", "isActive") VALUES ($1, $2, $3, $4, true)',
            [rId, targetGroupId, parsed.baseRoom, userId]
          ).catch(() => {});
        }
        groupRoomOwners.set(shardId, ownerId);
      }
      socket.data.groupId = targetGroupId;
    } else {
      const explicitShard = typeof input.shard === 'number'
        ? input.shard
        : typeof input.shard === 'string'
          ? parseInt(input.shard, 10)
          : parsed.shardIndex;
      const resolved = resolveShard(io, parsed.baseRoom, explicitShard);
      shardId = resolved.shardId;
      shardIndex = resolved.shardIndex;
    }

    const peer: RoomPeer = { userId, name, avatar: input.avatar as AvatarBody, motionId: motionHub.allocateId(), x: 0, z: 0, yaw: 0 };

    socket.data.roomId = shardId;
    socket.data.baseRoomId = parsed.baseRoom;
    socket.data.motionProtocol = input.motionProtocol === 2 ? 2 : 1;
    socket.join(channel(shardId));
    peers.set(socket.id, peer);
    motionHub.join(shardId, socket, peer);

    const existingPeers = [...io.sockets.adapter.rooms.get(channel(shardId)) ?? []]
      .filter(id => id !== socket.id)
      .map(id => peers.get(id))
      .filter((value): value is RoomPeer => !!value);

    // Get or initialize radio for this shard
    let currentRadio = roomRadios.get(shardId);
    if (!currentRadio) {
      const baseRadio = defaultRadios[parsed.baseRoom];
      currentRadio = { ...baseRadio, enabled: true, lastUpdated: Date.now() };
      roomRadios.set(shardId, currentRadio);
    } else if (existingPeers.length === 0) {
      currentRadio.enabled = true;
      currentRadio.lastUpdated = Date.now();
    }

    const shardMessages = messages.get(shardId) ?? [];
    ack?.({
      ok: true,
      value: {
        peers: existingPeers,
        messages: shardMessages,
        radio: currentRadio,
        shardId,
        shardIndex,
        totalInShard: existingPeers.length + 1,
        ownerId,
        motionProtocol: 2,
      },
    });

    socket.to(channel(shardId)).emit('room:peer', peer);
  });

  socket.on('room:position', (input: { x?: number; y?: number; z?: number; yaw?: number; pose?: RoomPose }) => {
    const shardId = socket.data.roomId as string | undefined;
    const peer = peers.get(socket.id);
    if (!shardId || !peer || !Number.isFinite(input?.x) || !Number.isFinite(input?.z) || !Number.isFinite(input?.yaw) ||
      Math.abs(input.x!) > 100 || Math.abs(input.z!) > 100 ||
      (input.y !== undefined && (!Number.isFinite(input.y) || input.y < 0 || input.y > 3)) ||
      (input.pose !== undefined && !poses.has(input.pose))) return;

    motionHub.receiveLegacy(socket, input as { x: number; y?: number; z: number; yaw: number; pose?: RoomPose });
  });

  socket.on('room:motion', (input: unknown) => {
    if (socket.data.motionProtocol === 2) motionHub.receive(socket, input);
  });

  socket.on('room:message', (body: unknown, ack?: Ack<RoomMessage>) => {
    const shardId = socket.data.roomId as string | undefined;
    const value = typeof body === 'string' ? body.trim() : '';
    if (!shardId || !value || value.length > 500) {
      ack?.({ ok: false, error: 'Enter a message of up to 500 characters.' });
      return;
    }
    const message: RoomMessage = {
      id: `${socket.id}:${Date.now()}:${Math.random()}`,
      room: shardId,
      userId,
      name,
      body: value,
      createdAt: Date.now(),
    };
    const history = messages.get(shardId) ?? [];
    history.push(message);
    if (history.length > 50) history.shift();
    messages.set(shardId, history);

    io.to(channel(shardId)).emit('room:message', message);
    ack?.({ ok: true, value: message });
  });

  socket.on('room:radio-sync', (input: { enabled?: boolean; trackIndex?: number; seekSeconds?: number }) => {
    const shardId = socket.data.roomId as string | undefined;
    if (!shardId) return;
    const baseRoom = socket.data.baseRoomId as RoomKind | undefined;
    const fallback = baseRoom ? defaultRadios[baseRoom] : defaultRadios.beach;
    const current = roomRadios.get(shardId) ?? { ...fallback, enabled: true, lastUpdated: Date.now() };

    if (typeof input?.enabled === 'boolean') current.enabled = input.enabled;
    if (typeof input?.trackIndex === 'number' && input.trackIndex >= 0 && input.trackIndex < 100) current.trackIndex = input.trackIndex;
    if (typeof input?.seekSeconds === 'number' && input.seekSeconds >= 0) current.seekSeconds = input.seekSeconds;

    current.lastUpdated = Date.now();
    roomRadios.set(shardId, current);
    socket.to(channel(shardId)).emit('room:radio-sync', current);
  });

  socket.on('room:shards', (roomKindInput: string, ack?: Ack<Array<{ shardId: string; shardIndex: number; count: number }>>) => {
    const parsed = parseRoomInput(roomKindInput);
    if (!parsed) {
      ack?.({ ok: false, error: 'Invalid room.' });
      return;
    }
    const base = parsed.baseRoom;
    const result: Array<{ shardId: string; shardIndex: number; count: number }> = [];
    for (let i = 1; i <= 20; i++) {
      const sid = `${base}:${i}`;
      const count = getShardPeerCount(io, sid);
      if (count > 0 || i === 1) {
        result.push({ shardId: sid, shardIndex: i, count });
      }
    }
    ack?.({ ok: true, value: result });
  });

  // HOST MODERATION: Kick player from room
  socket.on('room:kick', async (data: { targetUserId: string }, ack?: Ack<{ kicked: boolean }>) => {
    const shardId = socket.data.roomId as string | undefined;
    if (!shardId || !shardId.startsWith('group:')) {
      ack?.({ ok: false, error: 'Kick is only available in group rooms.' });
      return;
    }
    const targetUserId = data?.targetUserId;
    if (!targetUserId || targetUserId === userId) {
      ack?.({ ok: false, error: 'Invalid target player.' });
      return;
    }

    let ownerId = groupRoomOwners.get(shardId);
    if (!ownerId) {
      const parts = shardId.split(':');
      const gId = parts[1];
      const roomRow = await pool.query<{ creatorId: string }>(
        'SELECT "creatorId" FROM "group_room" WHERE "groupId" = $1 AND "isActive" = true ORDER BY "createdAt" DESC LIMIT 1',
        [gId]
      );
      if (roomRow.rows.length) {
        ownerId = roomRow.rows[0].creatorId;
        groupRoomOwners.set(shardId, ownerId);
      }
    }

    if (ownerId !== userId) {
      ack?.({ ok: false, error: 'Only the room creator can kick players.' });
      return;
    }

    const roomSockets = io.sockets.adapter.rooms.get(channel(shardId));
    if (roomSockets) {
      for (const sockId of [...roomSockets]) {
        const sock = io.sockets.sockets.get(sockId);
        if (sock && sock.data.userId === targetUserId) {
          sock.emit('room:kicked', { roomId: shardId, reason: 'You have been removed by the room host.' });
          sock.leave(channel(shardId));
          motionHub.leave(shardId, sockId, peers.get(sockId)?.motionId);
          peers.delete(sockId);
          sock.data.roomId = undefined;
          sock.data.baseRoomId = undefined;
          sock.data.groupId = undefined;
          sock.data.motionProtocol = undefined;
        }
      }
    }

    io.to(channel(shardId)).emit('room:peer-left', { userId: targetUserId });
    ack?.({ ok: true, value: { kicked: true } });
  });

  // HOST MODERATION: Delete & close room completely
  socket.on('room:delete', async (_data, ack?: Ack<{ deleted: boolean }>) => {
    const shardId = socket.data.roomId as string | undefined;
    if (!shardId || !shardId.startsWith('group:')) {
      ack?.({ ok: false, error: 'Only group rooms can be deleted.' });
      return;
    }
    const parts = shardId.split(':');
    const groupId = parts[1];
    let ownerId = groupRoomOwners.get(shardId);
    if (!ownerId) {
      const roomRow = await pool.query<{ creatorId: string }>(
        'SELECT "creatorId" FROM "group_room" WHERE "groupId" = $1 AND "isActive" = true ORDER BY "createdAt" DESC LIMIT 1',
        [groupId]
      );
      if (roomRow.rows.length) ownerId = roomRow.rows[0].creatorId;
    }
    if (ownerId !== userId) {
      ack?.({ ok: false, error: 'Only the room host can delete this room.' });
      return;
    }

    await deleteGroupRoomInstance(io, shardId, groupId, 'The host has ended and deleted this room.');
    ack?.({ ok: true, value: { deleted: true } });
  });

  // Helper for sending invitations to a list of user IDs
  async function sendInvitesToList(shardId: string, targetUserIds: string[]): Promise<number> {
    if (shardId.startsWith('room:')) {
      const roomId = shardId.split(':')[1];
      const roomRecord = await pool.query<{ id: string; creatorId: string; roomKind: string; name: string; isPrivate: boolean }>(
        'SELECT id, "creatorId", "roomKind", name, "isPrivate" FROM "group_room" WHERE id = $1 AND "isActive" = true',
        [roomId]
      );
      if (!roomRecord.rows.length) return 0;
      const r = roomRecord.rows[0];

      for (const targetId of targetUserIds) {
        const inviteId = randomUUID();
        await pool.query(
          `INSERT INTO "room_invite" (id, "roomId", "inviteeId", "inviterId", "roomKind", "roomName", "isPrivate", status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
           ON CONFLICT ("roomId", "inviteeId") DO UPDATE SET status = 'pending', "updatedAt" = now()`,
          [inviteId, roomId, targetId, userId, r.roomKind, r.name, r.isPrivate]
        );

        io.to(`user:${targetId}`).emit('room:invitation', {
          id: inviteId,
          roomId,
          roomName: r.name,
          inviterId: userId,
          inviterName: name,
          roomKind: r.roomKind,
          ownerId: r.creatorId,
          isPrivate: r.isPrivate,
          createdAt: new Date().toISOString(),
        });
      }

      void sendRoomInvitePush(targetUserIds, {
        inviterName: name,
        roomKind: r.roomKind,
        roomId,
        ownerId: r.creatorId,
        roomName: r.name,
        isPrivate: r.isPrivate,
      }).catch(err => console.warn('[ADDA] Push room invite error:', err));

      return targetUserIds.length;
    }

    const parts = shardId.split(':');
    const groupId = parts[1];
    const roomKind = (parts[2] || socket.data.baseRoomId || 'loft') as RoomKind;

    const groupRes = await pool.query<{ name: string; ownerId: string }>(
      'SELECT name, "ownerId" FROM "chat_group" WHERE id = $1',
      [groupId]
    );
    const groupName = groupRes.rows[0]?.name || 'Group';

    const roomRecord = await pool.query<{ id: string; creatorId: string }>(
      'SELECT id, "creatorId" FROM "group_room" WHERE "groupId" = $1 AND "isActive" = true ORDER BY "createdAt" DESC LIMIT 1',
      [groupId]
    );
    let rId = roomRecord.rows[0]?.id;
    const roomOwnerId = roomRecord.rows[0]?.creatorId || groupRoomOwners.get(shardId) || userId;

    if (!rId) {
      rId = randomUUID();
      await pool.query(
        'INSERT INTO "group_room" (id, "groupId", "roomKind", "creatorId", "isActive") VALUES ($1, $2, $3, $4, true)',
        [rId, groupId, roomKind, roomOwnerId]
      ).catch(() => {});
    }

    for (const targetId of targetUserIds) {
      const inviteId = randomUUID();
      await pool.query(
        `INSERT INTO "room_invite" (id, "roomId", "groupId", "inviterId", "inviteeId", "roomKind", "roomName", "isPrivate", status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, 'pending')
         ON CONFLICT ("roomId", "inviteeId") DO UPDATE SET status = 'pending', "updatedAt" = now()`,
        [inviteId, rId, groupId, userId, targetId, roomKind, groupName]
      );

      io.to(`user:${targetId}`).emit('room:invitation', {
        id: inviteId,
        roomId: rId,
        groupId,
        groupName,
        inviterId: userId,
        inviterName: name,
        roomKind,
        ownerId: roomOwnerId,
        createdAt: new Date().toISOString(),
      });
    }

    void sendRoomInvitePush(targetUserIds, {
      inviterName: name,
      groupName,
      roomKind,
      groupId,
      roomId: rId,
      ownerId: roomOwnerId,
    }).catch(err => console.warn('[ADDA] Push room invite error:', err));

    return targetUserIds.length;
  }

  // INVITE SYSTEM: Invite players (group members or friends) to current room
  socket.on('room:invite', async (data: { inviteeIds: string[] }, ack?: Ack<{ invitedCount: number }>) => {
    const shardId = socket.data.roomId as string | undefined;
    if (!shardId || (!shardId.startsWith('group:') && !shardId.startsWith('room:'))) {
      ack?.({ ok: false, error: 'Invites are only available in active room instances.' });
      return;
    }

    const rawIds = Array.isArray(data?.inviteeIds) ? data.inviteeIds : [];
    const inviteeIds = [...new Set(rawIds.filter(id => typeof id === 'string' && id !== userId))];
    if (!inviteeIds.length) {
      ack?.({ ok: false, error: 'Select at least one player to invite.' });
      return;
    }

    // Allow ANY valid user (group member or friend from contacts list)
    const validUsers = await pool.query<{ id: string }>(
      'SELECT id FROM "user" WHERE id = ANY($1::text[])',
      [inviteeIds]
    );
    const validUserIds = validUsers.rows.map(r => r.id);
    if (!validUserIds.length) {
      ack?.({ ok: false, error: 'None of the selected users could be found.' });
      return;
    }

    const count = await sendInvitesToList(shardId, validUserIds);
    ack?.({ ok: true, value: { invitedCount: count } });
  });

  // INVITE SYSTEM: Invite an entire other group to the room
  socket.on('room:invite-group', async (data: { targetGroupId: string }, ack?: Ack<{ invitedCount: number }>) => {
    const shardId = socket.data.roomId as string | undefined;
    if (!shardId || (!shardId.startsWith('group:') && !shardId.startsWith('room:'))) {
      ack?.({ ok: false, error: 'Invites are only available in active room instances.' });
      return;
    }
    const targetGroupId = data?.targetGroupId;
    if (!targetGroupId) {
      ack?.({ ok: false, error: 'Target group ID is required.' });
      return;
    }

    // Verify caller belongs to the target group
    const checkMem = await pool.query('SELECT 1 FROM "chat_group_member" WHERE "groupId" = $1 AND "userId" = $2', [targetGroupId, userId]);
    if (!checkMem.rows.length) {
      ack?.({ ok: false, error: 'You are not a member of the target group.' });
      return;
    }

    const otherMembers = await pool.query<{ userId: string }>(
      'SELECT "userId" FROM "chat_group_member" WHERE "groupId" = $1 AND "userId" != $2',
      [targetGroupId, userId]
    );
    const memberIds = otherMembers.rows.map(r => r.userId);
    if (!memberIds.length) {
      ack?.({ ok: false, error: 'No other members in that group to invite.' });
      return;
    }

    if (shardId.startsWith('room:')) {
      const roomId = shardId.split(':')[1];
      const roomRecord = await pool.query<{ id: string; creatorId: string; roomKind: string; name: string; isPrivate: boolean }>(
        'SELECT id, "creatorId", "roomKind", name, "isPrivate" FROM "group_room" WHERE id = $1 AND "isActive" = true',
        [roomId]
      );
      if (!roomRecord.rows.length) {
        ack?.({ ok: false, error: 'Active room not found.' });
        return;
      }
      const r = roomRecord.rows[0];
      const inviteId = randomUUID();
      await pool.query(
        `INSERT INTO "room_invite" (id, "roomId", "groupId", "inviterId", "roomKind", "roomName", "isPrivate", status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
        [inviteId, roomId, targetGroupId, userId, r.roomKind, r.name, r.isPrivate]
      );

      const groupRes = await pool.query<{ name: string }>('SELECT name FROM "chat_group" WHERE id = $1', [targetGroupId]);
      const gName = groupRes.rows[0]?.name || 'Group';

      publishGroupRoomUpdate(memberIds, {
        roomId,
        roomKind: r.roomKind,
        name: r.name,
        isPrivate: r.isPrivate,
        creatorId: r.creatorId,
        creatorName: name,
        groupId: targetGroupId,
        groupName: gName,
      });

      void sendRoomInvitePush(memberIds, {
        inviterName: name,
        groupName: gName,
        roomKind: r.roomKind,
        groupId: targetGroupId,
        roomId,
        ownerId: r.creatorId,
        roomName: r.name,
        isPrivate: r.isPrivate,
      });

      ack?.({ ok: true, value: { invitedCount: memberIds.length } });
      return;
    }

    const count = await sendInvitesToList(shardId, memberIds);
    ack?.({ ok: true, value: { invitedCount: count } });
  });

  socket.on('room:leave', leave);
  socket.on('disconnect', leave);
}
