import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { GLView, ExpoWebGLRenderingContext } from 'expo-gl';
import * as THREE from 'three';
import { colors } from '@/constants/theme';
import { createNativeRenderer } from '@/three/renderer/createNativeRenderer';
import { avatarScale, loadAvatar } from '@/three/player/avatarAssets';
import { AvatarStyle } from '@/three/player/avatarStyle';

export function AvatarPreview({ style }: { style: AvatarStyle }) {
  const cleanupRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);
  const [error, setError] = useState('');
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; cleanupRef.current?.(); cleanupRef.current = null; };
  }, []);

  const onContextCreate = useCallback((gl: ExpoWebGLRenderingContext) => {
    if (!mountedRef.current) return;
    let active = true;
    let frame = 0;
    let mixer: THREE.AnimationMixer | undefined;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#DEEAE2');
    scene.add(new THREE.HemisphereLight('#ffffff', '#718B78', 2.3));
    const light = new THREE.DirectionalLight('#ffdab8', 2.2);
    light.position.set(-3, 5, 5);
    scene.add(light);
    const rim = new THREE.DirectionalLight('#D9F0DA', 1.4);
    rim.position.set(3, 4, -3);
    scene.add(rim);
    const camera = new THREE.PerspectiveCamera(42, gl.drawingBufferWidth / gl.drawingBufferHeight, 0.05, 15);
    camera.position.set(0, 1.05, 3.2);
    camera.lookAt(0, 0.95, 0);
    let renderer: THREE.WebGLRenderer;
    try { renderer = createNativeRenderer(gl); }
    catch (cause) { setError(String(cause)); return; }
    const clock = new THREE.Clock();
    const load = async () => {
      try {
        const gltf = await loadAvatar(style);
        if (!active) return;
        const model = gltf.scene;
        model.scale.setScalar(avatarScale());
        scene.add(model);
        mixer = new THREE.AnimationMixer(model);
        const idle = gltf.animations.find(clip => clip.name.toLowerCase() === 'idle') ?? gltf.animations[0];
        if (idle) mixer.clipAction(idle).play();
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void load();
    const render = () => {
      if (!active) return;
      const delta = Math.min(clock.getDelta(), 0.05);
      mixer?.update(delta);
      renderer.render(scene, camera);
      gl.endFrameEXP();
      frame = requestAnimationFrame(render);
    };
    render();
    cleanupRef.current = () => {
      active = false;
      cancelAnimationFrame(frame);
      mixer?.stopAllAction();
      scene.traverse(object => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach(material => {
            const standard = material as THREE.MeshStandardMaterial;
            standard.map?.dispose();
            standard.normalMap?.dispose();
            material.dispose();
          });
        }
      });
      renderer.dispose();
    };
  }, [style]);

  // The caller keys this component by body, so changing character
  // releases the previous GL context and loads only the chosen preset.
  return <View style={styles.frame}>
    <GLView style={StyleSheet.absoluteFill} onContextCreate={onContextCreate} />
    {error ? <View style={styles.error}><Text style={styles.errorText}>Preview unavailable: {error}</Text></View> : null}
  </View>;
}

const styles = StyleSheet.create({
  frame: { height: 235, borderRadius: 20, overflow: 'hidden', backgroundColor: '#DEEAE2', borderWidth: 1, borderColor: colors.border },
  error: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', padding: 12, backgroundColor: colors.surface },
  errorText: { color: colors.error, textAlign: 'center', fontSize: 12 },
});
