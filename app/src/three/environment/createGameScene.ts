import * as THREE from 'three';
import { createTeaBoundary } from './teaBoundary';

export type RoomKind = 'loft' | 'tea' | 'roof' | 'beach';

export type GameScene = {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  player: THREE.Group;
  avatarMount: THREE.Group;
  wallMeshes: THREE.Object3D[];
  boundary: number;
  dispose: () => void;
};

/** Shared camera/player frame. Imported GLBs supply the rooms themselves. */
export function createGameScene(aspect: number, kind: RoomKind): GameScene {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(72, aspect, 0.05, kind === 'beach' ? 70 : kind === 'roof' ? 85 : kind === 'tea' ? 80 : 40);
  const player = new THREE.Group();
  const avatarMount = new THREE.Group();
  player.add(avatarMount);
  scene.add(player);
  const wallMeshes: THREE.Object3D[] = [];
  const boundary = kind === 'beach' ? 32 : kind === 'roof' ? 12 : kind === 'tea' ? 13 : 5.3;
  if (kind === 'beach') {
    // Warm Goa Sunset atmosphere (matching Map 1 & 2 single-sun architecture)
    scene.background = new THREE.Color('#e07a5f');
    scene.fog = new THREE.Fog('#e07a5f', 28, 70);
    scene.add(new THREE.HemisphereLight('#ffe0cc', '#785040', 2.4));
    const sunsetSun = new THREE.DirectionalLight('#ff934f', 2.8);
    sunsetSun.position.set(-25, 24, -35);
    scene.add(sunsetSun);
    // Player spawns on the soft warm sand overlooking the sunset water
    player.position.set(0, 0.54, 8);
  } else if (kind === 'roof') {
    scene.background = new THREE.Color('#947d9d');
    scene.fog = new THREE.Fog('#947d9d', 38, 78);
    scene.add(new THREE.HemisphereLight('#d3d7ff', '#725c6b', 2.0));
    const sunset = new THREE.DirectionalLight('#ffbd86', 2.4);
    sunset.position.set(-25, 36, -10);
    scene.add(sunset);
    // GameRoom positions the player in front of the GLB's steel door after load.
    player.position.set(0, 0, 0);
  } else if (kind === 'tea') {
    scene.background = new THREE.Color('#bd7982');
    scene.fog = new THREE.Fog('#bd7982', 26, 68);
    scene.add(new THREE.HemisphereLight('#e9d7c1', '#7f805a', 2.1));
    const sun = new THREE.DirectionalLight('#ffbb7f', 2.5);
    sun.position.set(-10, 9, -12);
    scene.add(sun);
    createTeaBoundary(scene, boundary);
    player.position.set(0, 0, 7);
  } else {
    scene.background = new THREE.Color('#1c1a25');
    scene.add(new THREE.HemisphereLight('#d8dcff', '#795c4a', 2.0));
    const lamp = new THREE.DirectionalLight('#ffe0bb', 2.4);
    lamp.position.set(-4, 8, 3);
    scene.add(lamp);
    player.position.set(0, 0, 2.5);
  }
  camera.position.set(player.position.x, player.position.y + 1.63, player.position.z);
  return {
    scene, camera, player, avatarMount, wallMeshes, boundary,
    dispose: () => {
      scene.traverse(object => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach(material => {
            const standard = material as THREE.MeshStandardMaterial;
            standard.map?.dispose();
            standard.normalMap?.dispose();
            standard.roughnessMap?.dispose();
            material.dispose();
          });
        }
      });
    },
  };
}
