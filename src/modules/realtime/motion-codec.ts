import type { RoomPose } from './rooms.js';

export const MOTION_PROTOCOL = 2;
const RECORD_BYTES = 18;
const poses: RoomPose[] = ['idle', 'walk', 'run', 'jump', 'crouch_idle', 'crouch_walk', 'sit_enter', 'sit_idle', 'sit_exit', 'lounger_idle'];

export type MotionState = {
  motionId: number;
  seq: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  vx: number;
  vz: number;
  pose: RoomPose;
};

function bytesOf(input: unknown): Uint8Array | null {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return null;
}

function writeRecord(view: DataView, offset: number, state: MotionState) {
  view.setUint8(offset, poses.indexOf(state.pose));
  view.setUint8(offset + 1, 0);
  view.setUint16(offset + 2, state.seq & 0xffff, true);
  view.setInt16(offset + 4, Math.round(state.x * 100), true);
  view.setInt16(offset + 6, Math.round(state.y * 100), true);
  view.setInt16(offset + 8, Math.round(state.z * 100), true);
  view.setInt16(offset + 10, Math.round(state.yaw * 10000), true);
  view.setInt16(offset + 12, Math.round(state.vx * 100), true);
  view.setInt16(offset + 14, Math.round(state.vz * 100), true);
  view.setUint16(offset + 16, state.motionId & 0xffff, true);
}

function readRecord(view: DataView, offset: number): MotionState | null {
  const pose = poses[view.getUint8(offset)];
  if (!pose) return null;
  return {
    pose,
    seq: view.getUint16(offset + 2, true),
    x: view.getInt16(offset + 4, true) / 100,
    y: view.getInt16(offset + 6, true) / 100,
    z: view.getInt16(offset + 8, true) / 100,
    yaw: view.getInt16(offset + 10, true) / 10000,
    vx: view.getInt16(offset + 12, true) / 100,
    vz: view.getInt16(offset + 14, true) / 100,
    motionId: view.getUint16(offset + 16, true),
  };
}

export function encodeMotion(state: MotionState): Uint8Array {
  const bytes = new Uint8Array(1 + RECORD_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, MOTION_PROTOCOL);
  writeRecord(view, 1, state);
  return bytes;
}

export function decodeMotion(input: unknown): MotionState | null {
  const bytes = bytesOf(input);
  if (!bytes || bytes.byteLength !== 1 + RECORD_BYTES || bytes[0] !== MOTION_PROTOCOL) return null;
  return readRecord(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), 1);
}

export function encodeMotionBatch(states: MotionState[]): Uint8Array {
  if (states.length > 45) throw new Error('Room motion batch is too large');
  const bytes = new Uint8Array(2 + states.length * RECORD_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, MOTION_PROTOCOL);
  view.setUint8(1, states.length);
  states.forEach((state, index) => writeRecord(view, 2 + index * RECORD_BYTES, state));
  return bytes;
}

export function decodeMotionBatch(input: unknown): MotionState[] | null {
  const bytes = bytesOf(input);
  if (!bytes || bytes.byteLength < 2 || bytes[0] !== MOTION_PROTOCOL || bytes[1] > 45 || bytes.byteLength !== 2 + bytes[1] * RECORD_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const states: MotionState[] = [];
  for (let index = 0; index < bytes[1]; index++) {
    const state = readRecord(view, 2 + index * RECORD_BYTES);
    if (!state) return null;
    states.push(state);
  }
  return states;
}

export function isNewerSequence(next: number, last: number) {
  const difference = (next - last + 65536) & 0xffff;
  return difference > 0 && difference < 32768;
}
