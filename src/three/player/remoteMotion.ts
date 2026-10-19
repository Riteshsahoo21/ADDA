import type { RoomPeer, RoomPeerMotion } from '@/lib/rooms';

export const REMOTE_RENDER_DELAY_MS = 130;
const MAX_EXTRAPOLATION_MS = 80;
const TELEPORT_DISTANCE = 5;

function shortestAngle(from: number, to: number) {
  return ((to - from + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
}

export function sampleRemoteMotion(previous: RoomPeerMotion | undefined, latest: RoomPeerMotion, now: number) {
  const current = latest.peer;
  if (!previous || latest.receivedAt <= previous.receivedAt) return current;

  const prior = previous.peer;
  const elapsed = latest.receivedAt - previous.receivedAt;
  const distance = Math.hypot(current.x - prior.x, current.z - prior.z);
  if (distance > TELEPORT_DISTANCE) return current;

  const renderAt = now - REMOTE_RENDER_DELAY_MS;
  const t = (renderAt - previous.receivedAt) / elapsed;
  const moving = current.pose === 'walk' || current.pose === 'run' || current.pose === 'crouch_walk';
  // A short prediction bridges a late packet. Stop predicting when input is idle or stale.
  const maxT = moving && elapsed <= 300
    ? 1 + MAX_EXTRAPOLATION_MS / elapsed
    : 1;
  const amount = Math.max(0, Math.min(t, maxT));
  const yaw = prior.yaw + shortestAngle(prior.yaw, current.yaw) * amount;
  return {
    ...current,
    x: prior.x + (current.x - prior.x) * amount,
    y: (prior.y ?? 0) + ((current.y ?? 0) - (prior.y ?? 0)) * amount,
    z: prior.z + (current.z - prior.z) * amount,
    yaw,
    pose: amount < 1 ? prior.pose ?? current.pose : current.pose,
  } satisfies RoomPeer;
}
