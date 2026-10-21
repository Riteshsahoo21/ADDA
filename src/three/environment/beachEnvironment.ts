/* eslint-disable @typescript-eslint/no-require-imports */
import * as THREE from 'three';
import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import { BEACH_ASSETS } from './beachAssets';
import { BeachSeat, createWoodenBeachBench, WoodenBenchConfig } from './beachInteractions';

async function readBundledAssetBytes(moduleId: number): Promise<Uint8Array> {
  const asset = await Asset.fromModule(moduleId).downloadAsync();
  if (!asset.localUri) throw new Error('Failed to resolve bundled asset uri');
  return new File(asset.localUri).bytes();
}

export interface BeachObstacle {
  x: number;
  z: number;
  radius: number;
}

/**
 * Natural Goa Beach elevation curve:
 * Z = -60m (deep ocean bed) -> -1.80m
 * Z = -14m (shallow water / pier end) -> -0.48m
 * Z = 0m (waterline shoreline) -> +0.17m
 * Z = +8m (open beach lounge area & spawn) -> +0.54m
 * Z = +22m (beach shack terrace) -> +1.26m
 * Z = +33m (food stall lane) -> +1.86m
 * Z = +44m (palm ridge & coastal road) -> +2.46m
 */
export function getBeachSandElevation(z: number): number {
  const sandDepth = 120;
  const t = Math.max(0, Math.min(1, (z + sandDepth / 2) / sandDepth));
  return Math.pow(t, 1.4) * 5.2 - 1.8;
}

/**
 * Checks if the player can walk at (x, z) on the beach.
 * Allows expansive exploration across the 140m coast, strolling out onto the wooden pier,
 * wading into shallow water, and moving freely between stalls.
 */
export function canWalkBeach(x: number, z: number, obstacles: BeachObstacle[]): boolean {
  // Coastal lateral limits (-34m to +34m)
  if (x < -34 || x > 34) return false;

  // Back boundary into dense palm ridge
  if (z > 43) return false;

  // Pier deck zone (-1.75 <= x <= 1.75 and -17.3 <= z <= 2.85): always walkable out onto the ocean dock!
  const onPier = Math.abs(x) <= 1.75 && z <= 2.85 && z >= -17.3;
  if (onPier) return true;

  // Ocean limit off the dock: player can wade into shallow water up to z = -3.0
  if (z < -3.0) return false;

  // Circular obstacle checks with clearance
  for (const obs of obstacles) {
    if (obs.radius <= 0) continue;
    const dx = x - obs.x;
    const dz = z - obs.z;
    if (dx * dx + dz * dz < obs.radius * obs.radius) {
      return false;
    }
  }

  return true;
}

/**
 * Builds the obstacle list from the asset placement manifest.
 */
export function buildBeachObstacles(): BeachObstacle[] {
  const obstacles: BeachObstacle[] = [];
  for (const asset of BEACH_ASSETS) {
    if (asset.collisionRadius > 0) {
      obstacles.push({ x: asset.x, z: asset.z, radius: asset.collisionRadius });
    }
    if (asset.clones) {
      for (const clone of asset.clones) {
        const radius = clone.collisionRadius ?? asset.collisionRadius;
        if (radius > 0) {
          obstacles.push({ x: clone.x, z: clone.z, radius });
        }
      }
    }
  }
  return obstacles;
}

export interface BeachEnvironment {
  sandMesh: THREE.Mesh;
  obstacles: BeachObstacle[];
  beachSeats: BeachSeat[];
  update: (delta: number) => void;
  dispose: () => void;
}

/**
 * Creates the high-resolution Ground054 beach terrain.
 */
