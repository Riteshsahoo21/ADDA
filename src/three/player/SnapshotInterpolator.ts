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
 * Implements historical client-side entity interpolation (rendering 90ms in the past)
 * with TCP packet-bunching anti-jitter protection, linear trajectory interpolation,
 * and shortest-arc angular slerp.
 */
export class SnapshotInterpolator {
  private readonly buffer: MotionSnapshot[] = [];
  private readonly capacity = 16;
  public delayMs = 90; // Optimal 90ms buffer for 15-20 Hz mobile networking

  push(peer: RoomPeer, receivedAt: number): void {
    const x = peer.x;
    const y = peer.y ?? 0;
    const z = peer.z;
    // Guarantee yaw is strictly in [-PI, PI]
    const yaw = Math.atan2(Math.sin(peer.yaw ?? 0), Math.cos(peer.yaw ?? 0));
    const vx = Number.isFinite(peer.vx) ? (peer.vx as number) : 0;
    const vz = Number.isFinite(peer.vz) ? (peer.vz as number) : 0;
    const pose = peer.pose ?? 'idle';

    if (this.buffer.length > 0) {
      const last = this.buffer[this.buffer.length - 1];

      // Teleport detection: if distance is > 5 meters, flush buffer for instant jump
      const dx = x - last.x;
      const dz = z - last.z;
      if (dx * dx + dz * dz > 25) {
        this.buffer.length = 0;
      } else if (receivedAt <= last.time + 30) {
        // TCP / radio bunching: two packets arrived together in < 30ms.
        // Space them by at least 50ms to reflect true physical sender duration
        receivedAt = last.time + 50;
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

  sample(now: number, _delta: number): InterpolatedState {
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

    const alpha = THREE.MathUtils.clamp((targetTime - s0.time) / intervalMs, 0, 1);

    // Linear Interpolation: perfectly straight-line path with zero overshoot or bowing
    const x = THREE.MathUtils.lerp(s0.x, s1.x, alpha);
    const y = THREE.MathUtils.lerp(s0.y, s1.y, alpha);
    const z = THREE.MathUtils.lerp(s0.z, s1.z, alpha);

    // Shortest-arc angular slerp for yaw
    const yawDelta = THREE.MathUtils.euclideanModulo(s1.yaw - s0.yaw + Math.PI, Math.PI * 2) - Math.PI;
    const yaw = s0.yaw + yawDelta * alpha;

    // Smooth speed interpolation
    const speed = THREE.MathUtils.lerp(
      Math.hypot(s0.vx, s0.vz),
      Math.hypot(s1.vx, s1.vz),
      alpha
    );

    // Pose selection: trust sender's confirmed pose
    const pose = alpha > 0.5 ? s1.pose : s0.pose;

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
  }
}
