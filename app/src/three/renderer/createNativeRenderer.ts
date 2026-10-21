import * as THREE from 'three';
import type { ExpoWebGLRenderingContext } from 'expo-gl';

/** Three.js needs a small canvas shape even though expo-gl owns the native surface. */
export function createNativeRenderer(gl: ExpoWebGLRenderingContext): THREE.WebGLRenderer {
  // Expo GL implements FLIP_Y and ALIGNMENT but logs for these browser-only
  // unpack modes. Our predecoded RGBA texture data needs neither mode.
  const pixelStorei = gl.pixelStorei.bind(gl);
  gl.pixelStorei = (parameter: number, value: number | boolean) => {
    if (parameter === gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL || parameter === gl.UNPACK_COLORSPACE_CONVERSION_WEBGL) return;
    pixelStorei(parameter, value);
  };
  const canvas = {
    width: gl.drawingBufferWidth,
    height: gl.drawingBufferHeight,
    clientWidth: gl.drawingBufferWidth,
    clientHeight: gl.drawingBufferHeight,
    style: {},
    addEventListener: () => {},
    removeEventListener: () => {},
    setAttribute: () => {},
    getContext: () => gl,
  };

  const renderer = new THREE.WebGLRenderer({
    canvas: canvas as unknown as HTMLCanvasElement,
    context: gl as unknown as WebGLRenderingContext,
    antialias: false,
    alpha: false,
  });
  renderer.setPixelRatio(1); // drawingBuffer is already in physical pixels
  renderer.setSize(gl.drawingBufferWidth, gl.drawingBufferHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  return renderer;
}
