import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GLView, ExpoWebGLRenderingContext } from 'expo-gl';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as THREE from 'three';
import { colors } from '@/constants/theme';
import { createGameScene, RoomKind } from '@/three/environment/createGameScene';
import { createLoftDetails } from '@/three/environment/loftDetails';
import { addMapleTrees } from '@/three/environment/teaBoundary';
import { canWalkTea, createTeaSeats, TeaObstacle, TeaSeat, teaObstacleFromBounds, teaStallObstacle } from '@/three/environment/teaInteractions';
import { loadBundledGlb } from '@/three/loaders/loadBundledGlb';
import { createNativeRenderer } from '@/three/renderer/createNativeRenderer';
import { avatarScale, loadAvatar } from '@/three/player/avatarAssets';
import { AvatarStyle } from '@/three/player/avatarStyle';

const STICK_SIZE = 110;
const STICK_TRAVEL = 37;
const RESTING_STICK = { x: 74, y: 121 };
type Stick = { x: number; y: number };
type ViewMode = 'FPP' | 'TPP';
type SeatUi = 'free' | 'approaching' | 'entering' | 'seated' | 'exiting';

function fitModel(model: THREE.Group, desiredSize: number, axis: 'x' | 'y') {
  const bounds = new THREE.Box3().setFromObject(model);
  const size = bounds.getSize(new THREE.Vector3());
  model.scale.setScalar(desiredSize / size[axis]);
  const fitted = new THREE.Box3().setFromObject(model);
  const center = fitted.getCenter(new THREE.Vector3());
  model.position.set(-center.x, -fitted.min.y, -center.z);
  return model;
}

function fitLoftModel(model: THREE.Group) {
  // The glTF parent transforms already put the loft in Three.js Y-up space.
  fitModel(model, 10.6, 'x');
  const floor = model.getObjectByName('Plane_Material001_0');
  if (floor) {
    const floorTop = new THREE.Box3().setFromObject(floor).max.y;
    model.position.y -= floorTop;
  }
  return model;
}

function fitRoofModel(model: THREE.Group) {
  // Scale the source's 110-unit deck to roughly 25 metres, with its walkable
  // surface at player height. Use the deck, not remote scenery, for centering.
  const deck = model.getObjectByName('Object_26');
  if (!deck) throw new Error('Rooftop deck is missing from school-rooftop.glb');
  const bounds = new THREE.Box3().setFromObject(deck);
  const center = bounds.getCenter(new THREE.Vector3());
  const scale = 0.23;
  model.scale.setScalar(scale);
  model.position.set(-center.x * scale, -bounds.max.y * scale, -center.z * scale);
  return model;
}

function addSofaTouchZones(scene: THREE.Scene, targets: THREE.Object3D[]) {
  const material = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
  const sections = [
    { width: 1.85, depth: 6.65, x: -3.27, z: -1.34 },
    { width: 3.75, depth: 1.75, x: -0.4, z: -4.02 },
  ];
  for (const section of sections) {
    const zone = new THREE.Mesh(new THREE.BoxGeometry(section.width, 1.1, section.depth), material);
    zone.position.set(section.x, 0.55, section.z);
    zone.name = 'Black sofa touch target';
    scene.add(zone);
    targets.push(zone);
  }
}

function fallbackAvatar() {
  const group = new THREE.Group();
  const fabric = new THREE.MeshStandardMaterial({ color: '#6c8caa' });
  const skin = new THREE.MeshStandardMaterial({ color: '#b98262' });
  const pants = new THREE.MeshStandardMaterial({ color: '#34394a' });
  const parts: [THREE.BufferGeometry, THREE.Material, number, number][] = [
    [new THREE.CapsuleGeometry(0.3, 0.6, 4, 10), fabric, 0, 1.05],
    [new THREE.SphereGeometry(0.25, 12, 10), skin, 0, 1.72],
    [new THREE.CapsuleGeometry(0.12, 0.52, 3, 8), pants, -0.17, 0.37],
    [new THREE.CapsuleGeometry(0.12, 0.52, 3, 8), pants, 0.17, 0.37],
    [new THREE.CapsuleGeometry(0.11, 0.42, 3, 8), fabric, -0.4, 1.07],
    [new THREE.CapsuleGeometry(0.11, 0.42, 3, 8), fabric, 0.4, 1.07],
  ];
  for (const [geometry, material, x, y] of parts) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, 0);
    group.add(mesh);
  }
  return group;
}

