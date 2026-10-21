import * as THREE from 'three';
import { getBeachSandElevation } from './beachEnvironment';

export interface BeachSeat {
  id: string;
  name: string;
  seatType?: 'bench' | 'lounger';
  target: THREE.Vector3;
  approach: THREE.Vector3;
  heading: number;
  axis: THREE.Vector2;
  normal: THREE.Vector2;
  tapTarget: THREE.Object3D;
  seatElevation: number;
  slotOffsets: readonly number[];
}

export interface WoodenBenchConfig {
  id: string;
  name: string;
  x: number;
  z: number;
  customY?: number;
  rotationY?: number;
}

export const WOODEN_BENCH_SLOTS = [-0.45, 0, 0.45] as const;
export const LOUNGER_SLOTS = [-0.73, 0.73] as const;

/**
 * Calculates the exact sitting spot on a beach bench or sun lounger.
 * Takes into account which side of the bench was tapped (hitPoint)
 * and whether another avatar is already occupying that slot.
 */
export function getBeachSeatSpot(
  seat: BeachSeat,
  hitPoint?: THREE.Vector3,
  occupiedPositions?: THREE.Vector3[]
): { target: THREE.Vector3; approach: THREE.Vector3 } {
  const slots = seat.slotOffsets.length > 0 ? seat.slotOffsets : [0];
  let desiredOffset = 0;

  if (hitPoint && slots.length > 1) {
    const dx = hitPoint.x - seat.target.x;
    const dz = hitPoint.z - seat.target.z;
    const proj = dx * seat.axis.x + dz * seat.axis.y;

    let closest = slots[0];
    let minDist = Math.abs(proj - slots[0]);
    for (let i = 1; i < slots.length; i++) {
      const d = Math.abs(proj - slots[i]);
      if (d < minDist) {
        minDist = d;
        closest = slots[i];
      }
    }
    desiredOffset = closest;
  }

  // Filter for unoccupied slots
  const freeSlots: number[] = [];
  for (const offset of slots) {
    const slotX = seat.target.x + seat.axis.x * offset;
    const slotZ = seat.target.z + seat.axis.y * offset;
    const isOccupied = occupiedPositions?.some(pos => Math.hypot(pos.x - slotX, pos.z - slotZ) < 0.42);
    if (!isOccupied) {
      freeSlots.push(offset);
    }
  }

  let finalOffset = desiredOffset;
  if (freeSlots.length > 0) {
    if (!freeSlots.includes(desiredOffset)) {
      freeSlots.sort((a, b) => Math.abs(a - desiredOffset) - Math.abs(b - desiredOffset));
      finalOffset = freeSlots[0];
    }
  } else {
    finalOffset = desiredOffset;
  }

  const offsetVec = new THREE.Vector3(seat.axis.x * finalOffset, 0, seat.axis.y * finalOffset);
  return {
    target: seat.target.clone().add(offsetVec),
    approach: seat.approach.clone().add(offsetVec),
  };
}

/**
 * Creates an authentic rustic seaside wooden bench with teak wood planks
 * and cast-iron frame legs, complete with touch target and seat definition.
 */
