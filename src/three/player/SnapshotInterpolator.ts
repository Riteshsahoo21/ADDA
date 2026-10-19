import * as THREE from 'three';
import type { RoomPeer, RoomPose } from '@/lib/rooms';

export interface MotionSnapshot {
  time: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  vx: number;
  vz: number;
  pose: RoomPose;
}

export interface InterpolatedState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pose: RoomPose;
  speed: number;
  isTeleport: boolean;
}

/**
 * Snapshot Interpolator for real-time 3D multiplayer movement.
 *
 * Implements client-side entity interpolation (rendering slightly in the past)
 * using Cubic Hermite Splines and shortest-arc angular slerp.
 *
 * Eliminates all rubber-banding, jitter, and angular snapping.
 */
export class SnapshotInterpolator {
  private readonly buffer: MotionSnapshot[] = [];
  private readonly capacity = 16;
  public delayMs = 90; // Optimal 90ms buffer for 15-20 Hz mobile networking

  private lastSampledPos = new THREE.Vector3();
  private hasSampled = false;

  push(peer: RoomPeer, receivedAt: number): void {
    const x = peer.x;
    const y = peer.y ?? 0;
    const z = peer.z;
    const yaw = peer.yaw ?? 0;
    const vx = Number.isFinite(peer.vx) ? (peer.vx as number) : 0;
    const vz = Number.isFinite(peer.vz) ? (peer.vz as number) : 0;
    const pose = peer.pose ?? 'idle';

    if (this.buffer.length > 0) {
      const last = this.buffer[this.buffer.length - 1];

      // Teleport detection: if distance is > 6 meters, flush buffer for instant jump
      const dx = x - last.x;
      const dz = z - last.z;
      if (dx * dx + dz * dz > 36) {
        this.buffer.length = 0;
      } else if (receivedAt <= last.time) {
        // Enforce strictly monotonic timestamps
        receivedAt = last.time + 1;
      }
    }

    this.buffer.push({
      time: receivedAt,
      x,
      y,
      z,
      yaw,
      vx,
      vz,
      pose,
    });

    if (this.buffer.length > this.capacity) {
      this.buffer.shift();
    }
  }

  sample(now: number, delta: number): InterpolatedState {
    const len = this.buffer.length;

    if (len === 0) {
      return { x: 0, y: 0, z: 0, yaw: 0, pose: 'idle', speed: 0, isTeleport: false };
    }

    if (len === 1) {
      const s = this.buffer[0];
      return { x: s.x, y: s.y, z: s.z, yaw: s.yaw, pose: s.pose, speed: 0, isTeleport: false };
    }

    const targetTime = now - this.delayMs;
    const oldest = this.buffer[0];
    const newest = this.buffer[len - 1];

    // If targetTime is older than our buffer's oldest sample
    if (targetTime <= oldest.time) {
      return {
        x: oldest.x,
        y: oldest.y,
        z: oldest.z,
        yaw: oldest.yaw,
        pose: oldest.pose,
        speed: Math.hypot(oldest.vx, oldest.vz),
        isTeleport: false,
      };
    }

    // Extrapolation: targetTime has passed our newest received snapshot
    if (targetTime >= newest.time) {
      const overdueMs = Math.min(targetTime - newest.time, 250);
      const overdueSec = overdueMs / 1000;
      // Decay velocity over 250ms so the avatar decelerates cleanly if packets stall
      const decay = Math.max(0, 1 - overdueMs / 250);
      const extVx = newest.vx * decay;
      const extVz = newest.vz * decay;
      const x = newest.x + extVx * overdueSec;
      const z = newest.z + extVz * overdueSec;
      const speed = Math.hypot(extVx, extVz);
      const pose = speed > 0.15 ? newest.pose : (newest.pose === 'crouch_walk' ? 'crouch_idle' : 'idle');

      return {
        x,
        y: newest.y,
        z,
        yaw: newest.yaw,
        pose,
        speed,
        isTeleport: false,
      };
    }

    // Main Interpolation: find the two snapshots surrounding targetTime
    let i = len - 2;
    for (; i >= 0; i--) {
      if (this.buffer[i].time <= targetTime) {
        break;
      }
    }
    if (i < 0) i = 0;

    const s0 = this.buffer[i];
    const s1 = this.buffer[i + 1];

    const intervalMs = s1.time - s0.time;
    if (intervalMs <= 0) {
      return {
        x: s1.x,
        y: s1.y,
        z: s1.z,
        yaw: s1.yaw,
        pose: s1.pose,
        speed: Math.hypot(s1.vx, s1.vz),
        isTeleport: false,
      };
    }

    const dtSec = intervalMs / 1000;
    const alpha = THREE.MathUtils.clamp((targetTime - s0.time) / intervalMs, 0, 1);

    // Cubic Hermite Spline calculation
    const a2 = alpha * alpha;
    const a3 = a2 * alpha;
    const h00 = 2 * a3 - 3 * a2 + 1;
    const h10 = a3 - 2 * a2 + alpha;
    const h01 = -2 * a3 + 3 * a2;
    const h11 = a3 - a2;

    const m0x = s0.vx * dtSec;
    const m0z = s0.vz * dtSec;
    const m1x = s1.vx * dtSec;
    const m1z = s1.vz * dtSec;

    let x = h00 * s0.x + h10 * m0x + h01 * s1.x + h11 * m1x;
    let z = h00 * s0.z + h10 * m0z + h01 * s1.z + h11 * m1z;

    // Safety guard against extreme Hermite overshoot
    const minX = Math.min(s0.x, s1.x) - 0.5;
    const maxX = Math.max(s0.x, s1.x) + 0.5;
    const minZ = Math.min(s0.z, s1.z) - 0.5;
    const maxZ = Math.max(s0.z, s1.z) + 0.5;
    if (x < minX || x > maxX || z < minZ || z > maxZ) {
      x = THREE.MathUtils.lerp(s0.x, s1.x, alpha);
      z = THREE.MathUtils.lerp(s0.z, s1.z, alpha);
    }

    const y = THREE.MathUtils.lerp(s0.y, s1.y, alpha);

    // Shortest-arc angular slerp for yaw
    const yawDelta = THREE.MathUtils.euclideanModulo(s1.yaw - s0.yaw + Math.PI, Math.PI * 2) - Math.PI;
    const yaw = s0.yaw + yawDelta * alpha;

    // Calculate actual ground displacement speed for animation synchronization
    let speed = 0;
    if (this.hasSampled && delta > 0.001) {
      const moved = Math.hypot(x - this.lastSampledPos.x, z - this.lastSampledPos.z);
      speed = moved / delta;
    } else {
      speed = Math.hypot(
        THREE.MathUtils.lerp(s0.vx, s1.vx, alpha),
        THREE.MathUtils.lerp(s0.vz, s1.vz, alpha)
      );
    }
    this.lastSampledPos.set(x, y, z);
    this.hasSampled = true;

    // Pose selection
    const pose = alpha < 0.5 ? s0.pose : s1.pose;

    return {
      x,
      y,
      z,
      yaw,
      pose,
      speed,
      isTeleport: false,
    };
  }

  reset(): void {
    this.buffer.length = 0;
    this.hasSampled = false;
  }
}
