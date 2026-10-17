import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Server, Socket } from 'socket.io';
import { attachRoomHandlers } from '../dist/modules/realtime/rooms.js';

type Handler = (...args: unknown[]) => void;
type Packet = { event: string; value: Record<string, unknown> };

function roomHarness() {
  const rooms = new Map<string, Set<string>>();
  const sockets = new Map<string, ReturnType<typeof peer>>();
  const io = { sockets: { adapter: { rooms } } } as unknown as Server;

  function peer(id: string) {
    const handlers = new Map<string, Handler>();
    const packets: Packet[] = [];
    const emitToRoom = (room: string, event: string, value: Record<string, unknown>) => {
      for (const member of rooms.get(room) ?? []) {
        if (member !== id) sockets.get(member)?.packets.push({ event, value: { ...value } });
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
      to: (room: string) => ({
        emit: (event: string, value: Record<string, unknown>) => emitToRoom(room, event, value),
        volatile: { emit: (event: string, value: Record<string, unknown>) => emitToRoom(room, event, value) },
      }),
    };
    attachRoomHandlers(io, socket as unknown as Socket);
    const result = { packets, send: (event: string, ...args: unknown[]) => handlers.get(event)?.(...args) };
    sockets.set(id, result);
    return result;
  }

  return { peer };
}

test('room pose reaches active peers and late joiners, with invalid height rejected', () => {
  const room = roomHarness();
  const alice = room.peer('alice');
  const bob = room.peer('bob');
  alice.send('room:join', { room: 'loft', avatar: 'woman' }, () => {});
  bob.send('room:join', { room: 'loft', avatar: 'man' }, () => {});
  bob.packets.length = 0;

  alice.send('room:position', { x: 1, y: 0, z: 2, yaw: 0.2, pose: 'crouch_idle' });
  assert.equal(bob.packets.at(-1)?.value.pose, 'crouch_idle');
  alice.send('room:position', { x: 1, y: 0.25, z: 2, yaw: 0.2, pose: 'sit_idle' });
  assert.equal(bob.packets.at(-1)?.value.pose, 'sit_idle');
  assert.equal(bob.packets.at(-1)?.value.y, 0.25);

  const beforeInvalid = bob.packets.length;
  alice.send('room:position', { x: 1, y: 1000, z: 2, yaw: 0.2, pose: 'sit_idle' });
  assert.equal(bob.packets.length, beforeInvalid);

  const charlie = room.peer('charlie');
  let joined: { value?: { peers: Packet['value'][] } } = {};
  charlie.send('room:join', { room: 'loft', avatar: 'self' }, (reply: typeof joined) => { joined = reply; });
  const sittingPeer = joined.value?.peers.find(item => item.userId === 'alice');
  assert.equal(sittingPeer?.pose, 'sit_idle');
  assert.equal(sittingPeer?.y, 0.25);
});
