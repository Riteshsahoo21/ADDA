import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

for (const name of ['loft16', 'school-rooftop', 'chai-stall', 'three-shops', 'tea-ground', 'maple-tree', 'boy', 'girl']) {
  const path = `assets/models/${name}`;
  const data = fs.readFileSync(`${path}.glb`);
  const manifest = JSON.parse(fs.readFileSync(`${path}.json`, 'utf8'));
  const raw = fs.readFileSync(`${path}.rgba`);
  const loader = new GLTFLoader();
  loader.register(parser => ({
    name: 'ADDA_native_rgba',
    loadTexture: async index => {
      const definition = parser.json.textures[index];
      const image = manifest[definition.source];
      if (!image) throw new Error(`missing texture ${index}`);
      const length = image.width * image.height * 4;
      if (image.offset + length > raw.length) throw new Error('texture truncated');
      const texture = new THREE.DataTexture(raw.subarray(image.offset, image.offset + length), image.width, image.height);
      texture.flipY = false;
      texture.needsUpdate = true;
      return texture;
    },
  }));
  const gltf = await loader.parseAsync(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), '');
  const bounds = new THREE.Box3().setFromObject(gltf.scene);
  const dimensions = bounds.getSize(new THREE.Vector3()).toArray().map(x => Number(x.toFixed(2)));
  const center = bounds.getCenter(new THREE.Vector3()).toArray().map(x => Number(x.toFixed(2)));
  console.log(name, { dimensions, center, meshes: gltf.scene.getObjectsByProperty('type', 'Mesh').length });
  if (name === 'school-rooftop') {
    const deck = gltf.scene.getObjectByName('Object_26');
    const steelDoor = gltf.scene.getObjectByName('Object_30');
    if (!deck || !steelDoor) throw new Error('rooftop deck or steel door mesh missing');
    const deckBounds = new THREE.Box3().setFromObject(deck);
    const deckCenter = deckBounds.getCenter(new THREE.Vector3());
    gltf.scene.scale.setScalar(0.23);
    gltf.scene.position.set(-deckCenter.x * 0.23, -deckBounds.max.y * 0.23, -deckCenter.z * 0.23);
    gltf.scene.updateMatrixWorld(true);
    const doorBounds = new THREE.Box3().setFromObject(steelDoor);
    const round = (vector) => vector.toArray().map(x => Number(x.toFixed(2)));
    console.log('rooftop steel door', { min: round(doorBounds.min), max: round(doorBounds.max), material: steelDoor.material?.name });
  }
}
