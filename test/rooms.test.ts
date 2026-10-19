import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Server, Socket } from 'socket.io';
import { attachRoomHandlers } from '../dist/modules/realtime/rooms.js';

type Handler = (...args: unknown[]) => void;
type Packet = { event: string; value: any };

function roomHarness() {
  const rooms = new Map<string, Set<string>>();
  const sockets = new Map<string, ReturnType<typeof peer>>();
  const liveSockets = new Map<string, Socket>();
  const io = { sockets: { adapter: { rooms }, sockets: liveSockets } } as unknown as Server;

  function peer(id: string) {
    const handlers = new Map<string, Handler>();
    const packets: Packet[] = [];
    const emitToRoom = (room: string, event: string, value: unknown) => {
      for (const member of rooms.get(room) ?? []) {
        if (member !== id) sockets.get(member)?.packets.push({ event, value });
      }
    };
    const socket = {
      id,
      data: { userId: id, name: id },
      on: (event: string, handler: Handler) => { handlers.set(event, handler); },
      join: (room: string) => {
        const members = rooms.get(room) ?? new Set<string>();
        members.add(id);
        rooms.set(room, members);
      },
      leave: (room: string) => { rooms.get(room)?.delete(id); },
      emit: (event: string, value: unknown) => { packets.push({ event, value }); },
      volatile: { emit: (event: string, value: unknown) => { packets.push({ event, value }); } },
      to: (room: string) => ({
        emit: (event: string, value: Record<string, unknown>) => emitToRoom(room, event, value),
        volatile: { emit: (event: string, value: Record<string, unknown>) => emitToRoom(room, event, value) },
      }),
    };
    liveSockets.set(id, socket as unknown as Socket);
    attachRoomHandlers(io, socket as unknown as Socket);
    const result = { packets, send: (event: string, ...args: unknown[]) => handlers.get(event)?.(...args) };
    sockets.set(id, result);
    return result;
  }

  return { peer, io };
}

test('room snapshot reaches active peers with authoritative server timestamp and validation', async () => {
  const room = roomHarness();
  const alice = room.peer('alice');
  const bob = room.peer('bob');
  alice.send('room:join', { room: 'loft', avatar: 'woman' }, () => {});
  bob.send('room:join', { room: 'loft', avatar: 'man' }, () => {});
  bob.packets.length = 0;

  const beforeTime = Date.now();
  alice.send('room:snapshot', { x: 1.5, y: 0, z: 2.5, r: 0.2, pose: 'walk' });
  const snapshotPacket = bob.packets.find(p => p.event === 'room:snapshot');
  assert.ok(snapshotPacket, 'bob should receive room:snapshot');
  assert.equal(snapshotPacket.value.id, 'alice');
  assert.equal(snapshotPacket.value.x, 1.5);
  assert.equal(snapshotPacket.value.z, 2.5);
  assert.equal(snapshotPacket.value.r, 0.2);
  assert.equal(snapshotPacket.value.pose, 'walk');
  assert.ok(snapshotPacket.value.time >= beforeTime, 'server must stamp authoritative monotonic time');

  // Invalid out-of-bounds movement is dropped
  const countBefore = bob.packets.length;
  alice.send('room:snapshot', { x: 999, y: 0, z: 2.5, r: 0.2, pose: 'idle' });
  assert.equal(bob.packets.length, countBefore, 'out-of-bounds movement (>100m) must be rejected');

  // Late joiner sees alice's latest position and pose
  const charlie = room.peer('charlie');
  let joined: { value?: { peers: Packet['value'][] } } = {};
  charlie.send('room:join', { room: 'loft', avatar: 'self' }, (reply: typeof joined) => { joined = reply; });
  const alicePeer = joined.value?.peers.find(item => item.userId === 'alice');
  assert.equal(alicePeer?.x, 1.5);
  assert.equal(alicePeer?.z, 2.5);
  assert.equal(alicePeer?.pose, 'walk');
});
