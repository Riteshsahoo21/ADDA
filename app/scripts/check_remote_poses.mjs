import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';

for (const name of ['avatar-man', 'avatar-uncle', 'avatar-photo-boy', 'avatar-self', 'avatar-woman', 'avatar-chinese-woman', 'avatar-nepali-woman', 'avatar-white-top-woman']) {
  const data = fs.readFileSync(`assets/runtime_models/${name}.glb`);
  const manifest = JSON.parse(fs.readFileSync(`assets/textures/${name}.json`, 'utf8'));
  const raw = fs.readFileSync(`assets/textures/${name}.rgba`);
  const loader = new GLTFLoader();
  loader.register(parser => ({
    name: 'ADDA_native_rgba',
    loadTexture: async index => {
      const image = manifest[parser.json.textures[index].source];
      const texture = new THREE.DataTexture(raw.subarray(image.offset, image.offset + image.width * image.height * 4), image.width, image.height);
      texture.flipY = false;
      texture.needsUpdate = true;
      return texture;
    },
  }));
  const gltf = await loader.parseAsync(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), '');
  const results = [];
  for (const pose of ['idle', 'crouch_idle', 'sit_idle']) {
    const model = cloneSkeleton(gltf.scene);
    const bones = [];
    model.traverse(object => { if (object.isBone) bones.push(object); });
    const before = bones.map(bone => [...bone.position.toArray(), ...bone.quaternion.toArray()]);
    const clip = gltf.animations.find(animation => animation.name === pose);
    if (!clip) throw new Error(`${name} has no ${pose} clip`);
    const mixer = new THREE.AnimationMixer(model);
    mixer.clipAction(clip).play();
    mixer.update(Math.min(0.4, clip.duration * 0.4));
    model.updateMatrixWorld(true);
    const head = bones.find(bone => /head$/i.test(bone.name));
    const headY = head?.getWorldPosition(new THREE.Vector3()).y;
    const movedBones = bones.filter((bone, index) => {
      const after = [...bone.position.toArray(), ...bone.quaternion.toArray()];
      return after.some((value, component) => Math.abs(value - before[index][component]) > 0.001);
    }).length;
    results.push(`${pose}:${movedBones}/${bones.length} headY=${headY?.toFixed(2) ?? 'n/a'}`);
    if (movedBones < 3) throw new Error(`${name} ${pose} did not animate the cloned skeleton`);
  }
  const transitionModel = cloneSkeleton(gltf.scene);
  let head;
  transitionModel.traverse(object => { if (object.isBone && /head$/i.test(object.name)) head = object; });
  const transitionMixer = new THREE.AnimationMixer(transitionModel);
  const idleAction = transitionMixer.clipAction(gltf.animations.find(clip => clip.name === 'idle'));
  idleAction.play();
  transitionMixer.update(0.2);
  const crouchAction = transitionMixer.clipAction(gltf.animations.find(clip => clip.name === 'crouch_idle'));
  idleAction.fadeOut(0.18);
  crouchAction.reset().fadeIn(0.18).play();
  transitionMixer.update(0.4);
  transitionModel.updateMatrixWorld(true);
  if (head && head.getWorldPosition(new THREE.Vector3()).y > 1.3) throw new Error(`${name} did not crouch after idle transition`);
  console.log(name, results.join(' '));
}
