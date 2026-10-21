import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const beachModels = [
  'beach-shack', 'beach-coconut-cart', 'beach-chai-tapri', 'beach-maggi-stall',
  'beach-souvenir-stall', 'beach-bbq-grill', 'beach-wooden-pier', 'beach-fishing-boat',
  'beach-lifeguard-tower', 'beach-sun-lounger', 'beach-umbrella', 'beach-palm-tree',
  'beach-campfire', 'beach-motorcycle', 'beach-signpost', 'beach-coconut-vendor',
  'beach-chaiwala', 'beach-maggi-chef', 'beach-tourist-man', 'beach-tourist-woman'
];

for (const name of beachModels) {
  const path = `assets/runtime_models/${name}`;
  const data = fs.readFileSync(`${path}.glb`);
  const loader = new GLTFLoader();
  loader.register(() => ({
    name: 'noop',
    loadTexture: async () => new THREE.Texture(),
  }));
  const gltf = await loader.parseAsync(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), '');
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const sz = box.getSize(new THREE.Vector3());
  console.log(`${name.padEnd(23)} | Size: [X:${sz.x.toFixed(2)}, Y:${sz.y.toFixed(2)}, Z:${sz.z.toFixed(2)}] | MinY: ${box.min.y.toFixed(2)} MaxY: ${box.max.y.toFixed(2)}`);
}
