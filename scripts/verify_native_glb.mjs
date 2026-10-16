import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

for (const name of ['loft16', 'school-rooftop', 'chai-stall', 'three-shops', 'tea-ground', 'maple-tree', 'avatar-man', 'avatar-uncle', 'avatar-photo-boy', 'avatar-self', 'avatar-woman', 'avatar-chinese-woman', 'avatar-nepali-woman', 'avatar-white-top-woman']) {
  const path = `assets/runtime_models/${name}`;
  const texPath = `assets/textures/${name}`;
  const data = fs.readFileSync(`${path}.glb`);
  const manifest = JSON.parse(fs.readFileSync(`${texPath}.json`, 'utf8'));
  const raw = fs.readFileSync(`${texPath}.rgba`);
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
  let meshes = 0;
  gltf.scene.traverse(object => { if (object.isMesh) meshes += 1; });
  if (meshes === 0) throw new Error(`${name} contains no meshes`);
  console.log(name, { dimensions, center, meshes });
  if (name === 'avatar-self' || name === 'avatar-woman' || name === 'avatar-chinese-woman' || name === 'avatar-nepali-woman' || name === 'avatar-white-top-woman') {
    const expected = ['idle', 'walk', 'sprint', 'jump', 'crouch_idle', 'crouch_walk', 'sit_enter', 'sit_idle', 'sit_exit'];
    const names = gltf.animations.map(clip => clip.name);
    if (expected.some(clip => !names.includes(clip))) throw new Error(`${name} clips missing: ${names.join(', ')}`);
    let skinned = 0;
    gltf.scene.traverse(object => { if (object.isSkinnedMesh) skinned += 1; });
    if (skinned !== 1) throw new Error(`${name} expected one skinned mesh, got ${skinned}`);
    console.log(`${name} clips`, gltf.animations.map(clip => `${clip.name}:${clip.duration.toFixed(2)}s`).join(', '));
  }
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