export function createBeachEnvironment(scene: THREE.Scene): BeachEnvironment {
  // Expansive 260m wide x 140m deep terrain so the world never drops off into void
  const sandWidth = 260;
  const sandDepth = 140;
  const segmentsX = 52;
  const segmentsZ = 36;

  // 1. Construct terrain in XZ world plane with +Y pointing UP
  const sandGeometry = new THREE.PlaneGeometry(sandWidth, sandDepth, segmentsX, segmentsZ);
  sandGeometry.rotateX(-Math.PI / 2);

  const posAttr = sandGeometry.attributes.position;
  const uvAttr = sandGeometry.attributes.uv;
  const count = posAttr.count;

  // Pre-bake warm golden sand tones directly into vertex colors
  const colorData = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    const x = posAttr.getX(i);
    const localZ = posAttr.getZ(i);
    const z = localZ + 30; // Center the 140m depth terrain at z=30 (spans z=-40 to +100)
    posAttr.setZ(i, z);
    const y = getBeachSandElevation(z);
    posAttr.setY(i, y);

    // Tile UVs for Ground054 texture: 44 repeats horizontally, 24 repeats in depth
    const u = (x / sandWidth + 0.5) * 44;
    const v = (localZ / sandDepth + 0.5) * 24;
    uvAttr.setXY(i, u, v);

    // Smooth warm sunlit gradient from wet shoreline to golden dunes
    const t = Math.max(0, Math.min(1, (z + 40) / 140));
    const r = 0.88 + t * 0.08;
    const g = 0.68 + t * 0.12;
    const b = 0.46 + t * 0.15;
    colorData[i * 3] = Math.min(1, r);
    colorData[i * 3 + 1] = Math.min(1, g);
    colorData[i * 3 + 2] = Math.min(1, b);
  }

  sandGeometry.setAttribute('color', new THREE.BufferAttribute(colorData, 3));
  sandGeometry.computeVertexNormals();

  const sandMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.85,
    metalness: 0.02,
    side: THREE.FrontSide,
  });

  const sandMesh = new THREE.Mesh(sandGeometry, sandMaterial);
  sandMesh.position.set(0, 0, 0);
  sandMesh.frustumCulled = true;
  scene.add(sandMesh);

  // 2. Static Highly-Realistic Ocean Water Plane
  // Spans across the entire coastal horizon from shoreline (Z = -2.0) outward to Z = -162
  const oceanWidth = 280;
  const oceanDepth = 160;
  const waterGeometry = new THREE.PlaneGeometry(oceanWidth, oceanDepth);
  waterGeometry.rotateX(-Math.PI / 2);

  const waterMaterial = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#0b6382'), // Rich tropical coastal ocean turquoise
    roughness: 0.11, // Glassy specular reflection of sunset sun
    metalness: 0.12,
    transparent: true,
    opacity: 0.88,
    side: THREE.FrontSide,
  });

  const waterMesh = new THREE.Mesh(waterGeometry, waterMaterial);
  // Center at Z = -82, Y = 0.04 (water meets sand at Z = -2.0, completely covers ocean horizon!)
  waterMesh.position.set(0, 0.04, -82);
  waterMesh.frustumCulled = true;
  scene.add(waterMesh);

  // 3. Load Ground054 PBR color & normal map + dedicated water normal map asynchronously
  let loadedColorTex: THREE.DataTexture | null = null;
  let loadedNormalTex: THREE.DataTexture | null = null;
  let waterNormalTex: THREE.DataTexture | null = null;

  void (async () => {
    try {
      const [colorAsset, normalAsset, waterNormalAsset] = await Promise.all([
        readBundledAssetBytes(require('../../../assets/textures/beach-sand.rgba')),
        readBundledAssetBytes(require('../../../assets/textures/beach-sand-normal.rgba')),
        readBundledAssetBytes(require('../../../assets/textures/beach-water-normal.rgba')),
      ]);

      if (colorAsset.byteLength) {
        const colorBytes = colorAsset;
        loadedColorTex = new THREE.DataTexture(new Uint8Array(colorBytes), 1024, 1024, THREE.RGBAFormat);
        loadedColorTex.wrapS = THREE.RepeatWrapping;
        loadedColorTex.wrapT = THREE.RepeatWrapping;
        loadedColorTex.repeat.set(44, 24);
        loadedColorTex.anisotropy = 4;
        loadedColorTex.minFilter = THREE.LinearFilter;
        loadedColorTex.magFilter = THREE.LinearFilter;
        loadedColorTex.generateMipmaps = false;
        loadedColorTex.needsUpdate = true;
        sandMaterial.map = loadedColorTex;
      }

      if (normalAsset.byteLength) {
        const normalBytes = normalAsset;
        loadedNormalTex = new THREE.DataTexture(new Uint8Array(normalBytes), 1024, 1024, THREE.RGBAFormat);
        loadedNormalTex.wrapS = THREE.RepeatWrapping;
        loadedNormalTex.wrapT = THREE.RepeatWrapping;
        loadedNormalTex.repeat.set(44, 24);
        loadedNormalTex.anisotropy = 4;
        loadedNormalTex.minFilter = THREE.LinearFilter;
        loadedNormalTex.magFilter = THREE.LinearFilter;
        loadedNormalTex.generateMipmaps = false;
        loadedNormalTex.needsUpdate = true;
        sandMaterial.normalMap = loadedNormalTex;
        sandMaterial.normalScale.set(1.0, 1.0);
      }

      if (waterNormalAsset.byteLength) {
        const waterBytes = waterNormalAsset;
        waterNormalTex = new THREE.DataTexture(new Uint8Array(waterBytes), 512, 512, THREE.RGBAFormat);
        waterNormalTex.wrapS = THREE.RepeatWrapping;
        waterNormalTex.wrapT = THREE.RepeatWrapping;
        waterNormalTex.repeat.set(36, 24);
        waterNormalTex.anisotropy = 4;
        waterNormalTex.minFilter = THREE.LinearFilter;
        waterNormalTex.magFilter = THREE.LinearFilter;
        waterNormalTex.generateMipmaps = false;
        waterNormalTex.needsUpdate = true;
        waterMaterial.normalMap = waterNormalTex;
        waterMaterial.normalScale.set(0.65, 0.65);
        waterMaterial.needsUpdate = true;
      }

      sandMaterial.needsUpdate = true;
    } catch (e) {
      console.warn('[ADDA Beach] Failed to load sand or water texture', e);
    }
  })();

  const obstacles = buildBeachObstacles();

  // 4. Seaside Promenade Wooden Benches
  const WOODEN_BENCH_CONFIGS: WoodenBenchConfig[] = [
    {
      id: 'pier-bench-left',
      name: 'Pier Shoreline Bench (Left)',
      x: -3.2,
      z: 1.5,
      rotationY: 0,
    },
    {
      id: 'pier-bench-right',
      name: 'Pier Shoreline Bench (Right)',
      x: 3.2,
      z: 1.5,
      rotationY: 0,
    },
    {
      id: 'pier-lookout-bench',
      name: 'Pier Lookout Bench',
      x: 0.85,
      z: -14.2,
      customY: 0.42,
      rotationY: -Math.PI / 2,
    },
    {
      id: 'campfire-bench',
      name: 'Campfire Beach Bench',
      x: -16.0,
      z: 14.5,
      rotationY: 0.15,
    },
  ];

  const benchDisposers: (() => void)[] = [];
  const beachSeats: BeachSeat[] = [];

  // Shared bench materials for fast mobile batch rendering
  const benchMaterials = {
    wood: new THREE.MeshStandardMaterial({
      color: new THREE.Color('#8b542c'),
      roughness: 0.68,
      metalness: 0.05,
    }),
    iron: new THREE.MeshStandardMaterial({
      color: new THREE.Color('#232528'),
      roughness: 0.42,
      metalness: 0.82,
    }),
    touch: new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  };

  for (const cfg of WOODEN_BENCH_CONFIGS) {
    const created = createWoodenBeachBench(scene, cfg, benchMaterials);
    benchDisposers.push(created.dispose);
    beachSeats.push(created.seat);
    if (!cfg.customY) {
      obstacles.push({ x: cfg.x, z: cfg.z, radius: 0.65 });
    }
  }

  return {
    sandMesh,
    obstacles,
    beachSeats,
    update: (_delta: number) => {},
    dispose: () => {
      sandGeometry.dispose();
      sandMaterial.dispose();
      waterGeometry.dispose();
      waterMaterial.dispose();
      loadedColorTex?.dispose();
      loadedNormalTex?.dispose();
      waterNormalTex?.dispose();
      benchDisposers.forEach(d => d());
      benchMaterials.wood.dispose();
      benchMaterials.iron.dispose();
      benchMaterials.touch.dispose();
    },
  };
}
