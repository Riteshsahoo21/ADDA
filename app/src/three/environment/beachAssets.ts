/* eslint-disable @typescript-eslint/no-require-imports */
import { NativeTextureImage } from '../loaders/loadBundledGlb';

export interface BeachAssetItem {
  id: number;
  model: string;
  texture: string;
  modelSource: number;
  textureSource: number;
  images: NativeTextureImage[];
  name: string;
  size: number;
  axis: 'x' | 'y' | 'z';
  x: number;
  z: number;
  rotationY: number;
  collisionRadius: number;
  customY?: number;
  clones?: { x: number; z: number; rotationY: number; customY?: number; collisionRadius?: number }[];
}

/**
 * 11 Curated Iconic Goa Beach Landmarks.
 * Configured with 1:1 human proportions, 1024px HD textures, and optimal mobile scene density.
 * Bundled statically into the app bundle for 0 network download latency.
 */
export const BEACH_ASSETS: BeachAssetItem[] = [
  // 1. Goa Beach Shack (Central Beachfront Bar & Restaurant)
  {
    id: 1,
    model: 'models/beach-shack.glb',
    texture: 'textures/beach-shack.rgba',
    modelSource: require('../../../assets/runtime_models/beach-shack.glb'),
    textureSource: require('../../../assets/textures/beach-shack.rgba'),
    images: require('../../../assets/textures/beach-shack.json'),
    name: 'Goa Beach Shack',
    size: 5.5,
    axis: 'x',
    x: 0,
    z: 22,
    rotationY: 0,
    collisionRadius: 3.2,
  },

  // 2. Wooden Pier / Boardwalk (Walkable dock extending 20m out over ocean water)
  {
    id: 2,
    model: 'models/beach-wooden-pier.glb',
    texture: 'textures/beach-wooden-pier.rgba',
    modelSource: require('../../../assets/runtime_models/beach-wooden-pier.glb'),
    textureSource: require('../../../assets/textures/beach-wooden-pier.rgba'),
    images: require('../../../assets/textures/beach-wooden-pier.json'),
    name: 'Wooden Ocean Pier',
    size: 3.2,
    axis: 'z',
    x: 0,
    z: -0.5,
    rotationY: Math.PI / 2,
    collisionRadius: 0, // Walkable deck
    customY: -2.68,
    clones: [
      { x: 0, z: -7.19, rotationY: Math.PI / 2, customY: -2.68 },
      { x: 0, z: -13.88, rotationY: Math.PI / 2, customY: -2.68 },
    ],
  },

  // 3. Goan Fishing Boat (Moored in water beside the pier)
  {
    id: 3,
    model: 'models/beach-fishing-boat.glb',
    texture: 'textures/beach-fishing-boat.rgba',
    modelSource: require('../../../assets/runtime_models/beach-fishing-boat.glb'),
    textureSource: require('../../../assets/textures/beach-fishing-boat.rgba'),
    images: require('../../../assets/textures/beach-fishing-boat.json'),
    name: 'Goan Fishing Boat',
    size: 4.8,
    axis: 'z',
    x: 3.6,
    z: -9.0,
    rotationY: 0.35,
    collisionRadius: 2.2,
    customY: -0.28,
  },

  // 4. Lifeguard Lookout Tower (East beach viewpoint)
  {
    id: 4,
    model: 'models/beach-lifeguard-tower.glb',
    texture: 'textures/beach-lifeguard-tower.rgba',
    modelSource: require('../../../assets/runtime_models/beach-lifeguard-tower.glb'),
    textureSource: require('../../../assets/textures/beach-lifeguard-tower.rgba'),
    images: require('../../../assets/textures/beach-lifeguard-tower.json'),
    name: 'Lifeguard Tower',
    size: 4.5,
    axis: 'y',
    x: 24,
    z: 6,
    rotationY: -0.3,
    collisionRadius: 2.0,
  },

  // 5. Cutting Chai Tapri (Food Lane West)
  {
    id: 5,
    model: 'models/beach-chai-tapri.glb',
    texture: 'textures/beach-chai-tapri.rgba',
    modelSource: require('../../../assets/runtime_models/beach-chai-tapri.glb'),
    textureSource: require('../../../assets/textures/beach-chai-tapri.rgba'),
    images: require('../../../assets/textures/beach-chai-tapri.json'),
    name: 'Cutting Chai Tapri',
    size: 2.5,
    axis: 'y',
    x: -8,
    z: 30,
    rotationY: -0.1,
    collisionRadius: 1.6,
  },

  // 6. Beach Maggi Stall (Food Lane East)
  {
    id: 6,
    model: 'models/beach-maggi-stall.glb',
    texture: 'textures/beach-maggi-stall.rgba',
    modelSource: require('../../../assets/runtime_models/beach-maggi-stall.glb'),
    textureSource: require('../../../assets/textures/beach-maggi-stall.rgba'),
    images: require('../../../assets/textures/beach-maggi-stall.json'),
    name: 'Beach Maggi Stall',
    size: 2.6,
    axis: 'y',
    x: 8,
    z: 30,
    rotationY: 0.1,
    collisionRadius: 1.6,
  },

  // 7. Sunset Bonfire / Campfire (Beachfront seating ring)
  {
    id: 7,
    model: 'models/beach-campfire.glb',
    texture: 'textures/beach-campfire.rgba',
    modelSource: require('../../../assets/runtime_models/beach-campfire.glb'),
    textureSource: require('../../../assets/textures/beach-campfire.rgba'),
    images: require('../../../assets/textures/beach-campfire.json'),
    name: 'Sunset Campfire',
    size: 2.0,
    axis: 'x',
    x: -16,
    z: 16,
    rotationY: 0.2,
    collisionRadius: 1.4,
  },

  // 8. Coastal Trail Signpost (Spawn orientation point)
  {
    id: 8,
    model: 'models/beach-signpost.glb',
    texture: 'textures/beach-signpost.rgba',
    modelSource: require('../../../assets/runtime_models/beach-signpost.glb'),
    textureSource: require('../../../assets/textures/beach-signpost.rgba'),
    images: require('../../../assets/textures/beach-signpost.json'),
    name: 'Coastal Signpost',
    size: 1.8,
    axis: 'y',
    x: -2,
    z: 8,
    rotationY: -0.3,
    collisionRadius: 0.5,
  },

  // 9. Beach Sun Loungers (Ocean-facing relaxation)
  {
    id: 9,
    model: 'models/beach-sun-lounger.glb',
    texture: 'textures/beach-sun-lounger.rgba',
    modelSource: require('../../../assets/runtime_models/beach-sun-lounger.glb'),
    textureSource: require('../../../assets/textures/beach-sun-lounger.rgba'),
    images: require('../../../assets/textures/beach-sun-lounger.json'),
    name: 'Beach Sun Lounger',
    size: 1.9,
    axis: 'z',
    x: -6,
    z: 12,
    rotationY: Math.PI,
    collisionRadius: 1.0,
    clones: [
      { x: 6, z: 12, rotationY: Math.PI },
      { x: -12, z: 10, rotationY: Math.PI + 0.1 },
      { x: 12, z: 10, rotationY: Math.PI - 0.1 },
    ],
  },

  // 10. Striped Shade Umbrellas
  {
    id: 10,
    model: 'models/beach-umbrella.glb',
    texture: 'textures/beach-umbrella.rgba',
    modelSource: require('../../../assets/runtime_models/beach-umbrella.glb'),
    textureSource: require('../../../assets/textures/beach-umbrella.rgba'),
    images: require('../../../assets/textures/beach-umbrella.json'),
    name: 'Beach Umbrella',
    size: 2.4,
    axis: 'y',
    x: -6,
    z: 12.8,
    rotationY: 0.2,
    collisionRadius: 0.8,
    clones: [
      { x: 6, z: 12.8, rotationY: -0.4 },
      { x: -12, z: 10.8, rotationY: 0.5 },
      { x: 12, z: 10.8, rotationY: -0.3 },
    ],
  },

  // 11. Coconut Palm Trees (Lush tropical backdrop along the back ridge)
  {
    id: 11,
    model: 'models/beach-palm-tree.glb',
    texture: 'textures/beach-palm-tree.rgba',
    modelSource: require('../../../assets/runtime_models/beach-palm-tree.glb'),
    textureSource: require('../../../assets/textures/beach-palm-tree.rgba'),
    images: require('../../../assets/textures/beach-palm-tree.json'),
    name: 'Coconut Palm Tree',
    size: 7.5,
    axis: 'y',
    x: -24,
    z: 38,
    rotationY: 0.4,
    collisionRadius: 1.2,
    clones: [
      { x: -12, z: 40, rotationY: -0.8 },
      { x: 0, z: 42, rotationY: 1.2 },
      { x: 14, z: 40, rotationY: 2.1 },
      { x: 26, z: 38, rotationY: -1.5 },
    ],
  },
];
