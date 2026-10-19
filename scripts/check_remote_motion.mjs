import assert from 'node:assert/strict';
import test from 'node:test';
import { predictRemoteMotion } from '../src/three/player/remoteMotion.ts';
import { decodeMotionBatch, encodeMotion, encodeMotionBatch, isNewerSequence } from '../src/lib/room-motion-codec.ts';

const sample = (x, at, pose = 'walk', vx = 2) => ({
  peer: { userId: 'peer', name: 'Peer', avatar: 'man', x, y: 0, z: 0, yaw: 0, vx, vz: 0, pose },
  receivedAt: at,
});

test('predicts between sparse updates and stops prediction when a packet is stale', () => {
  assert.equal(predictRemoteMotion(sample(1, 1000), 1150).x, 1.3);
  assert.equal(predictRemoteMotion(sample(1, 1000), 2000).x, 1.9);
});

test('idle, seated and crouching avatars stay at their reported position', () => {
  for (const pose of ['idle', 'sit_idle', 'crouch_idle']) assert.equal(predictRemoteMotion(sample(1, 1000, pose), 1400).x, 1);
});

test('compact packets retain pose and velocity, reject malformed batches', () => {
  const state = { motionId: 123, seq: 42, x: 1.23, y: 0.25, z: -2.5, yaw: 0.75, vx: 2, vz: -1, pose: 'sit_idle' };
  const packet = encodeMotion(state);
  assert.equal(packet.byteLength, 19);
  assert.deepEqual(decodeMotionBatch(encodeMotionBatch([state]))?.[0], state);
  assert.equal(decodeMotionBatch(packet), null);
});

test('sequence ordering survives wraparound', () => {
  assert.equal(isNewerSequence(0, 65535), true);
  assert.equal(isNewerSequence(65535, 0), false);
});
