import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as THREE from 'three';
import { readRoomAssetBytes } from '../roomAssets';

export type NativeTextureImage = { offset: number; width: number; height: number };

export type NativeTexturePack = { moduleId: number | string; images: NativeTextureImage[] };

/** Read a bundled avatar or a downloaded room asset from device storage. */
export async function loadBundledGlb(moduleId: number | string, texturePack?: NativeTexturePack) {
  const asset = typeof moduleId === 'number' ? await Asset.fromModule(moduleId).downloadAsync() : null;
  const uri = asset?.localUri ?? (typeof moduleId === 'string' ? moduleId : null);
  if (!uri) throw new Error('No local GLB file.');
  const label = asset?.name ?? 'room model';
  const data = typeof moduleId === 'string' ? await readRoomAssetBytes(uri) : await new File(uri).arrayBuffer();
  // Three r162 checks navigator.userAgent while choosing its image loader.
  // React Native provides navigator but may omit this browser-only property.
  if (typeof navigator !== 'undefined' && !navigator.userAgent) {
    Object.defineProperty(navigator, 'userAgent', { value: 'ReactNative', configurable: true });
  }
  const loader = new GLTFLoader();
  if (texturePack) {
    const pixelsAsset = typeof texturePack.moduleId === 'number' ? await Asset.fromModule(texturePack.moduleId).downloadAsync() : null;
    const pixelsUri = pixelsAsset?.localUri ?? (typeof texturePack.moduleId === 'string' ? texturePack.moduleId : null);
    if (!pixelsUri) throw new Error(`No native textures for ${label}`);
    const pixels = typeof texturePack.moduleId === 'string' ? await readRoomAssetBytes(pixelsUri) : await new File(pixelsUri).arrayBuffer();
    loader.register((parser) => ({
      name: 'ADDA_native_rgba',
      loadTexture: async (textureIndex: number) => {
        const textureDef = parser.json.textures?.[textureIndex];
        const image = texturePack.images[textureDef?.source];
        if (!image) throw new Error(`Missing native texture ${textureDef?.source} in ${label}`);
        const length = image.width * image.height * 4;
        if (image.offset + length > pixels.byteLength) throw new Error(`Truncated native texture in ${label}`);
        const bytes = (pixels instanceof Uint8Array
          ? new Uint8Array(pixels.buffer, pixels.byteOffset + image.offset, length)
          : new Uint8Array(pixels, image.offset, length)) as Uint8Array<ArrayBuffer>;
        const texture = new THREE.DataTexture(bytes, image.width, image.height, THREE.RGBAFormat);
        const sampler = parser.json.samplers?.[textureDef.sampler ?? -1];
        texture.flipY = false;
        texture.anisotropy = 4;
        texture.magFilter = THREE.LinearFilter;
        texture.minFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;
        texture.wrapS = sampler?.wrapS === 33071 ? THREE.ClampToEdgeWrapping : sampler?.wrapS === 33648 ? THREE.MirroredRepeatWrapping : THREE.RepeatWrapping;
        texture.wrapT = sampler?.wrapT === 33071 ? THREE.ClampToEdgeWrapping : sampler?.wrapT === 33648 ? THREE.MirroredRepeatWrapping : THREE.RepeatWrapping;
        texture.needsUpdate = true;
        return texture;
      },
    }));
  }
  const buffer = data instanceof Uint8Array
    ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
    : data;
  return loader.parseAsync(buffer, '');
}