export function createWoodenBeachBench(
  scene: THREE.Scene,
  config: WoodenBenchConfig,
  materials?: { wood: THREE.Material; iron: THREE.Material; touch: THREE.Material }
): { group: THREE.Group; seat: BeachSeat; dispose: () => void } {
  const group = new THREE.Group();
  group.name = `BeachBench_${config.id}`;

  const rotY = config.rotationY ?? 0;
  const elev = config.customY ?? getBeachSandElevation(config.z);
  group.position.set(config.x, elev, config.z);
  group.rotation.y = rotY;

  const woodMat = materials?.wood ?? new THREE.MeshStandardMaterial({
    color: new THREE.Color('#8b542c'),
    roughness: 0.68,
    metalness: 0.05,
  });

  const ironMat = materials?.iron ?? new THREE.MeshStandardMaterial({
    color: new THREE.Color('#232528'),
    roughness: 0.42,
    metalness: 0.82,
  });

  const touchMat = materials?.touch ?? new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  // Seat planks (4 slatted wooden planks across 1.48m width)
  const seatPlankGeo = new THREE.BoxGeometry(1.48, 0.035, 0.095);
  for (let i = 0; i < 4; i++) {
    const plank = new THREE.Mesh(seatPlankGeo, woodMat);
    plank.position.set(0, 0.43, -0.15 + i * 0.105);
    plank.castShadow = true;
    group.add(plank);
  }

  // Backrest planks (2 slatted wooden planks)
  const backPlankGeo = new THREE.BoxGeometry(1.48, 0.095, 0.03);
  for (let i = 0; i < 2; i++) {
    const plank = new THREE.Mesh(backPlankGeo, woodMat);
    plank.position.set(0, 0.63 + i * 0.13, -0.22);
    plank.rotation.x = -0.12;
    plank.castShadow = true;
    group.add(plank);
  }

  // Cast iron side frames
  const legGeo = new THREE.BoxGeometry(0.045, 0.43, 0.46);
  const backSupportGeo = new THREE.BoxGeometry(0.045, 0.44, 0.045);
  for (const x of [-0.64, 0.64]) {
    const leg = new THREE.Mesh(legGeo, ironMat);
    leg.position.set(x, 0.215, 0.01);
    group.add(leg);

    const backSupport = new THREE.Mesh(backSupportGeo, ironMat);
    backSupport.position.set(x, 0.59, -0.21);
    backSupport.rotation.x = -0.12;
    group.add(backSupport);
  }

  // Armrests
  const armrestGeo = new THREE.BoxGeometry(0.045, 0.03, 0.42);
  for (const x of [-0.64, 0.64]) {
    const arm = new THREE.Mesh(armrestGeo, woodMat);
    arm.position.set(x, 0.58, 0.02);
    group.add(arm);
  }

  // Invisible touch target wrapping bench
  const tapTarget = new THREE.Mesh(new THREE.BoxGeometry(1.65, 0.85, 0.75), touchMat);
  tapTarget.position.set(0, 0.42, 0);
  tapTarget.name = `Touch_${config.name}`;
  group.add(tapTarget);

  scene.add(group);
  group.updateMatrixWorld(true);

  // Vectors in world space
  const target = new THREE.Vector3(config.x, elev, config.z);
  // Normal points in front (+Z in local bench space)
  const normal = new THREE.Vector2(Math.sin(rotY), Math.cos(rotY)).normalize();
  // Axis along bench length (+X in local bench space)
  const axis = new THREE.Vector2(Math.cos(rotY), -Math.sin(rotY)).normalize();
  // Approach is in front of the bench
  const approach = target.clone().add(new THREE.Vector3(normal.x * 0.75, 0, normal.y * 0.75));

  // Heading facing front (+normal direction in world space)
  const heading = Math.atan2(-normal.x, -normal.y);

  const seat: BeachSeat = {
    id: config.id,
    name: config.name,
    seatType: 'bench',
    target,
    approach,
    heading,
    axis,
    normal,
    tapTarget,
    seatElevation: 0.02,
    slotOffsets: WOODEN_BENCH_SLOTS,
  };

  return {
    group,
    seat,
    dispose: () => {
      scene.remove(group);
      seatPlankGeo.dispose();
      backPlankGeo.dispose();
      legGeo.dispose();
      backSupportGeo.dispose();
      armrestGeo.dispose();
      tapTarget.geometry.dispose();
      if (!materials) {
        woodMat.dispose();
        ironMat.dispose();
        touchMat.dispose();
      }
    },
  };
}

/**
 * Creates the BeachSeat and touch target for a twin Beach Sun Lounger pair.
 */
export function createLoungerBeachSeat(
  holder: THREE.Group,
  x: number,
  z: number,
  rotationY: number,
  id: string,
  name: string
): BeachSeat {
  holder.updateMatrixWorld(true);

  const touchMat = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  // Invisible tap target wrapping both loungers
  const tapTarget = new THREE.Mesh(new THREE.BoxGeometry(2.35, 0.9, 2.05), touchMat);
  tapTarget.position.set(0, 0.45, 0);
  tapTarget.name = `Touch_${name}`;
  holder.add(tapTarget);
  tapTarget.updateMatrixWorld(true);

  const elev = getBeachSandElevation(z);
  // Position target at the hips crease where backrest meets the bed cushion
  const target = new THREE.Vector3(x, elev, z).add(
    new THREE.Vector3(-Math.sin(rotationY) * 0.22, 0, -Math.cos(rotationY) * 0.22)
  );

  // Normal points towards footrest / approach direction (-Z in world when rotationY = Math.PI)
  // In local space, head is at -Z, footrest is at +Z.
  // With rotationY, normal in world space is (sin(rotationY), cos(rotationY)).
  const normal = new THREE.Vector2(Math.sin(rotationY), Math.cos(rotationY)).normalize();
  // Axis across twin loungers (+X in local space)
  const axis = new THREE.Vector2(Math.cos(rotationY), -Math.sin(rotationY)).normalize();

  // Approach is in front of the lounger footrests
  const approach = target.clone().add(new THREE.Vector3(normal.x * 1.5, 0, normal.y * 1.5));

  // Avatar sits facing normal (away from umbrella, towards ocean)
  const heading = Math.atan2(-normal.x, -normal.y);

  return {
    id,
    name,
    seatType: 'lounger',
    target,
    approach,
    heading,
    axis,
    normal,
    tapTarget,
    seatElevation: 0.43,
    slotOffsets: LOUNGER_SLOTS,
  };
}
