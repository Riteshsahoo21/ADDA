import assert from 'node:assert/strict';
import test from 'node:test';
import { sampleRemoteMotion, REMOTE_RENDER_DELAY_MS } from '../src/three/player/remoteMotion.ts';

const sample = (x, at, pose = 'walk', yaw = 0) => ({
  peer: { userId: 'peer', name: 'Peer', avatar: 'man', x, y: 0, z: 0, yaw, pose },
  receivedAt: at,
});

test('interpolates movement between packets on the render timeline', () => {
  const earlier = sample(0, 1000);
  const later = sample(1, 1100);
  const midway = sampleRemoteMotion(earlier, later, 1050 + REMOTE_RENDER_DELAY_MS);
  assert.equal(midway.x, 0.5);
  assert.equal(midway.pose, 'walk');
});

test('bridges a late packet briefly and caps prediction until the next packet', () => {
  const earlier = sample(0, 1000);
  const later = sample(1, 1100);
  assert.equal(sampleRemoteMotion(earlier, later, 1100 + REMOTE_RENDER_DELAY_MS + 50).x, 1.5);
  assert.equal(sampleRemoteMotion(earlier, later, 2000).x, 1.8);
});

test('idle avatars do not drift and large position changes snap', () => {
  assert.equal(sampleRemoteMotion(sample(0, 1000), sample(1, 1100, 'idle'), 1400).x, 1);
  assert.equal(sampleRemoteMotion(sample(0, 1000), sample(8, 1100), 1100).x, 8);
});

test('turns through the shortest angle across the wrap boundary', () => {
  const heading = sampleRemoteMotion(sample(0, 1000, 'walk', Math.PI - 0.1), sample(0, 1100, 'walk', -Math.PI + 0.1), 1050 + REMOTE_RENDER_DELAY_MS).yaw;
  assert.ok(Math.abs(Math.abs(heading) - Math.PI) < 0.0001);
});