export function GameRoom({ roomKind, avatar, onPortal }: { roomKind: RoomKind; avatar: AvatarStyle; onPortal: () => void }) {
  const [status, setStatus] = useState<'initializing' | 'ready' | 'error'>('initializing');
  const [assetStatus, setAssetStatus] = useState('Loading room assets');
  const [error, setError] = useState('');
  const [fps, setFps] = useState(0);
  const [stick, setStick] = useState<Stick>({ x: 0, y: 0 });
  const [stickAnchor, setStickAnchor] = useState(RESTING_STICK);
  const [sprinting, setSprinting] = useState(false);
  const [crouched, setCrouched] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('FPP');
  const [seatUi, setSeatUi] = useState<SeatUi>('free');
  const [nearSofa, setNearSofa] = useState(false);
  const [nearDoor, setNearDoor] = useState(false);
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const mounted = useRef(true);
  const movement = useRef<Stick>({ x: 0, y: 0 });
  const yaw = useRef(roomKind === 'roof' ? Math.PI / 2 : 0);
  const pitch = useRef(0);
  const modeRef = useRef<ViewMode>('FPP');
  const crouchRef = useRef(false);
  const jumpRequested = useRef(false);
  const sitRequested = useRef(false);
  const standRequested = useRef(false);
  const pendingWorldTap = useRef<{ x: number; y: number } | null>(null);
  const windowSize = useRef({ width: windowWidth, height: windowHeight });
  const cleanup = useRef<(() => void) | null>(null);
  const lookTranslation = useRef({ x: 0, y: 0 });
  const insets = useSafeAreaInsets();

  useEffect(() => { windowSize.current = { width: windowWidth, height: windowHeight }; }, [windowWidth, windowHeight]);

  const updateStick = useCallback((x: number, y: number) => {
    const distance = Math.hypot(x, y);
    const factor = distance > STICK_TRAVEL ? STICK_TRAVEL / distance : 1;
    const next = { x: x * factor / STICK_TRAVEL, y: y * factor / STICK_TRAVEL };
    const magnitude = Math.hypot(next.x, next.y);
    movement.current = magnitude < 0.1 ? { x: 0, y: 0 } : next;
    setStick(movement.current);
    setSprinting(next.y <= -0.82 && Math.abs(next.x) <= 0.65);
  }, []);

  const beginLook = useCallback(() => { lookTranslation.current = { x: 0, y: 0 }; }, []);
  const moveLook = useCallback((x: number, y: number) => {
    yaw.current += (x - lookTranslation.current.x) * 0.0051;
    pitch.current = THREE.MathUtils.clamp(pitch.current - (y - lookTranslation.current.y) * 0.0040, -0.9, 0.9);
    lookTranslation.current = { x, y };
  }, []);
  const beginMove = useCallback((x: number, y: number) => {
    setStickAnchor({ x: THREE.MathUtils.clamp(x, 55, 165), y: THREE.MathUtils.clamp(y, 55, 135) });
    updateStick(0, 0);
  }, [updateStick]);
  const moveMove = useCallback((x: number, y: number) => {
    updateStick(x, y);
  }, [updateStick]);
  const jump = useCallback(() => { crouchRef.current = false; setCrouched(false); jumpRequested.current = true; }, []);
  const toggleCrouch = useCallback(() => { crouchRef.current = !crouchRef.current; setCrouched(crouchRef.current); }, []);
  const tapWorld = useCallback((x: number, y: number) => {
    pendingWorldTap.current = { x, y };
    if (__DEV__) console.log('[ADDA touch] Room tap', roomKind, Math.round(x), Math.round(y));
  }, [roomKind]);
  const standUp = useCallback(() => { standRequested.current = true; }, []);
  const sitDown = useCallback(() => { sitRequested.current = true; }, []);

  // Gesture Handler stores these callbacks and invokes them only for touch events.
  /* eslint-disable react-hooks/refs */
  const gestures = useMemo(() => {
    const look = Gesture.Pan().minDistance(2).runOnJS(true)
      .onBegin(beginLook)
      .onUpdate((event) => moveLook(event.translationX, event.translationY));
    const move = Gesture.Pan().minDistance(0).runOnJS(true)
      .onBegin((event) => beginMove(event.x, event.y))
      .onUpdate((event) => moveMove(event.translationX, event.translationY))
      .onFinalize(() => { updateStick(0, 0); setStickAnchor(RESTING_STICK); });
    look.simultaneousWithExternalGesture(move);
    move.simultaneousWithExternalGesture(look);
    const worldTap = Gesture.Tap().maxDistance(12).runOnJS(true).simultaneousWithExternalGesture(look)
      .onEnd((event, success) => { if (success) tapWorld(event.absoluteX, event.absoluteY); });
    const jumpTap = Gesture.Tap().runOnJS(true).simultaneousWithExternalGesture(move, look)
      .onEnd((_event, success) => { if (success) jump(); });
    const crouchTap = Gesture.Tap().runOnJS(true).simultaneousWithExternalGesture(move, look)
      .onEnd((_event, success) => { if (success) toggleCrouch(); });
    return { look: Gesture.Simultaneous(look, worldTap), move, jumpTap, crouchTap };
  }, [beginLook, moveLook, beginMove, moveMove, updateStick, jump, toggleCrouch, tapWorld]);
  /* eslint-enable react-hooks/refs */

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; cleanup.current?.(); cleanup.current = null; };
  }, []);

  const onContextCreate = useCallback((gl: ExpoWebGLRenderingContext) => {
    if (!mounted.current) return;
    let renderer: THREE.WebGLRenderer | undefined;
    let world: ReturnType<typeof createGameScene> | undefined;
    let mixer: THREE.AnimationMixer | undefined;
    type AvatarClips = {
      idle?: THREE.AnimationAction;
      walk?: THREE.AnimationAction;
      sprint?: THREE.AnimationAction;
      jump?: THREE.AnimationAction;
      crouchIdle?: THREE.AnimationAction;
      crouchWalk?: THREE.AnimationAction;
      sitEnter?: THREE.AnimationAction;
      sitIdle?: THREE.AnimationAction;
      sitExit?: THREE.AnimationAction;
    };
    const clips: AvatarClips = {};
    let playing: THREE.AnimationAction | undefined;
    let frame = 0;
    let active = true;
    const ray = new THREE.Raycaster();
    const focus = new THREE.Vector3();
    const desired = new THREE.Vector3();
    const heading = new THREE.Vector3();
    const velocity = new THREE.Vector3();
    const moveDirection = new THREE.Vector3();
    const toCamera = new THREE.Vector3();
    const tapNdc = new THREE.Vector2();
    const sofaMeshes: THREE.Object3D[] = [];
    const portalMeshes: THREE.Object3D[] = [];
    const teaSeats: TeaSeat[] = [];
    const teaObstacles: TeaObstacle[] = [];
    const loftDoor = new THREE.Vector3();
    const roofDoor = new THREE.Vector3();
    let roofDoorBounds: THREE.Box3 | null = null;
    const seatTarget = new THREE.Vector3();
    const seatApproach = new THREE.Vector3();
    let seatHeading = -Math.PI / 2;
    let seatElevation = 0;
    let currentSeatElevation = 0;
    let seatPhase: SeatUi = 'free';
    let seatTime = 0;
    let wasNearSofa = false;
    let wasNearDoor = false;
    let cameraTooClose = false;
    try {
      renderer = createNativeRenderer(gl);
      world = createGameScene(gl.drawingBufferWidth / gl.drawingBufferHeight, roomKind);
      const room = world;
      const fallback = fallbackAvatar();
      room.avatarMount.add(fallback);

      const loadModels = async () => {
        const failures: string[] = [];
        try {
          const gltf = await loadAvatar(avatar);
          if (!active) return;
          // Skinned-mesh Box3 bounds do not describe the actual posed height.
          // Calibrate from the rig's head and foot bones to the existing controller.
          const model = gltf.scene;
          model.scale.setScalar(avatarScale());
          // The avatar is authored facing +Z; the controller faces -Z at yaw zero.
          model.rotation.y = Math.PI;
          room.avatarMount.remove(fallback);
          room.avatarMount.add(model);
          mixer = new THREE.AnimationMixer(model);
          for (const clip of gltf.animations) {
            const name = clip.name.toLowerCase();
            const action = mixer.clipAction(clip);
            if (name === 'idle' || name === 'idle_loop') clips.idle = action;
            else if (name === 'walk' || name === 'walk_loop') clips.walk = action;
            else if (name === 'sprint' || name === 'run' || name === 'sprint_loop') clips.sprint = action;
            else if (name === 'jump' || name === 'jump_loop') clips.jump = action;
            else if (name === 'crouch_idle' || name === 'crouchidle' || name === 'crouch_idle_loop') clips.crouchIdle = action;
            else if (name === 'crouch_walk' || name === 'crouchwalk' || name === 'crouch_fwd_loop') clips.crouchWalk = action;
            else if (name === 'sit_enter') clips.sitEnter = action;
            else if (name === 'sit_idle') clips.sitIdle = action;
            else if (name === 'sit_exit') clips.sitExit = action;
          }
          clips.sprint = clips.sprint ?? clips.walk;
          clips.crouchIdle = clips.crouchIdle ?? clips.idle;
          clips.crouchWalk = clips.crouchWalk ?? clips.walk;
          clips.jump = clips.jump ?? clips.walk;
          for (const action of [clips.sitEnter, clips.sitExit]) {
            action?.setLoop(THREE.LoopOnce, 1);
            if (action) action.clampWhenFinished = true;
          }

          playing = clips.idle;
          playing?.play();
        } catch (cause) { failures.push(`avatar: ${String(cause)}`); console.warn('[ADDA GL] Avatar failed', cause); }
        const roomAssets = roomKind === 'loft' ? [
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          { id: require('../../../assets/models/loft16.glb'), texture: require('../../../assets/textures/loft16.rgba'), images: require('../../../assets/textures/loft16.json'), name: 'Loft 16', size: 10.6, axis: 'x' as const, x: 0, z: 0, rotation: 0, rawScale: false },
        ] : roomKind === 'roof' ? [
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          { id: require('../../../assets/models/school-rooftop.glb'), texture: require('../../../assets/textures/school-rooftop.rgba'), images: require('../../../assets/textures/school-rooftop.json'), name: 'School Rooftop', size: 1, axis: 'x' as const, x: 0, z: 0, rotation: 0, rawScale: true },
        ] : [
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          { id: require('../../../assets/models/tea-ground.glb'), texture: require('../../../assets/textures/tea-ground.rgba'), images: require('../../../assets/textures/tea-ground.json'), name: 'road and ground', size: 26, axis: 'x' as const, x: 0, z: 0, rotation: 0, rawScale: true },
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          { id: require('../../../assets/models/chai-stall.glb'), texture: require('../../../assets/textures/chai-stall.rgba'), images: require('../../../assets/textures/chai-stall.json'), name: 'chai stall and bench', size: 3.2, axis: 'y' as const, x: -7.2, z: -2.2, rotation: Math.PI / 2, rawScale: false },
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          { id: require('../../../assets/models/three-shops.glb'), texture: require('../../../assets/textures/three-shops.rgba'), images: require('../../../assets/textures/three-shops.json'), name: 'three shops', size: 2.8, axis: 'y' as const, x: 7.7, z: -2.2, rotation: -Math.PI / 2, rawScale: false },
        ];
        for (const item of roomAssets) {
          try {
            const gltf = await loadBundledGlb(item.id, { moduleId: item.texture, images: item.images });
            if (!active) return;
            const holder = new THREE.Group();
            holder.name = `Imported ${item.name}`;
            if (roomKind === 'loft') {
              holder.add(fitLoftModel(gltf.scene));
            } else if (roomKind === 'roof') {
              holder.add(fitRoofModel(gltf.scene));
            } else if (item.rawScale) {
              holder.add(gltf.scene);
            } else {
              holder.add(fitModel(gltf.scene, item.size, item.axis));
            }
            holder.position.set(item.x, 0, item.z);
            holder.rotation.y = item.rotation;
            room.scene.add(holder);
            if (roomKind === 'tea' && item.name === 'chai stall and bench') {
              holder.updateMatrixWorld(true);
              teaSeats.push(...createTeaSeats(gltf.scene));
              teaObstacles.push(teaStallObstacle(gltf.scene));
            }
            if (roomKind === 'tea' && item.name === 'three shops') {
              holder.updateMatrixWorld(true);
              teaObstacles.push(teaObstacleFromBounds(new THREE.Box3().setFromObject(holder), 0.32));
            }
            if (roomKind === 'roof') {
              holder.updateMatrixWorld(true);
              const steelDoor = holder.getObjectByName('Object_30');
              if (steelDoor) {
                roofDoorBounds = new THREE.Box3().setFromObject(steelDoor);
                const doorCenter = roofDoorBounds.getCenter(new THREE.Vector3());
                // The steel door is on the near (-X) face of the rooftop building.
                roofDoor.set(roofDoorBounds.min.x, 0, doorCenter.z);
                room.player.position.set(roofDoor.x - 2.6, 0, roofDoor.z);
                portalMeshes.push(steelDoor);
                room.wallMeshes.push(steelDoor);
              } else failures.push('rooftop steel door not found in model');
            }
            if (roomKind === 'loft') {
              holder.updateMatrixWorld(true);
              const blackSofa = holder.getObjectByName('node_0002_S-Remesh003_Material008_0');
              if (blackSofa instanceof THREE.Mesh) addSofaTouchZones(room.scene, sofaMeshes);
              const floor = holder.getObjectByName('Plane_Material001_0');
              if (floor) {
                const details = createLoftDetails(room.scene, new THREE.Box3().setFromObject(floor));
                portalMeshes.push(...details.tapMeshes);
                loftDoor.copy(details.doorPosition);
                room.wallMeshes.push(details.wallMesh);
              } else failures.push('loft floor not found for new wall');
              if (!sofaMeshes.length) failures.push('black sofa surface not found');
            }
          } catch (cause) { failures.push(`${item.name}: ${String(cause)}`); console.warn(`[ADDA GL] ${item.name} failed`, cause); }
        }
        if (roomKind === 'tea') {
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const treeId = require('../../../assets/models/maple-tree.glb');
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const textureId = require('../../../assets/textures/maple-tree.rgba');
            const images = require('../../../assets/textures/maple-tree.json');
            const trees = await loadBundledGlb(treeId, { moduleId: textureId, images });
            if (!active) return;
            addMapleTrees(room.scene, trees.scene);
          } catch (cause) { failures.push(`maple trees: ${String(cause)}`); console.warn('[ADDA GL] Maple trees failed', cause); }
        }
        if (active && mounted.current) setAssetStatus(failures.length ? `Model warning: ${failures.join('; ')}` : `${roomKind === 'loft' ? 'Loft 16' : roomKind === 'roof' ? 'School Rooftop' : 'Road & shops'} · ${avatar.body} loaded`);
      };
      void loadModels();

      const clock = new THREE.Clock();
      let sampleTime = 0;
      let sampleFrames = 0;
      let jumpHeight = 0;
      let verticalVelocity = 0;
      const beginSeat = (onSide: boolean, coordinate: number, teaSeat?: TeaSeat) => {
        if (!clips.sitEnter || !clips.sitIdle || !clips.sitExit) {
          if (mounted.current) setAssetStatus('Sitting animation is unavailable');
          return;
        }
        if (teaSeat) {
          // Align the butt firmly on the center of the bench plank without clipping.
          // Bench plank surface is at y ~ 0.655 m; seatElevation 0.245 m places
          // the bottom of the avatar's thighs and buttocks squarely on top of the plank.
          // An offset of 0.08 m along the facing direction keeps the avatar seated
          // comfortably on the bench with legs hanging naturally off the edge.
          seatTarget.copy(teaSeat.target).add(new THREE.Vector3(
            -Math.sin(teaSeat.heading) * 0.08, 0,
            -Math.cos(teaSeat.heading) * 0.08));
          seatApproach.copy(teaSeat.approach);
          seatHeading = teaSeat.heading;
          seatElevation = 0.245;
          if (__DEV__) console.info('[ADDA tea seat v4]', 'heading', seatHeading.toFixed(3),
            'normal', teaSeat.normal.toArray().map(value => value.toFixed(2)),
            'root', seatTarget.toArray().map(value => value.toFixed(2)));
          modeRef.current = 'TPP';
          if (mounted.current) setViewMode('TPP');
        } else if (onSide) {
          seatElevation = 0;
          seatTarget.set(-2.59, 0, THREE.MathUtils.clamp(coordinate, -3.7, 1.1));
          seatApproach.set(seatTarget.x + 0.68, 0, seatTarget.z);
          seatHeading = -Math.PI / 2;
        } else {
          seatElevation = 0;
          seatTarget.set(THREE.MathUtils.clamp(coordinate, -2.2, 0.8), 0, -3.38);
          seatApproach.set(seatTarget.x, 0, seatTarget.z + 0.68);
          seatHeading = Math.PI;
        }
        seatPhase = 'approaching';
        seatTime = 0;
        velocity.set(0, 0, 0);
        crouchRef.current = false;
        if (mounted.current) { setCrouched(false); setSeatUi('approaching'); setNearSofa(false); }
        updateStick(0, 0);
      };
      const render = () => {
        if (!active || !renderer || !world) return;
        try {
          const delta = Math.min(clock.getDelta(), 0.05);
          const width = gl.drawingBufferWidth;
          const height = gl.drawingBufferHeight;
          if (width > 0 && height > 0 && (renderer.domElement.width !== width || renderer.domElement.height !== height)) {
            renderer.setSize(width, height, false);
            room.camera.aspect = width / height;
            room.camera.updateProjectionMatrix();
          }
          const input = seatPhase === 'free' ? movement.current : { x: 0, y: 0 };
          const stickLength = Math.min(1, Math.hypot(input.x, input.y));
          const movingInput = stickLength > 0.12;
          const running = movingInput && input.y <= -0.82 && Math.abs(input.x) <= 0.65 && !crouchRef.current;
          const maxSpeed = crouchRef.current ? 1.15 : running ? 4.0 : 2.2;
          const speed = movingInput ? maxSpeed * Math.min(1, (stickLength - 0.12) / 0.88) : 0;
          const sin = Math.sin(yaw.current);
          const cos = Math.cos(yaw.current);
          // Joystick intent is converted through the current camera yaw every frame.
          // This keeps movement coherent when another finger rotates the camera.
          moveDirection.set(input.x * cos - input.y * sin, 0, input.x * sin + input.y * cos);
          if (movingInput) moveDirection.normalize();
          const desiredX = moveDirection.x * speed;
          const desiredZ = moveDirection.z * speed;
          velocity.x = THREE.MathUtils.damp(velocity.x, desiredX, movingInput ? 12 : 18, delta);
          velocity.z = THREE.MathUtils.damp(velocity.z, desiredZ, movingInput ? 12 : 18, delta);

          const oldX = room.player.position.x;
          const oldZ = room.player.position.z;
          const canOccupy = (x: number, z: number) => {
            if (roomKind === 'tea') return canWalkTea(x, z, teaObstacles, teaSeats);
            if (roomKind === 'roof' && roofDoorBounds) {
              return !(x >= roofDoorBounds.min.x - 0.35 && x <= roofDoorBounds.max.x + 0.35
                && z >= roofDoorBounds.min.z - 0.35 && z <= roofDoorBounds.max.z + 0.35);
            }
            if (portalMeshes.length && x > loftDoor.x - 0.55 && Math.abs(z - loftDoor.z) < 0.72) return false;
            return true;
          };
          const xLimit = roomKind === 'loft' ? 4.45 : roomKind === 'roof' ? 11.5 : room.boundary - 0.4;
          const minZ = roomKind === 'loft' ? -4.42 : roomKind === 'roof' ? -8.8 : -room.boundary + 0.4;
          const maxZ = roomKind === 'loft' ? 4.4 : roomKind === 'roof' ? 8.55 : room.boundary - 0.4;
          const nextX = THREE.MathUtils.clamp(oldX + velocity.x * delta, -xLimit, xLimit);
          if (canOccupy(nextX, oldZ)) room.player.position.x = nextX;
          else velocity.x = 0;
          const nextZ = THREE.MathUtils.clamp(oldZ + velocity.z * delta, minZ, maxZ);
          if (canOccupy(room.player.position.x, nextZ)) room.player.position.z = nextZ;
          else velocity.z = 0;
          let actualSpeed = Math.hypot(room.player.position.x - oldX, room.player.position.z - oldZ) / Math.max(delta, 0.001);
          let walking = actualSpeed > 0.12;
          const door = roomKind === 'roof' ? roofDoor : loftDoor;
          const doorReady = (roomKind === 'roof' || roomKind === 'loft') && portalMeshes.length > 0;
          const isNearDoor = doorReady && Math.hypot(room.player.position.x - door.x, room.player.position.z - door.z) < 2.15;
          if (isNearDoor !== wasNearDoor) {
            wasNearDoor = isNearDoor;
            if (mounted.current) setNearDoor(isNearDoor);
          }
          const sideZ = THREE.MathUtils.clamp(room.player.position.z, -3.7, 1.1);
          const backX = THREE.MathUtils.clamp(room.player.position.x, -2.2, 0.8);
          const sideDistance = Math.hypot(room.player.position.x + 2.05, room.player.position.z - sideZ);
          const backDistance = Math.hypot(room.player.position.x - backX, room.player.position.z + 2.65);
          const closestTeaSeat = roomKind === 'tea' ? teaSeats.reduce<TeaSeat | null>((best, seat) =>
            !best || room.player.position.distanceToSquared(seat.approach) < room.player.position.distanceToSquared(best.approach) ? seat : best, null) : null;
          const nearTeaSeat = closestTeaSeat !== null && Math.hypot(room.player.position.x - closestTeaSeat.approach.x, room.player.position.z - closestTeaSeat.approach.z) < 1.7;
          const isNearSofa = seatPhase === 'free' && (roomKind === 'loft' && sofaMeshes.length > 0 && Math.min(sideDistance, backDistance) < 1.55 || roomKind === 'tea' && nearTeaSeat);
          if (isNearSofa !== wasNearSofa) {
            wasNearSofa = isNearSofa;
            if (mounted.current) setNearSofa(isNearSofa);
          }
          if (sitRequested.current) {
            sitRequested.current = false;
            if (isNearSofa && seatPhase === 'free') beginSeat(sideDistance < backDistance, sideDistance < backDistance ? sideZ : backX, roomKind === 'tea' ? closestTeaSeat ?? undefined : undefined);
          }

          if (movingInput) {
            // A model facing -Z rotates toward +X with a negative Three.js Y angle.
            const targetHeading = Math.atan2(-moveDirection.x, -moveDirection.z);
            const turn = THREE.MathUtils.euclideanModulo(targetHeading - room.avatarMount.rotation.y + Math.PI, Math.PI * 2) - Math.PI;
            room.avatarMount.rotation.y += THREE.MathUtils.clamp(turn, -10 * delta, 10 * delta);
          }
          if (seatPhase !== 'free') {
            velocity.set(0, 0, 0);
            jumpRequested.current = false;
            jumpHeight = 0;
            verticalVelocity = 0;
            if (seatPhase === 'approaching') {
              const dx = seatApproach.x - room.player.position.x;
              const dz = seatApproach.z - room.player.position.z;
              const distance = Math.hypot(dx, dz);
              const step = Math.min(distance, 2.4 * delta);
              if (distance > 0.001) {
                room.player.position.x += dx / distance * step;
                room.player.position.z += dz / distance * step;
                const targetHeading = Math.atan2(-dx, -dz);
                const turn = THREE.MathUtils.euclideanModulo(targetHeading - room.avatarMount.rotation.y + Math.PI, Math.PI * 2) - Math.PI;
                room.avatarMount.rotation.y += THREE.MathUtils.clamp(turn, -10 * delta, 10 * delta);
              }
              actualSpeed = step / Math.max(delta, 0.001);
              walking = step > 0.001;
              const targetYaw = -seatHeading;
              const yawTurn = THREE.MathUtils.euclideanModulo(targetYaw - yaw.current + Math.PI, Math.PI * 2) - Math.PI;
              yaw.current += THREE.MathUtils.clamp(yawTurn, -3 * delta, 3 * delta);
              pitch.current = THREE.MathUtils.damp(pitch.current, 0.04, 3, delta);
              if (distance < 0.12) {
                seatPhase = 'entering';
                seatTime = 0;
                if (mounted.current) setSeatUi('entering');
              }
            } else if (seatPhase === 'entering') {
              seatTime += delta;
              room.player.position.x = THREE.MathUtils.damp(room.player.position.x, seatTarget.x, 4, delta);
              room.player.position.z = THREE.MathUtils.damp(room.player.position.z, seatTarget.z, 4, delta);
              const turn = THREE.MathUtils.euclideanModulo(seatHeading - room.avatarMount.rotation.y + Math.PI, Math.PI * 2) - Math.PI;
              room.avatarMount.rotation.y += THREE.MathUtils.clamp(turn, -7 * delta, 7 * delta);
              const targetYaw = -seatHeading;
              const yawTurn = THREE.MathUtils.euclideanModulo(targetYaw - yaw.current + Math.PI, Math.PI * 2) - Math.PI;
              yaw.current += THREE.MathUtils.clamp(yawTurn, -6 * delta, 6 * delta);
              pitch.current = THREE.MathUtils.damp(pitch.current, 0.04, 6, delta);
              if (seatTime >= (clips.sitEnter?.getClip().duration ?? 1.3)) {
                seatPhase = 'seated';
                room.player.position.set(seatTarget.x, 0, seatTarget.z);
                room.avatarMount.rotation.y = seatHeading;
                if (mounted.current) setSeatUi('seated');
              }
            } else if (seatPhase === 'seated') {
              room.player.position.set(seatTarget.x, 0, seatTarget.z);
              if (standRequested.current) {
                standRequested.current = false;
                seatPhase = 'exiting';
                seatTime = 0;
                if (mounted.current) setSeatUi('exiting');
              }
            } else if (seatPhase === 'exiting') {
              seatTime += delta;
              const progress = Math.min(1, seatTime / (clips.sitExit?.getClip().duration ?? 1.03));
              room.player.position.x = THREE.MathUtils.lerp(seatTarget.x, seatApproach.x, progress);
              room.player.position.z = THREE.MathUtils.lerp(seatTarget.z, seatApproach.z, progress);
              if (progress >= 1) {
                seatPhase = 'free';
                if (mounted.current) setSeatUi('free');
              }
            }
          }
          if (jumpRequested.current && jumpHeight === 0) verticalVelocity = 4.3;
          jumpRequested.current = false;
          if (jumpHeight > 0 || verticalVelocity > 0) {
            verticalVelocity -= 10 * delta;
            jumpHeight = Math.max(0, jumpHeight + verticalVelocity * delta);
            if (jumpHeight === 0) verticalVelocity = 0;
          }
          currentSeatElevation = THREE.MathUtils.damp(currentSeatElevation,
            seatPhase === 'entering' || seatPhase === 'seated' ? seatElevation : 0, 6, delta);
          room.player.position.y = jumpHeight + currentSeatElevation;
          const targetScaleY = (!clips.crouchIdle && crouchRef.current) ? 0.65 : 1;
          room.avatarMount.scale.y = THREE.MathUtils.damp(room.avatarMount.scale.y, targetScaleY, 13, delta);

          let wanted: THREE.AnimationAction | undefined;
          if (seatPhase === 'entering') {
            wanted = clips.sitEnter;
          } else if (seatPhase === 'seated') {
            wanted = clips.sitIdle;
          } else if (seatPhase === 'exiting') {
            wanted = clips.sitExit;
          } else if (jumpHeight > 0.05) {
            wanted = clips.jump ?? clips.walk;
          } else if (crouchRef.current) {
            wanted = !walking ? (clips.crouchIdle ?? clips.idle) : (clips.crouchWalk ?? clips.walk);
          } else if (!walking) {
            wanted = clips.idle;
          } else if (running) {
            wanted = clips.sprint ?? clips.walk;
          } else {
            wanted = clips.walk;
          }

          if (wanted && wanted === clips.walk) {
            wanted.timeScale = THREE.MathUtils.clamp(actualSpeed / 2.2, 0.75, 1.25);
          } else if (wanted && wanted === clips.crouchWalk) {
            wanted.timeScale = THREE.MathUtils.clamp(actualSpeed / 1.15, 0.75, 1.2);
          } else if (wanted) {
            wanted.timeScale = 1.0;
          }

          if (wanted && wanted !== playing) {
            playing?.fadeOut(0.15);
            wanted.reset().fadeIn(0.15).play();
            playing = wanted;
          }
          mixer?.update(delta);
          heading.set(Math.sin(yaw.current) * Math.cos(pitch.current), Math.sin(pitch.current), -Math.cos(yaw.current) * Math.cos(pitch.current));
          const sittingCamera = seatPhase === 'entering' || seatPhase === 'seated' || seatPhase === 'exiting';
          if (modeRef.current === 'FPP') {
            room.camera.position.set(room.player.position.x, room.player.position.y + (sittingCamera ? 1.15 : crouchRef.current ? 1.05 : 1.63), room.player.position.z);
            room.camera.lookAt(focus.copy(room.camera.position).add(heading));
          } else {
            focus.set(room.player.position.x, room.player.position.y + (sittingCamera ? 0.95 : crouchRef.current ? 1.0 : 1.4), room.player.position.z);
            desired.set(focus.x - Math.sin(yaw.current) * 2.15, THREE.MathUtils.clamp(focus.y + 0.85 - Math.sin(pitch.current) * 1.2, 0.75, 3.2), focus.z + Math.cos(yaw.current) * 2.15);
            desired.x = THREE.MathUtils.clamp(desired.x, -room.boundary - 0.2, room.boundary + 0.2);
            desired.z = THREE.MathUtils.clamp(desired.z, -room.boundary - 0.2, room.boundary + 0.2);
            toCamera.copy(desired).sub(focus);
            const desiredDistance = toCamera.length();
            ray.set(focus, toCamera.normalize());
            ray.far = desiredDistance;
            const hit = ray.intersectObjects(room.wallMeshes, false)[0];
            if (hit) desired.copy(focus).addScaledVector(ray.ray.direction, Math.max(0.35, hit.distance - 0.22));
            room.camera.position.lerp(desired, Math.min(1, delta * 12));
            // FPP starts at the player's head. Jump to the chase position
            // once when switching, otherwise the close-camera fallback keeps
            // resetting the interpolation before it can reach TPP.
            if (!hit && room.camera.position.distanceTo(focus) < 1.05) room.camera.position.copy(desired);
            toCamera.copy(room.camera.position).sub(focus);
            const interpolatedDistance = toCamera.length();
            ray.set(focus, toCamera.normalize());
            ray.far = interpolatedDistance;
            const nearWall = ray.intersectObjects(room.wallMeshes, false)[0];
            if (nearWall) room.camera.position.copy(focus).addScaledVector(ray.ray.direction, Math.max(0.35, nearWall.distance - 0.22));
            const actualDistance = room.camera.position.distanceTo(focus);
            cameraTooClose = actualDistance < (cameraTooClose ? 1.4 : 1.0);
            if (cameraTooClose) {
              room.camera.position.set(room.player.position.x, room.player.position.y + (sittingCamera ? 1.15 : crouchRef.current ? 1.05 : 1.63), room.player.position.z);
              room.camera.lookAt(desired.copy(room.camera.position).add(heading));
            } else room.camera.lookAt(focus);
          }
          room.avatarMount.visible = modeRef.current === 'TPP' && !cameraTooClose;
          const tap = pendingWorldTap.current;
          pendingWorldTap.current = null;
          if (tap && (roomKind === 'loft' || roomKind === 'roof' || roomKind === 'tea')) {
            tapNdc.set(tap.x / windowSize.current.width * 2 - 1, 1 - tap.y / windowSize.current.height * 2);
            ray.setFromCamera(tapNdc, room.camera);
            if (isNearDoor && portalMeshes.length && ray.intersectObjects(portalMeshes, true).length) {
              onPortal();
            } else if (roomKind === 'loft' && seatPhase === 'free' && sofaMeshes.length) {
              const sofaHit = ray.intersectObjects(sofaMeshes, false)[0];
              if (__DEV__) console.log('[ADDA touch] Sofa hit', Boolean(sofaHit), sofaHit?.point.toArray().map(value => Number(value.toFixed(2))));
              if (sofaHit) {
                beginSeat(sofaHit.point.x < -2.35, sofaHit.point.x < -2.35 ? sofaHit.point.z : sofaHit.point.x);
              }
            } else if (roomKind === 'tea' && seatPhase === 'free' && teaSeats.length) {
              const hit = ray.intersectObjects(teaSeats.map(seat => seat.tapTarget), false)[0];
              const selected = teaSeats.find(seat => seat.tapTarget === hit?.object);
              if (selected && Math.hypot(room.player.position.x - selected.approach.x, room.player.position.z - selected.approach.z) < 2.4) beginSeat(false, 0, selected);
            }
          }
          renderer.render(room.scene, room.camera);
          gl.endFrameEXP();
          sampleFrames += 1;
          sampleTime += delta;
          if (__DEV__ && sampleTime >= 1) {
            if (mounted.current) setFps(Math.round(sampleFrames / sampleTime));
            sampleFrames = 0; sampleTime = 0;
          }
          frame = requestAnimationFrame(render);
        } catch (cause) {
          active = false;
          const message = cause instanceof Error ? cause.message : String(cause);
          console.error('[ADDA GL] Render failed', cause);
          if (mounted.current) { setError(message); setStatus('error'); }
        }
      };
      cleanup.current = () => {
        active = false;
        cancelAnimationFrame(frame);
        mixer?.stopAllAction();
        room.dispose();
        renderer?.dispose();
      };
      render();
      if (mounted.current && active) setStatus('ready');
      console.log('[ADDA GL] Native game context ready', roomKind, gl.drawingBufferWidth, gl.drawingBufferHeight);
    } catch (cause) {
      active = false;
      world?.dispose();
      renderer?.dispose();
      const message = cause instanceof Error ? cause.message : String(cause);
      console.error('[ADDA GL] Initialization failed', cause);
      if (mounted.current) { setError(message); setStatus('error'); }
    }
  }, [roomKind, avatar, onPortal, updateStick]);

  const toggleView = () => { modeRef.current = modeRef.current === 'FPP' ? 'TPP' : 'FPP'; setViewMode(modeRef.current); };

  return <View style={styles.container}>
    <GLView style={StyleSheet.absoluteFill} onContextCreate={onContextCreate} />
    {status === 'ready' && <GestureDetector gesture={gestures.look}><View style={styles.lookZone} /></GestureDetector>}
    <View pointerEvents="none" style={styles.badge}><View style={[styles.dot, status === 'error' && styles.errorDot]} /><Text style={styles.badgeText}>{status === 'ready' ? `NATIVE 3D READY${__DEV__ ? `  ·  ${fps} FPS` : ''}` : status === 'error' ? '3D ERROR' : 'INITIALIZING 3D…'}</Text></View>
    {status === 'ready' && <View pointerEvents="none" style={styles.modelBadge}><Text style={styles.modelText}>{assetStatus}</Text></View>}
    {status === 'error' && <View style={styles.errorCard}><Text style={styles.errorTitle}>Renderer could not start</Text><Text style={styles.errorText}>{error}</Text></View>}
    {status === 'ready' && <>
      <Pressable accessibilityRole="button" accessibilityLabel="Switch between first person and third person" onPress={toggleView} style={[styles.viewButton, { right: 28 + insets.right }]}><Text style={styles.viewText}>{viewMode}  ↔  {viewMode === 'FPP' ? 'TPP' : 'FPP'}</Text></Pressable>
      {seatUi === 'free' && <GestureDetector gesture={gestures.move}><View accessibilityLabel="Movement joystick. Drag farther forward to sprint." style={[styles.joystickArea, { left: 16 + insets.left, bottom: 8 + insets.bottom }]}>
        <Text style={[styles.sprintLabel, sprinting && styles.sprintActive]}>{sprinting ? 'AUTO SPRINT' : 'MOVE'}</Text>
        <View pointerEvents="none" style={[styles.stickBase, sprinting && styles.stickSprinting, { left: stickAnchor.x - STICK_SIZE / 2, top: stickAnchor.y - STICK_SIZE / 2 }]}>
          <View pointerEvents="none" style={styles.stickGuide} />
          <View pointerEvents="none" style={[styles.stickThumb, { transform: [{ translateX: stick.x * STICK_TRAVEL }, { translateY: stick.y * STICK_TRAVEL }] }]}><View style={styles.thumbCenter} /></View>
        </View>
      </View></GestureDetector>}
      {seatUi === 'free' ? <View style={[styles.actions, { right: 28 + insets.right, bottom: 20 + insets.bottom }]}>
        <GestureDetector gesture={gestures.jumpTap}><View accessible accessibilityRole="button" accessibilityLabel="Jump" style={styles.actionButton}><Text style={styles.actionIcon}>↑</Text><Text style={styles.actionLabel}>JUMP</Text></View></GestureDetector>
        <GestureDetector gesture={gestures.crouchTap}><View accessible accessibilityRole="button" accessibilityLabel={crouched ? 'Stand up' : 'Crouch'} accessibilityState={{ selected: crouched }} style={[styles.actionButton, crouched && styles.crouchedButton]}><Text style={styles.actionIcon}>{crouched ? '↥' : '↓'}</Text><Text style={styles.actionLabel}>{crouched ? 'STAND' : 'CROUCH'}</Text></View></GestureDetector>
      </View> : seatUi === 'seated' ? <Pressable accessibilityRole="button" accessibilityLabel="Stand up" onPress={standUp} style={[styles.standButton, { right: 28 + insets.right, bottom: 32 + insets.bottom }]}><Text style={styles.standText}>STAND UP</Text></Pressable> : <View pointerEvents="none" style={styles.seatMessage}><Text style={styles.seatMessageText}>{seatUi === 'approaching' ? roomKind === 'tea' ? 'Walking to bench…' : 'Walking to sofa…' : seatUi === 'entering' ? 'Sitting down…' : 'Standing up…'}</Text></View>}
      {nearDoor && seatUi === 'free' && (roomKind === 'loft' || roomKind === 'roof') && <Pressable accessibilityRole="button" accessibilityLabel={roomKind === 'roof' ? 'Back to Loft' : 'Go to Rooftop'} onPress={onPortal} style={styles.doorButton}><Text style={styles.doorButtonText}>{roomKind === 'roof' ? 'BACK TO LOFT' : 'GO TO ROOFTOP'}</Text></Pressable>}
      {nearSofa && seatUi === 'free' && <Pressable accessibilityRole="button" accessibilityLabel={roomKind === 'tea' ? 'Sit on chai bench' : 'Sit on the black sofa'} onPress={sitDown} style={styles.sitButton}><Text style={styles.doorButtonText}>{roomKind === 'tea' ? 'SIT ON BENCH' : 'SIT ON SOFA'}</Text></Pressable>}
      <View pointerEvents="none" style={styles.hint}><Text style={styles.hintText}>{roomKind === 'loft' ? 'Approach the sofa or rooftop door for an action' : roomKind === 'roof' ? 'Approach the door to return to Loft 16' : 'Walk to the chai benches or cross to the three shops'}</Text></View>
    </>}
  </View>;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  lookZone: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
  badge: { position: 'absolute', left: 18, top: 85, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#FFFFFFE8', borderRadius: 30, paddingHorizontal: 12, paddingVertical: 8 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.green }, errorDot: { backgroundColor: colors.error },
  badgeText: { color: colors.text, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  modelBadge: { position: 'absolute', left: 18, top: 119, maxWidth: '60%', backgroundColor: '#FFFFFFD9', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 5 },
  modelText: { color: colors.text, fontSize: 9, fontWeight: '700' },
  errorCard: { position: 'absolute', alignSelf: 'center', top: '35%', width: '80%', padding: 20, backgroundColor: colors.surface, borderColor: colors.error, borderWidth: 1, borderRadius: 18 },
  errorTitle: { color: colors.error, fontSize: 18, fontWeight: '800' }, errorText: { color: colors.text, fontSize: 13, marginTop: 8 },
  viewButton: { position: 'absolute', top: 85, right: 28, backgroundColor: '#FFFFFFE8', borderWidth: 1, borderColor: colors.primary, borderRadius: 13, paddingHorizontal: 16, paddingVertical: 11 },
  viewText: { color: colors.text, fontSize: 12, fontWeight: '900' },
  joystickArea: { position: 'absolute', width: 220, height: 190 },
  sprintLabel: { position: 'absolute', left: 26, top: 2, color: colors.primaryDark, fontSize: 10, fontWeight: '900', letterSpacing: 1.5 }, sprintActive: { color: colors.green },
  stickBase: { position: 'absolute', width: STICK_SIZE, height: STICK_SIZE, borderRadius: STICK_SIZE / 2, backgroundColor: '#FFFFFF85', borderWidth: 2, borderColor: '#15794BAA', alignItems: 'center', justifyContent: 'center' },
  stickSprinting: { borderColor: colors.green },
  stickGuide: { width: 72, height: 72, borderRadius: 36, borderWidth: 1, borderColor: '#15794B66', position: 'absolute' },
  stickThumb: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#FFFFFFE8', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: colors.primary },
  thumbCenter: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.primary },
  actions: { position: 'absolute', right: 28, bottom: 20, gap: 13, alignItems: 'center' },
  actionButton: { width: 68, height: 68, borderRadius: 34, backgroundColor: '#FFFFFFE8', borderWidth: 1.5, borderColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  crouchedButton: { borderColor: colors.green, backgroundColor: '#E5F4E9EE' },
  actionIcon: { color: colors.primaryDark, fontSize: 25, fontWeight: '800', lineHeight: 29 },
  actionLabel: { color: colors.primaryDark, fontSize: 8, fontWeight: '900', letterSpacing: 0.5 },
  standButton: { position: 'absolute', backgroundColor: '#FFFFFFF0', borderWidth: 1.5, borderColor: colors.primary, borderRadius: 18, paddingHorizontal: 18, paddingVertical: 16 },
  standText: { color: colors.text, fontWeight: '900', fontSize: 13 },
  doorButton: { position: 'absolute', bottom: 32, alignSelf: 'center', backgroundColor: '#FFFFFFF0', borderWidth: 1.5, borderColor: colors.primary, borderRadius: 16, paddingHorizontal: 20, paddingVertical: 13 },
  sitButton: { position: 'absolute', bottom: 32, alignSelf: 'center', backgroundColor: '#FFFFFFF0', borderWidth: 1.5, borderColor: colors.primary, borderRadius: 16, paddingHorizontal: 20, paddingVertical: 13 },
  doorButtonText: { color: colors.text, fontWeight: '900', fontSize: 12, letterSpacing: 0.8 },
  seatMessage: { position: 'absolute', bottom: 70, alignSelf: 'center', backgroundColor: '#FFFFFFE8', borderRadius: 12, paddingHorizontal: 18, paddingVertical: 10 },
  seatMessageText: { color: colors.text, fontWeight: '800', fontSize: 12 },
  hint: { position: 'absolute', bottom: 11, alignSelf: 'center', backgroundColor: '#FFFFFFC7', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8 },
  hintText: { color: colors.text, fontSize: 9 },
});
