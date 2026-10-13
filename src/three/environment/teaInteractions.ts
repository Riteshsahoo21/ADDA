import * as THREE from 'three';

export type TeaSeat = {
  target: THREE.Vector3;
  approach: THREE.Vector3;
  heading: number;
  axis: THREE.Vector2;
  normal: THREE.Vector2;
  tapTarget: THREE.Object3D;
};

export type TeaObstacle = { minX: number; maxX: number; minZ: number; maxZ: number };

// Coordinates are in the source chai-stall.glb. Its two bench seats form
// rows in front of the counter.
// Bench 0 is the inner bench closer to the counter; Bench 1 is the outer bench closer to the road.
const benchLocations = [
  { center: [0.035, 0.104], end: [0.25, 0.104], approach: [0.035, 0.38] },
  { center: [0.021, 0.788], end: [0.25, 0.788], approach: [0.021, 0.52] },
] as const;

export function createTeaSeats(model: THREE.Group): TeaSeat[] {
  model.updateWorldMatrix(true, true);
  const material = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });

  // Center of the chai counter in chai-stall local space:
  // Countertop is at x ~ -0.062, y ~ 0.5, z ~ -0.468 in local coordinates.
  const counterLocal = new THREE.Vector3(-0.062, 0, -0.468);
  const counterWorld = model.localToWorld(counterLocal.clone());
  counterWorld.y = 0;

  return benchLocations.map((bench, index) => {
    const toWorld = (x: number, z: number) => model.localToWorld(new THREE.Vector3(x, 0, z));
    const target = toWorld(bench.center[0], bench.center[1]);
    const approach = toWorld(bench.approach[0], bench.approach[1]);
    const end = toWorld(bench.end[0], bench.end[1]);
    target.y = 0;
    approach.y = 0;
    end.y = 0;
    const axis = new THREE.Vector2(end.x - target.x, end.z - target.z).normalize();
    const normal = new THREE.Vector2(approach.x - target.x, approach.z - target.z).normalize();

    // Bench 0 (left bench in front of the counter) sits facing the road (+X).
    // Bench 1 (right bench diagonal to the stall) sits facing the chai stall counter (-X).
    let heading: number;
    if (index === 0) {
      heading = Math.atan2(-normal.x, -normal.y);
    } else {
      const toCounter = new THREE.Vector3().subVectors(counterWorld, target);
      toCounter.y = 0;
      toCounter.normalize();
      heading = Math.atan2(-toCounter.x, -toCounter.z);
    }

    const localDx = bench.end[0] - bench.center[0];
    const localDz = bench.end[1] - bench.center[1];
    const tapTarget = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.25, 1.25), material);
    tapTarget.position.set(bench.center[0], 0.19, bench.center[1]);
    tapTarget.rotation.y = Math.atan2(localDx, localDz);
    tapTarget.name = `Chai bench ${index + 1} touch target`;
    model.add(tapTarget);
    return { target, approach, heading, axis, normal, tapTarget };
  });
}

export function teaObstacleFromBounds(bounds: THREE.Box3, padding = 0.3): TeaObstacle {
  return { minX: bounds.min.x - padding, maxX: bounds.max.x + padding,
    minZ: bounds.min.z - padding, maxZ: bounds.max.z + padding };
}

export function teaStallObstacle(model: THREE.Group): TeaObstacle {
  // Keep the walkable benches in front of the counter outside this obstacle.
  const mainStall = new THREE.Box3(
    new THREE.Vector3(-0.6, 0, -0.95),
    new THREE.Vector3(0.85, 0.92, -0.08),
  ).applyMatrix4(model.matrixWorld);
  return teaObstacleFromBounds(mainStall);
}

export function canWalkTea(x: number, z: number, obstacles: TeaObstacle[], seats: TeaSeat[]) {
  if (obstacles.some(box => x >= box.minX && x <= box.maxX && z >= box.minZ && z <= box.maxZ)) return false;
  // Bench seats block walking through the wood. The sit animation crosses this
  // narrow area from a clear approach point after the user chooses a bench.
  for (const seat of seats) {
    const dx = x - seat.target.x;
    const dz = z - seat.target.z;
    const along = dx * seat.axis.x + dz * seat.axis.y;
    const across = dx * seat.normal.x + dz * seat.normal.y;
    if (Math.abs(along) < 1.08 && Math.abs(across) < 0.35) return false;
  }
  return true;
}
