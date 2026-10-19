import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// Proposed realistic configurations
const ASSETS_CONFIG = [
  { name: 'beach-shack', desiredSize: 5.5, axis: 'x', expected: 'Spacious beach hut' },
  { name: 'beach-coconut-cart', desiredSize: 1.9, axis: 'z', expected: 'Authentic pushcart' },
  { name: 'beach-chai-tapri', desiredSize: 2.5, axis: 'y', expected: 'Roadside tea stall' },
  { name: 'beach-maggi-stall', desiredSize: 2.5, axis: 'y', expected: 'Noodle kiosk' },
  { name: 'beach-souvenir-stall', desiredSize: 2.55, axis: 'y', expected: 'Flea market stall' },
  { name: 'beach-bbq-grill', desiredSize: 2.2, axis: 'y', expected: 'Grill counter' },
  { name: 'beach-wooden-pier', desiredSize: 14.0, axis: 'x', expected: 'Shoreline dock' },
  { name: 'beach-fishing-boat', desiredSize: 4.8, axis: 'z', expected: 'Moored fishing boat' },
  { name: 'beach-lifeguard-tower', desiredSize: 4.6, axis: 'y', expected: 'Lifeguard tower' },
  { name: 'beach-sun-lounger', desiredSize: 1.9, axis: 'x', expected: 'Twin loungers' },
  { name: 'beach-umbrella', desiredSize: 2.35, axis: 'y', expected: 'Parasol umbrella' },
  { name: 'beach-palm-tree', desiredSize: 6.8, axis: 'y', expected: 'Coconut palm' },
  { name: 'beach-campfire', desiredSize: 1.6, axis: 'x', expected: 'Campfire ring' },
  { name: 'beach-motorcycle', desiredSize: 2.15, axis: 'z', expected: 'Royal Enfield' },
  { name: 'beach-signpost', desiredSize: 2.1, axis: 'y', expected: 'Directional sign' },
  { name: 'beach-coconut-vendor', desiredSize: 1.72, axis: 'y', expected: 'Vendor' },
  { name: 'beach-chaiwala', desiredSize: 1.72, axis: 'y', expected: 'Chaiwala' },
  { name: 'beach-maggi-chef', desiredSize: 1.72, axis: 'y', expected: 'Maggi chef' },
  { name: 'beach-tourist-man', desiredSize: 1.75, axis: 'y', expected: 'Tourist man' },
  { name: 'beach-tourist-woman', desiredSize: 1.65, axis: 'y', expected: 'Tourist woman' },
];

for (const cfg of ASSETS_CONFIG) {
  const data = fs.readFileSync(`assets/runtime_models/${cfg.name}.glb`);
  const loader = new GLTFLoader();
  loader.register(() => ({ name: 'noop', loadTexture: async () => new THREE.Texture() }));
  const gltf = await loader.parseAsync(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), '');
  const bounds = new THREE.Box3().setFromObject(gltf.scene);
  const size = bounds.getSize(new THREE.Vector3());
  const scale = cfg.desiredSize / size[cfg.axis];
  const finalX = (size.x * scale).toFixed(2);
  const finalY = (size.y * scale).toFixed(2);
  const finalZ = (size.z * scale).toFixed(2);
  console.log(`${cfg.name.padEnd(23)} | Scale: ${scale.toFixed(2)}x | W:${finalX}m, H:${finalY}m, D:${finalZ}m | ${cfg.expected}`);
}
