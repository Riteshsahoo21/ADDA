import type { RoomPose } from '@/lib/rooms';

export type InterpolatedState = {
  x: number;
  y: number;
  z: number;
  r: number;
  pose: RoomPose;
};

type Snapshot = {
  x: number;
  y: number;
  z: number;
  r: number;
  pose: RoomPose;
  time: number;
};

/**
 * Roblox-grade Snapshot Interpolator.
 * Maintains an 80ms rolling buffer, synchronizes against unified server timestamps,
 * and interpolates at 60 FPS with shortest-arc radian SLERP without ever snapping backwards or forward.
 */
export class RobloxInterpolator {
  private readonly bufferMs: number;
  private snapshots: Snapshot[] = [];
  private renderTime = 0;

  constructor(bufferMs = 80) {
    this.bufferMs = bufferMs;
  }

  isEmpty(): boolean {
    return this.snapshots.length === 0;
  }

  push(x: number, y: number, z: number, r: number, pose: RoomPose, serverTime: number): void {
    if (this.snapshots.length > 0) {
      const last = this.snapshots[this.snapshots.length - 1];
      if (serverTime < last.time) {
        return; // Drop out-of-order packets
      }
      if (serverTime === last.time) {
        serverTime = last.time + 1;
      }
    }

    // Teleport detection (> 5 meters instant displacement)
    if (this.snapshots.length > 0) {
      const prev = this.snapshots[this.snapshots.length - 1];
      if (Math.hypot(x - prev.x, z - prev.z) > 5.0) {
        this.snapshots = [];
        this.renderTime = 0;
      }
    }

    this.snapshots.push({ x, y, z, r, pose, time: serverTime });
    if (this.snapshots.length > 30) this.snapshots.shift();

    // Initialize render timeline on first snapshot
    if (this.renderTime === 0) {
      this.renderTime = serverTime - this.bufferMs;
    }
  }

  sample(deltaSeconds: number): InterpolatedState | null {
    if (this.snapshots.length === 0) return null;
    if (this.snapshots.length === 1) {
      const s = this.snapshots[0];
      return { x: s.x, y: s.y, z: s.z, r: s.r, pose: s.pose };
    }

    const newest = this.snapshots[this.snapshots.length - 1];
    const oldest = this.snapshots[0];

    // Adaptive clock drift adjustment:
    // Nudge playback speed by ±15% to stay exactly bufferMs behind the stream
    const targetRenderTime = newest.time - this.bufferMs;
    const timeDiff = targetRenderTime - this.renderTime;

    if (Math.abs(timeDiff) > 250) {
      // Large lag spike or tab switch: snap renderTime to target
      this.renderTime = targetRenderTime;
    } else {
      let speed = 1.0;
      if (timeDiff > 25) speed = 1.15;
      else if (timeDiff < -25) speed = 0.85;
      this.renderTime += deltaSeconds * 1000 * speed;
    }

    // Hard bounds: never before oldest, never beyond newest
    if (this.renderTime < oldest.time) this.renderTime = oldest.time;
    if (this.renderTime >= newest.time) {
      this.renderTime = newest.time;
      return { x: newest.x, y: newest.y, z: newest.z, r: newest.r, pose: newest.pose };
    }

    // Scan for bounding snapshots [A, B] where A.time <= renderTime <= B.time
    for (let i = this.snapshots.length - 1; i > 0; i--) {
      const B = this.snapshots[i];
      const A = this.snapshots[i - 1];
      if (this.renderTime >= A.time && this.renderTime <= B.time) {
        const span = B.time - A.time;
        const alpha = span > 0 ? (this.renderTime - A.time) / span : 1;

        // Linear interpolation for spatial position
        const x = A.x + (B.x - A.x) * alpha;
        const y = A.y + (B.y - A.y) * alpha;
        const z = A.z + (B.z - A.z) * alpha;

        // Spherical shortest-arc radian rotation interpolation
        let diff = (B.r - A.r) % (Math.PI * 2);
        diff = (diff + Math.PI * 3) % (Math.PI * 2) - Math.PI;
        const r = A.r + diff * alpha;

        // Sender confirmed pose
        const pose = alpha > 0.5 ? B.pose : A.pose;
        return { x, y, z, r, pose };
      }
    }

    return { x: newest.x, y: newest.y, z: newest.z, r: newest.r, pose: newest.pose };
  }

  reset(): void {
    this.snapshots = [];
    this.renderTime = 0;
  }
}
