import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Server, Socket } from 'socket.io';
import { attachRoomHandlers, getRoomMotionHub } from '../dist/modules/realtime/rooms.js';
import { decodeMotionBatch, encodeMotion } from '../dist/modules/realtime/motion-codec.js';

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

test('room pose reaches active peers and late joiners, with invalid height rejected', async () => {
  const room = roomHarness();
  const alice = room.peer('alice');
  const bob = room.peer('bob');
  alice.send('room:join', { room: 'loft', avatar: 'woman' }, () => {});
  bob.send('room:join', { room: 'loft', avatar: 'man' }, () => {});
  bob.packets.length = 0;

  alice.send('room:position', { x: 1, y: 0, z: 2, yaw: 0.2, pose: 'crouch_idle' });
  assert.equal(bob.packets.at(-1)?.value.pose, 'crouch_idle');
  await new Promise(resolve => setTimeout(resolve, 30));
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

test('compact motion is batched to current peers and preserved for late joiners', () => {
  const room = roomHarness();
  const alice = room.peer('alice');
  const bob = room.peer('bob');
  let bobJoin: any;
  alice.send('room:join', { room: 'loft', avatar: 'woman', motionProtocol: 2 }, () => {});
  bob.send('room:join', { room: 'loft', avatar: 'man', motionProtocol: 2 }, (reply: any) => { bobJoin = reply; });
  bob.packets.length = 0;

  alice.send('room:motion', encodeMotion({ motionId: 0, seq: 1, x: 1, y: 0, z: 2, yaw: 0.2, vx: 2, vz: 0, pose: 'walk' }));
  getRoomMotionHub(room.io).flush('loft:1');
  const batch = decodeMotionBatch(bob.packets.at(-1)?.value);
  assert.equal(bob.packets.at(-1)?.event, 'room:motion-batch');
  assert.equal(batch?.[0].motionId, bobJoin.value.peers.find((peer: any) => peer.userId === 'alice')?.motionId);
  assert.equal(batch?.[0].x, 1);
  assert.equal(batch?.[0].pose, 'walk');

  const before = bob.packets.length;
  alice.send('room:motion', encodeMotion({ motionId: 0, seq: 1, x: 9, y: 0, z: 9, yaw: 0, vx: 0, vz: 0, pose: 'idle' }));
  getRoomMotionHub(room.io).flush('loft:1');
  assert.equal(bob.packets.length, before, 'duplicate sequence is rejected');

  const charlie = room.peer('charlie');
  let joined: any;
  charlie.send('room:join', { room: 'loft', avatar: 'self', motionProtocol: 2 }, (reply: any) => { joined = reply; });
  assert.equal(joined.value.peers.find((peer: any) => peer.userId === 'alice')?.x, 1);
});

test('new motion reaches older clients and invalid movement is discarded', () => {
  const room = roomHarness();
  const alice = room.peer('alice');
  const bob = room.peer('bob');
  alice.send('room:join', { room: 'loft', avatar: 'woman', motionProtocol: 2 }, () => {});
  bob.send('room:join', { room: 'loft', avatar: 'man' }, () => {});
  bob.packets.length = 0;
  alice.send('room:motion', encodeMotion({ motionId: 0, seq: 1, x: 1, y: 0, z: 0, yaw: 0, vx: 1, vz: 0, pose: 'walk' }));
  assert.equal(bob.packets.at(-1)?.event, 'room:peer');
  assert.equal(bob.packets.at(-1)?.value.x, 1);
  const count = bob.packets.length;
  alice.send('room:motion', encodeMotion({ motionId: 0, seq: 2, x: 99, y: 0, z: 0, yaw: 0, vx: 1, vz: 0, pose: 'idle' }));
  assert.equal(bob.packets.length, count);
});
