import * as THREE from 'three';

export type VintageRadioInstance = {
  group: THREE.Group;
  position: THREE.Vector3;
  setPowered: (on: boolean) => void;
  update: (delta: number, isPlaying: boolean) => void;
  dispose: () => void;
};

/**
 * Creates an authentic, detailed Indian vintage tabletop transistor radio.
 * Features a warm teak wood chassis, brass knobs, speaker grille cloth,
 * backlit tuning dial, telescopic antenna, and live power LED.
 */
export function createVintageRadio(
  scene: THREE.Scene,
  position: THREE.Vector3,
  rotationY = 0
): VintageRadioInstance {
  const group = new THREE.Group();
  group.name = 'VintageRadio3D';
  group.position.copy(position);
  group.rotation.y = rotationY;

  // Dimensions of the radio (approx 0.42m wide x 0.26m high x 0.18m deep)
  const width = 0.42;
  const height = 0.26;
  const depth = 0.18;

  // 1. Wooden Outer Cabinet
  const cabinetGeo = new THREE.BoxGeometry(width, height, depth);
  const cabinetMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#4a2711'), // Deep mahogany teak
    roughness: 0.55,
    metalness: 0.08,
  });
  const cabinet = new THREE.Mesh(cabinetGeo, cabinetMat);
  cabinet.castShadow = true;
  cabinet.receiveShadow = true;
  group.add(cabinet);

  // 2. Brass Front Bezel Trim
  const bezelGeo = new THREE.BoxGeometry(width - 0.02, height - 0.02, 0.01);
  const brassMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#d4af37'), // Metallic brass / gold
    roughness: 0.32,
    metalness: 0.85,
  });
  const bezel = new THREE.Mesh(bezelGeo, brassMat);
  bezel.position.set(0, 0, depth / 2 + 0.005);
  group.add(bezel);

  // 3. Recessed Cream / Vintage Front Faceplate
  const faceGeo = new THREE.PlaneGeometry(width - 0.04, height - 0.04);
  const faceMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#e8dec8'), // Vintage cream paper
    roughness: 0.85,
    metalness: 0.02,
  });
  const faceplate = new THREE.Mesh(faceGeo, faceMat);
  faceplate.position.set(0, 0, depth / 2 + 0.012);
  group.add(faceplate);

  // 4. Circular Speaker Grille (Left half)
  const speakerRadius = 0.085;
  const speakerGeo = new THREE.CircleGeometry(speakerRadius, 24);
  const speakerClothMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#5c4a38'), // Brown woven speaker cloth
    roughness: 0.95,
    metalness: 0.0,
  });
  const speaker = new THREE.Mesh(speakerGeo, speakerClothMat);
  speaker.position.set(-width * 0.22, 0, depth / 2 + 0.015);
  group.add(speaker);

  // Speaker outer brass ring
  const ringGeo = new THREE.RingGeometry(speakerRadius - 0.006, speakerRadius + 0.004, 24);
  const ring = new THREE.Mesh(ringGeo, brassMat);
  ring.position.set(-width * 0.22, 0, depth / 2 + 0.016);
  group.add(ring);

  // 5. Backlit Tuning Dial Window (Right upper half)
  const dialWidth = 0.15;
  const dialHeight = 0.07;
  const dialGeo = new THREE.PlaneGeometry(dialWidth, dialHeight);
  const dialMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#ffdfa0'), // Amber backlit radio dial
    emissive: new THREE.Color('#ffaa33'),
    emissiveIntensity: 0.35,
    roughness: 0.2,
  });
  const dial = new THREE.Mesh(dialGeo, dialMat);
  dial.position.set(width * 0.2, height * 0.2, depth / 2 + 0.015);
  group.add(dial);

  // Red Tuning Frequency Needle
  const needleGeo = new THREE.PlaneGeometry(0.004, dialHeight - 0.01);
  const needleMat = new THREE.MeshBasicMaterial({ color: '#ff2222' });
  const needle = new THREE.Mesh(needleGeo, needleMat);
  needle.position.set(width * 0.18, height * 0.2, depth / 2 + 0.018);
  group.add(needle);

  // 6. Dual Rotary Control Knobs (Right lower half)
  const knobGeo = new THREE.CylinderGeometry(0.022, 0.022, 0.015, 16);
  knobGeo.rotateX(Math.PI / 2);

  const knobVolume = new THREE.Mesh(knobGeo, brassMat);
  knobVolume.position.set(width * 0.12, -height * 0.2, depth / 2 + 0.018);
  group.add(knobVolume);

  const knobTuning = new THREE.Mesh(knobGeo, brassMat);
  knobTuning.position.set(width * 0.28, -height * 0.2, depth / 2 + 0.018);
  group.add(knobTuning);

  // 7. Power / Broadcast Status LED Indicator
  const ledGeo = new THREE.SphereGeometry(0.007, 12, 12);
  const ledMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#22ff55'),
    emissive: new THREE.Color('#22ff55'),
    emissiveIntensity: 1.0,
    roughness: 0.1,
  });
  const led = new THREE.Mesh(ledGeo, ledMat);
  led.position.set(width * 0.2, height * 0.38, depth / 2 + 0.015);
  group.add(led);

  // 8. Telescopic Metallic Antenna
  const antennaGeo = new THREE.CylinderGeometry(0.004, 0.004, 0.38, 8);
  const chromeMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#cccccc'),
    roughness: 0.15,
    metalness: 0.95,
  });
  const antenna = new THREE.Mesh(antennaGeo, chromeMat);
  antenna.position.set(-width * 0.4, height * 0.65, -depth * 0.3);
  antenna.rotation.z = -0.22;
  antenna.rotation.x = -0.15;
  group.add(antenna);

  // 9. Floating Radio Icon Halo (Subtle pulsing indicator above the radio)
  const haloGeo = new THREE.RingGeometry(0.12, 0.14, 24);
  const haloMat = new THREE.MeshBasicMaterial({
    color: '#00e5ff',
    transparent: true,
    opacity: 0.65,
    side: THREE.DoubleSide,
  });
  const halo = new THREE.Mesh(haloGeo, haloMat);
  halo.position.set(0, height * 0.9, 0);
  halo.rotation.x = Math.PI / 2;
  group.add(halo);

  scene.add(group);

  let pulseTime = 0;
  let isPowered = true;

  const setPowered = (on: boolean) => {
    isPowered = on;
    if (on) {
      ledMat.color.set('#22ff55');
      ledMat.emissive.set('#22ff55');
      ledMat.emissiveIntensity = 1.0;
      dialMat.emissiveIntensity = 0.35;
      halo.visible = true;
    } else {
      ledMat.color.set('#ff2222');
      ledMat.emissive.set('#ff2222');
      ledMat.emissiveIntensity = 0.3;
      dialMat.emissiveIntensity = 0.02;
      halo.visible = false;
    }
  };

  const update = (delta: number, isPlaying: boolean) => {
    pulseTime += delta * 4;
    // Rotate and pulse halo
    halo.rotation.z += delta * 0.8;
    const haloScale = 1.0 + Math.sin(pulseTime) * 0.12;
    halo.scale.set(haloScale, haloScale, 1);

    // Speaker bounce when playing
    if (isPlaying && isPowered) {
      const beat = 1.0 + Math.sin(pulseTime * 2.5) * 0.05;
      speaker.scale.set(beat, beat, 1);
    } else {
      speaker.scale.set(1, 1, 1);
    }
  };

  const dispose = () => {
    cabinetGeo.dispose();
    cabinetMat.dispose();
    bezelGeo.dispose();
    brassMat.dispose();
    faceGeo.dispose();
    faceMat.dispose();
    speakerGeo.dispose();
    speakerClothMat.dispose();
    ringGeo.dispose();
    dialGeo.dispose();
    dialMat.dispose();
    needleGeo.dispose();
    needleMat.dispose();
    knobGeo.dispose();
    ledGeo.dispose();
    ledMat.dispose();
    antennaGeo.dispose();
    chromeMat.dispose();
    haloGeo.dispose();
    haloMat.dispose();
    scene.remove(group);
  };

  return { group, position: group.position, setPowered, update, dispose };
}
