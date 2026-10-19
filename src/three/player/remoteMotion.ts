import type { RoomPeer, RoomPeerMotion } from '@/lib/rooms';

// Allow for the 350 ms send anchor, 100 ms relay tick, and mobile network jitter.
const MAX_PREDICTION_MS = 900;

export function predictRemoteMotion(latest: RoomPeerMotion, now: number): RoomPeer {
  const peer = latest.peer;
  const moving = peer.pose === 'walk' || peer.pose === 'run' || peer.pose === 'crouch_walk';
  if (!moving || !Number.isFinite(peer.vx) || !Number.isFinite(peer.vz)) return peer;
  const elapsed = Math.min(Math.max(now - latest.receivedAt, 0), MAX_PREDICTION_MS) / 1000;
  return { ...peer, x: peer.x + peer.vx! * elapsed, z: peer.z + peer.vz! * elapsed };
}
