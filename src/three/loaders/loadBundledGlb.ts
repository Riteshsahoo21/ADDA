import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as THREE from 'three';

export type NativeTextureImage = { offset: number; width: number; height: number };

export type NativeTexturePack = { moduleId: number; images: NativeTextureImage[] };

/** Reads a bundled GLB from device storage; never asks Three.js to fetch a URL. */
export async function loadBundledGlb(moduleId: number, texturePack?: NativeTexturePack) {
  const asset = await Asset.fromModule(moduleId).downloadAsync();
  if (!asset.localUri) throw new Error(`No local file for ${asset.name}.glb`);
  const data = await new File(asset.localUri).arrayBuffer();
  // Three r162 checks navigator.userAgent while choosing its image loader.
  // React Native provides navigator but may omit this browser-only property.
  if (typeof navigator !== 'undefined' && !navigator.userAgent) {
    Object.defineProperty(navigator, 'userAgent', { value: 'ReactNative', configurable: true });
  }
  const loader = new GLTFLoader();
  if (texturePack) {
    const pixelsAsset = await Asset.fromModule(texturePack.moduleId).downloadAsync();
    if (!pixelsAsset.localUri) throw new Error(`No native textures for ${asset.name}`);
    const pixels = await new File(pixelsAsset.localUri).arrayBuffer();
    loader.register((parser) => ({
      name: 'ADDA_native_rgba',
      loadTexture: async (textureIndex: number) => {
        const textureDef = parser.json.textures?.[textureIndex];
        const image = texturePack.images[textureDef?.source];
        if (!image) throw new Error(`Missing native texture ${textureDef?.source} in ${asset.name}`);
        const length = image.width * image.height * 4;
        if (image.offset + length > pixels.byteLength) throw new Error(`Truncated native texture in ${asset.name}`);
        const bytes = new Uint8Array(pixels, image.offset, length);
        const texture = new THREE.DataTexture(bytes, image.width, image.height, THREE.RGBAFormat);
        const sampler = parser.json.samplers?.[textureDef.sampler ?? -1];
        texture.flipY = false;
        texture.magFilter = sampler?.magFilter === 9728 ? THREE.NearestFilter : THREE.LinearFilter;
        texture.minFilter = sampler?.minFilter === 9728 || sampler?.minFilter === 9984 || sampler?.minFilter === 9986
          ? THREE.NearestFilter : sampler?.minFilter === 9729 ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
        texture.wrapS = sampler?.wrapS === 33071 ? THREE.ClampToEdgeWrapping : sampler?.wrapS === 33648 ? THREE.MirroredRepeatWrapping : THREE.RepeatWrapping;
        texture.wrapT = sampler?.wrapT === 33071 ? THREE.ClampToEdgeWrapping : sampler?.wrapT === 33648 ? THREE.MirroredRepeatWrapping : THREE.RepeatWrapping;
        texture.needsUpdate = true;
        return texture;
      },
    }));
  }
  return loader.parseAsync(data, '');
}
