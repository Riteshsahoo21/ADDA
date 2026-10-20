import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { GLView, ExpoWebGLRenderingContext } from 'expo-gl';
import { ActivityIndicator, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Accessibility, ArrowBigUp, Camera, Eye, PersonStanding, Radio as RadioIcon } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { colors } from '@/constants/theme';
import { createGameScene, RoomKind } from '@/three/environment/createGameScene';
import { createLoftDetails } from '@/three/environment/loftDetails';
import { addMapleTrees } from '@/three/environment/teaBoundary';
import { canWalkTea, createTeaSeats, getBenchSeatSpot, TeaObstacle, TeaSeat, teaObstacleFromBounds, teaStallObstacle } from '@/three/environment/teaInteractions';
import { BEACH_ASSETS } from '@/three/environment/beachAssets';
import { roomAssetUri } from '@/three/roomAssets';
import { canWalkBeach, createBeachEnvironment, getBeachSandElevation, BeachEnvironment } from '@/three/environment/beachEnvironment';
import { BeachSeat, createLoungerBeachSeat, getBeachSeatSpot } from '@/three/environment/beachInteractions';
import { loadBundledGlb } from '@/three/loaders/loadBundledGlb';
import { createNativeRenderer } from '@/three/renderer/createNativeRenderer';
import { avatarScale, loadAvatar } from '@/three/player/avatarAssets';
import { createLoungerSemiSleepClip } from '@/three/player/loungeAnimation';
import { RobloxInterpolator } from '@/three/player/RobloxInterpolator';
import { AvatarStyle, type AvatarBody } from '@/three/player/avatarStyle';
import type { PlayerSnapshot, RoomMotionSnapshot, RoomPeer, RoomPose } from '@/lib/rooms';
import { createVintageRadio } from '@/three/environment/vintageRadio';
import { MusicService } from '@/audio/MusicService';

const STICK_SIZE = 110;
const STICK_TRAVEL = 37;
const RESTING_STICK = { x: 74, y: 121 };
type Stick = { x: number; y: number };
type ViewMode = 'FPP' | 'TPP';
type SeatUi = 'free' | 'approaching' | 'entering' | 'seated' | 'exiting';

function fitModel(model: THREE.Group, desiredSize: number, axis: 'x' | 'y' | 'z') {
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

export function GameRoom({
  roomKind,
  avatar,
  onPortal,
  peers = [],
  peerSnapshotsRef,
  onPosition,
  onOpenRadio,
}: {
  roomKind: RoomKind;
  avatar: AvatarStyle;
  onPortal: () => void;
  peers?: RoomPeer[];
  peerSnapshotsRef: RefObject<Map<string, PlayerSnapshot[] | PlayerSnapshot>>;
  onPosition?: (snapshot: RoomMotionSnapshot) => void;
  onOpenRadio?: () => void;
}) {
  const [status, setStatus] = useState<'initializing' | 'ready' | 'error'>('initializing');
  const [assetStatus, setAssetStatus] = useState('');
  const [error, setError] = useState('');
  const [stick, setStick] = useState<Stick>({ x: 0, y: 0 });
  const [stickAnchor, setStickAnchor] = useState(RESTING_STICK);
  const [sprinting, setSprinting] = useState(false);
  const [crouched, setCrouched] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('FPP');
  const [seatUi, setSeatUi] = useState<SeatUi>('free');
  const [nearSofa, setNearSofa] = useState(false);
  const [nearSeatType, setNearSeatType] = useState<'bench' | 'lounger' | 'sofa'>('sofa');
  const [activeSeatType, setActiveSeatType] = useState<'bench' | 'lounger' | 'sofa'>('bench');
  const [nearDoor, setNearDoor] = useState(false);
  const [nearRadio, setNearRadio] = useState(false);
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
  const peersRef = useRef(peers);
  const positionRef = useRef(onPosition);
  const openRadioRef = useRef(onOpenRadio);
  const lookTranslation = useRef({ x: 0, y: 0 });
  const insets = useSafeAreaInsets();

  useEffect(() => { windowSize.current = { width: windowWidth, height: windowHeight }; }, [windowWidth, windowHeight]);
  useEffect(() => { peersRef.current = peers; }, [peers]);
  useEffect(() => { positionRef.current = onPosition; }, [onPosition]);
  useEffect(() => { openRadioRef.current = onOpenRadio; }, [onOpenRadio]);

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
      loungerIdle?: THREE.AnimationAction;
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
    const beachSeats: BeachSeat[] = [];
    const loftDoor = new THREE.Vector3();
    const roofDoor = new THREE.Vector3();
    let roofDoorBounds: THREE.Box3 | null = null;
    const seatTarget = new THREE.Vector3();
    const seatApproach = new THREE.Vector3();
    let seatHeading = -Math.PI / 2;
    let seatElevation = 0;
    let currentSeatElevation = 0;
    let currentGroundElevation = roomKind === 'beach' ? getBeachSandElevation(8) : 0;
    let seatPhase: SeatUi = 'free';
    let seatTime = 0;
    let currentSeatType: 'bench' | 'lounger' = 'bench';
    let wasNearSofa = false;
    let wasNearDoor = false;
    let cameraTooClose = false;
    try {
      renderer = createNativeRenderer(gl);
      world = createGameScene(gl.drawingBufferWidth / gl.drawingBufferHeight, roomKind);
      const room = world;
      let radioPos = new THREE.Vector3(0.0, 0.40, 0.62);
      let radioRot = 0;
      if (roomKind === 'tea') {
        radioPos = new THREE.Vector3(-7.95, 1.21, -1.15);
        radioRot = Math.PI / 2;
      } else if (roomKind === 'beach') {
        radioPos = new THREE.Vector3(-6.6, 1.05, 12.2);
        radioRot = Math.PI / 2;
      } else if (roomKind === 'roof') {
        radioPos = new THREE.Vector3(-3.58, 0.48, -4.02);
        radioRot = Math.PI / 4;
      }
      const radio3D = createVintageRadio(room.scene, radioPos, radioRot);
      let wasNearRadio = false;

      let beachEnv: BeachEnvironment | null = null;
      if (roomKind === 'beach') {
        beachEnv = createBeachEnvironment(room.scene);
        beachSeats.push(...beachEnv.beachSeats);
      }
      const fallback = fallbackAvatar();
      room.avatarMount.add(fallback);
      type RemoteAvatar = {
        mount: THREE.Group;
        body: AvatarBody;
        mixer?: THREE.AnimationMixer;
        actions: Partial<Record<RoomPose, THREE.AnimationAction>>;
        playing?: THREE.AnimationAction;
        initialized: boolean;
        interpolator: RobloxInterpolator;
      };
      const remoteAvatars = new Map<string, RemoteAvatar>();
      const remoteModelCache = new Map<AvatarBody, ReturnType<typeof loadAvatar>>();
      const loadRemoteAvatar = (userId: string, entry: RemoteAvatar) => {
        let pending = remoteModelCache.get(entry.body);
        if (!pending) { pending = loadAvatar({ body: entry.body }); remoteModelCache.set(entry.body, pending); }
        void pending.then(gltf => {
          if (!active || remoteAvatars.get(userId) !== entry) return;
          const model = cloneSkeleton(gltf.scene) as THREE.Group;
          model.scale.setScalar(avatarScale());
          model.rotation.y = Math.PI;
          entry.mount.clear();
          entry.mount.add(model);
          entry.mixer = new THREE.AnimationMixer(model);
          for (const clip of gltf.animations) {
            const name = clip.name.toLowerCase();
            const pose: RoomPose | undefined = name === 'idle' || name === 'idle_loop' ? 'idle'
              : name === 'walk' || name === 'walk_loop' ? 'walk'
              : name === 'sprint' || name === 'run' || name === 'sprint_loop' ? 'run'
              : name === 'jump' || name === 'jump_loop' ? 'jump'
              : name === 'crouch_idle' || name === 'crouchidle' || name === 'crouch_idle_loop' ? 'crouch_idle'
              : name === 'crouch_walk' || name === 'crouchwalk' || name === 'crouch_fwd_loop' ? 'crouch_walk'
              : name === 'sit_enter' || name === 'sit_idle' || name === 'sit_exit' ? name : undefined;
            if (!pose) continue;
            const action = entry.mixer.clipAction(clip);
            if (pose === 'sit_enter' || pose === 'sit_exit') {
              action.setLoop(THREE.LoopOnce, 1);
              action.clampWhenFinished = true;
            }
            entry.actions[pose] = action;
            if (name === 'sit_idle') {
              try {
                const loungerClip = createLoungerSemiSleepClip(clip);
                entry.actions.lounger_idle = entry.mixer.clipAction(loungerClip);
              } catch (err) {
                console.warn('[ADDA] Remote lounger clip synthesis failed', err);
              }
            }
          }
          entry.playing = entry.actions.idle ?? entry.actions.walk;
          entry.playing?.play();
        }).catch(error => console.warn('[ADDA GL] Remote avatar failed', error));
      };
      let lastPositionSent = 0;
      let lastSentPosition: RoomMotionSnapshot = { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY, z: Number.POSITIVE_INFINITY, yaw: Number.POSITIVE_INFINITY, vx: 0, vz: 0, pose: 'idle' };

      const beachHolders: { holder: THREE.Group; x: number; z: number }[] = [];

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
            else if (name === 'sit_idle') {
              clips.sitIdle = action;
              try {
                const loungerClip = createLoungerSemiSleepClip(clip);
                clips.loungerIdle = mixer.clipAction(loungerClip);
              } catch (err) {
                console.warn('[ADDA] Lounger clip synthesis failed', err);
              }
            }
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
        if (roomKind === 'beach') {
          for (const item of BEACH_ASSETS) {
            try {
              const gltf = await loadBundledGlb(roomAssetUri('beach', item.model), { moduleId: roomAssetUri('beach', item.texture), images: item.images });
              if (!active) return;
              const holder = new THREE.Group();
              holder.name = `Imported ${item.name}`;
              holder.add(fitModel(gltf.scene, item.size, item.axis));
              const elevation = item.customY ?? getBeachSandElevation(item.z);
              holder.position.set(item.x, elevation, item.z);
              holder.rotation.y = item.rotationY;
              holder.traverse((child) => {
                if ((child as THREE.Mesh).isMesh) {
                  const mesh = child as THREE.Mesh;
                  mesh.frustumCulled = true;
                  mesh.geometry.computeBoundingSphere?.();
                  const mat = mesh.material as THREE.MeshStandardMaterial;
                  if (mat && mat.isMeshStandardMaterial) {
                    mat.roughness = 0.78;
                    mat.metalness = 0.08;
                    if (mat.normalMap) {
                      mat.normalScale.set(0.6, 0.6);
                    }
                  }
                }
              });
              room.scene.add(holder);
              beachHolders.push({ holder, x: item.x, z: item.z });
              if (item.name === 'Beach Sun Lounger') {
                beachSeats.push(createLoungerBeachSeat(holder, item.x, item.z, item.rotationY, 'lounger-main', 'Beach Sun Lounger 1'));
              }

              if (item.clones) {
                let cloneIdx = 0;
                for (const clone of item.clones) {
                  const cloneHolder = new THREE.Group();
                  cloneHolder.name = `Imported ${item.name} Clone`;
                  cloneHolder.add(gltf.scene.clone(true));
                  const cloneElevation = clone.customY ?? getBeachSandElevation(clone.z);
                  cloneHolder.position.set(clone.x, cloneElevation, clone.z);
                  cloneHolder.rotation.y = clone.rotationY;
                  cloneHolder.traverse((child) => {
                    if ((child as THREE.Mesh).isMesh) {
                      const mesh = child as THREE.Mesh;
                      mesh.frustumCulled = true;
                      mesh.geometry.computeBoundingSphere?.();
                      const mat = mesh.material as THREE.MeshStandardMaterial;
                      if (mat && mat.isMeshStandardMaterial) {
                        mat.roughness = 0.78;
                        mat.metalness = 0.08;
                        if (mat.normalMap) {
                          mat.normalScale.set(0.6, 0.6);
                        }
                      }
                    }
                  });
                  room.scene.add(cloneHolder);
                  beachHolders.push({ holder: cloneHolder, x: clone.x, z: clone.z });
                  if (item.name === 'Beach Sun Lounger') {
                    beachSeats.push(createLoungerBeachSeat(cloneHolder, clone.x, clone.z, clone.rotationY, `lounger-clone-${cloneIdx + 1}`, `Beach Sun Lounger ${cloneIdx + 2}`));
                  }
                  cloneIdx++;
                }
              }
            } catch (cause) {
              failures.push(`${item.name}: ${String(cause)}`);
              console.warn(`[ADDA GL] ${item.name} failed`, cause);
            }
          }
        }
        const roomAssets = roomKind === 'beach' ? [] : roomKind === 'loft' ? [
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          { id: roomAssetUri('loft', 'models/loft16.glb'), texture: roomAssetUri('loft', 'textures/loft16.rgba'), images: require('../../../assets/textures/loft16.json'), name: 'Loft 16', size: 10.6, axis: 'x' as const, x: 0, z: 0, rotation: 0, rawScale: false },
        ] : roomKind === 'roof' ? [
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          { id: roomAssetUri('roof', 'models/school-rooftop.glb'), texture: roomAssetUri('roof', 'textures/school-rooftop.rgba'), images: require('../../../assets/textures/school-rooftop.json'), name: 'School Rooftop', size: 1, axis: 'x' as const, x: 0, z: 0, rotation: 0, rawScale: true },
        ] : [
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          { id: roomAssetUri('tea', 'models/tea-ground.glb'), texture: roomAssetUri('tea', 'textures/tea-ground.rgba'), images: require('../../../assets/textures/tea-ground.json'), name: 'road and ground', size: 26, axis: 'x' as const, x: 0, z: 0, rotation: 0, rawScale: true },
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          { id: roomAssetUri('tea', 'models/chai-stall.glb'), texture: roomAssetUri('tea', 'textures/chai-stall.rgba'), images: require('../../../assets/textures/chai-stall.json'), name: 'chai stall and bench', size: 3.2, axis: 'y' as const, x: -7.2, z: -2.2, rotation: Math.PI / 2, rawScale: false },
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          { id: roomAssetUri('tea', 'models/three-shops.glb'), texture: roomAssetUri('tea', 'textures/three-shops.rgba'), images: require('../../../assets/textures/three-shops.json'), name: 'three shops', size: 2.8, axis: 'y' as const, x: 7.7, z: -2.2, rotation: -Math.PI / 2, rawScale: false },
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          { id: roomAssetUri('tea', 'models/barber-shop.glb'), texture: roomAssetUri('tea', 'textures/barber-shop.rgba'), images: require('../../../assets/textures/barber-shop.json'), name: 'desi barber shop', size: 2.8, axis: 'y' as const, x: 7.7, z: 6.8, rotation: -Math.PI / 2, rawScale: false },
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          { id: roomAssetUri('tea', 'models/dance-stage.glb'), texture: roomAssetUri('tea', 'textures/dance-stage.rgba'), images: require('../../../assets/textures/dance-stage.json'), name: 'dance stage', size: 2.5, axis: 'y' as const, x: -7.5, z: 5.2, rotation: Math.PI / 2, rawScale: false },
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
            if (roomKind === 'tea' && item.name === 'desi barber shop') {
              holder.updateMatrixWorld(true);
              const barberBounds = new THREE.Box3().setFromObject(holder);
              teaObstacles.push({
                minX: barberBounds.max.x - 0.9,
                maxX: barberBounds.max.x + 0.3,
                minZ: barberBounds.min.z - 0.1,
                maxZ: barberBounds.max.z + 0.1,
              });
              teaObstacles.push({
                minX: barberBounds.min.x - 0.1,
                maxX: barberBounds.max.x + 0.1,
                minZ: barberBounds.min.z - 0.25,
                maxZ: barberBounds.min.z + 0.45,
              });
              teaObstacles.push({
                minX: barberBounds.min.x - 0.1,
                maxX: barberBounds.max.x + 0.1,
                minZ: barberBounds.max.z - 0.45,
                maxZ: barberBounds.max.z + 0.25,
              });
            }
            if (roomKind === 'tea' && item.name === 'dance stage') {
              holder.updateMatrixWorld(true);
              const stageBounds = new THREE.Box3().setFromObject(holder);
              teaObstacles.push({
                minX: stageBounds.min.x - 0.35,
                maxX: stageBounds.min.x + 0.45,
                minZ: stageBounds.min.z - 0.2,
                maxZ: stageBounds.max.z + 0.2,
              });
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
            const treeId = roomAssetUri('tea', 'models/maple-tree.glb');
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const textureId = roomAssetUri('tea', 'textures/maple-tree.rgba');
            const images = require('../../../assets/textures/maple-tree.json');
            const trees = await loadBundledGlb(treeId, { moduleId: textureId, images });
            if (!active) return;
            addMapleTrees(room.scene, trees.scene);
          } catch (cause) { failures.push(`maple trees: ${String(cause)}`); console.warn('[ADDA GL] Maple trees failed', cause); }
        }
        if (active && mounted.current) setAssetStatus(failures.length ? `Model warning: ${failures.join('; ')}` : '');
      };
      void loadModels();

      const clock = new THREE.Clock();
      let jumpHeight = 0;
      let verticalVelocity = 0;
      const beginSeat = (
        onSide: boolean,
        coordinate: number,
        teaSeat?: TeaSeat,
        hitPoint?: THREE.Vector3,
        beachSeat?: BeachSeat
      ) => {
        if (!clips.sitEnter || !clips.sitIdle || !clips.sitExit) {
          if (mounted.current) setAssetStatus('Sitting animation is unavailable');
          return;
        }
        if (beachSeat) {
          currentSeatType = beachSeat.seatType ?? 'bench';
          if (mounted.current) setActiveSeatType(currentSeatType);
          const occupied = Array.from(remoteAvatars.values()).map(e => e.mount.position);
          const spot = getBeachSeatSpot(beachSeat, hitPoint, occupied);
          seatTarget.copy(spot.target);
          if (beachSeat.seatType === 'bench') {
            seatTarget.add(new THREE.Vector3(
              -Math.sin(beachSeat.heading) * 0.08, 0,
              -Math.cos(beachSeat.heading) * 0.08));
          }
          seatApproach.copy(spot.approach);
          seatHeading = beachSeat.heading;
          seatElevation = beachSeat.seatElevation;
          if (__DEV__) console.info('[ADDA beach seat multi-slot]', beachSeat.name, 'heading', seatHeading.toFixed(3),
            'target', seatTarget.toArray().map(value => value.toFixed(2)),
            'approach', seatApproach.toArray().map(value => value.toFixed(2)));
          modeRef.current = 'TPP';
          if (mounted.current) setViewMode('TPP');
        } else if (teaSeat) {
          currentSeatType = 'bench';
          if (mounted.current) setActiveSeatType('bench');
          // Compute slot on bench plank taking into account tap location and other avatars
          const occupied = Array.from(remoteAvatars.values()).map(e => e.mount.position);
          const spot = getBenchSeatSpot(teaSeat, hitPoint, occupied);
          seatTarget.copy(spot.target).add(new THREE.Vector3(
            -Math.sin(teaSeat.heading) * 0.08, 0,
            -Math.cos(teaSeat.heading) * 0.08));
          seatApproach.copy(spot.approach);
          seatHeading = teaSeat.heading;
          seatElevation = 0.245;
          if (__DEV__) console.info('[ADDA tea seat multi-slot]', 'heading', seatHeading.toFixed(3),
            'target', seatTarget.toArray().map(value => value.toFixed(2)),
            'approach', seatApproach.toArray().map(value => value.toFixed(2)));
          modeRef.current = 'TPP';
          if (mounted.current) setViewMode('TPP');
        } else if (onSide) {
          currentSeatType = 'bench';
          if (mounted.current) setActiveSeatType('sofa');
          seatElevation = 0;
          seatTarget.set(-2.59, 0, THREE.MathUtils.clamp(coordinate, -3.7, 1.1));
          seatApproach.set(seatTarget.x + 0.68, 0, seatTarget.z);
          seatHeading = -Math.PI / 2;
        } else {
          currentSeatType = 'bench';
          if (mounted.current) setActiveSeatType('sofa');
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
          const now = Date.now();
          const present = new Set(peersRef.current.map(peer => peer.userId));
          for (const [id, entry] of remoteAvatars) if (!present.has(id)) { room.scene.remove(entry.mount); remoteAvatars.delete(id); }
          for (const peer of peersRef.current) {
            let entry = remoteAvatars.get(peer.userId);
            if (entry?.body !== peer.avatar) {
              if (entry) room.scene.remove(entry.mount);
              const mount = new THREE.Group();
              mount.add(fallbackAvatar());
              const interpolator = new RobloxInterpolator(80);
              entry = {
                mount,
                body: peer.avatar,
                actions: {},
                initialized: false,
                interpolator,
              };
              room.scene.add(mount);
              remoteAvatars.set(peer.userId, entry);
              loadRemoteAvatar(peer.userId, entry);
            }

            // Drain incoming snapshots from the peer queue
            const raw = peerSnapshotsRef.current?.get(peer.userId);
            if (Array.isArray(raw)) {
              while (raw.length > 0) {
                const snap = raw.shift()!;
                entry.interpolator.push(snap.x, snap.y, snap.z, snap.r, snap.pose, snap.time);
              }
            } else if (raw) {
              const snap = raw as PlayerSnapshot;
              entry.interpolator.push(snap.x, snap.y, snap.z, snap.r, snap.pose, snap.time);
            }

            // Fallback initialization if no packet has arrived yet
            if (entry.interpolator.isEmpty()) {
              entry.interpolator.push(peer.x, peer.y ?? 0, peer.z, peer.yaw, peer.pose ?? 'idle', now);
            }

            const sample = entry.interpolator.sample(delta);
            if (sample) {
              // Direct assignment from RobloxInterpolator - continuous 60 FPS with no rubber-band lag
              entry.mount.position.set(sample.x, sample.y, sample.z);
              entry.mount.rotation.y = sample.r;
              entry.initialized = true;

              const wanted = entry.actions[sample.pose] ?? (sample.pose === 'crouch_idle' ? entry.actions.idle
                : sample.pose === 'crouch_walk' || sample.pose === 'run' ? entry.actions.walk
                : sample.pose === 'jump' ? entry.actions.walk
                : sample.pose === 'lounger_idle' ? (entry.actions.lounger_idle ?? entry.actions.sit_idle)
                : undefined) ?? entry.actions.idle ?? entry.actions.walk;

              if (wanted && wanted !== entry.playing) {
                entry.playing?.fadeOut(0.18);
                wanted.reset().fadeIn(0.18).play();
                entry.playing = wanted;
              }

              if (entry.mixer) {
                entry.mixer.timeScale = 1.0;
                entry.mixer.update(delta);
              }
            }
          }
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
            if (roomKind === 'beach' && beachEnv) return canWalkBeach(x, z, beachEnv.obstacles);
            if (roomKind === 'tea') return canWalkTea(x, z, teaObstacles, teaSeats);
            if (roomKind === 'roof' && roofDoorBounds) {
              return !(x >= roofDoorBounds.min.x - 0.35 && x <= roofDoorBounds.max.x + 0.35
                && z >= roofDoorBounds.min.z - 0.35 && z <= roofDoorBounds.max.z + 0.35);
            }
            if (portalMeshes.length && x > loftDoor.x - 0.55 && Math.abs(z - loftDoor.z) < 0.72) return false;
            return true;
          };
          const xLimit = roomKind === 'beach' ? 31 : roomKind === 'loft' ? 4.45 : roomKind === 'roof' ? 11.5 : room.boundary - 0.4;
          const minZ = roomKind === 'beach' ? -17.3 : roomKind === 'loft' ? -4.42 : roomKind === 'roof' ? -8.8 : -room.boundary + 0.4;
          const maxZ = roomKind === 'beach' ? 42 : roomKind === 'loft' ? 4.4 : roomKind === 'roof' ? 8.55 : room.boundary - 0.4;
          const nextX = THREE.MathUtils.clamp(oldX + velocity.x * delta, -xLimit, xLimit);
          if (canOccupy(nextX, oldZ)) room.player.position.x = nextX;
          else velocity.x = 0;
          const nextZ = THREE.MathUtils.clamp(oldZ + velocity.z * delta, minZ, maxZ);
          if (canOccupy(room.player.position.x, nextZ)) room.player.position.z = nextZ;
          else velocity.z = 0;
          if (roomKind === 'beach') {
            const onPier = Math.abs(room.player.position.x) <= 1.75 && room.player.position.z <= 2.85 && room.player.position.z >= -17.3;
            const sandY = getBeachSandElevation(room.player.position.z);
            const targetY = onPier ? 0.42 : Math.max(sandY, -0.2);
            currentGroundElevation = THREE.MathUtils.damp(currentGroundElevation, targetY, 14, delta);

            // GPU Optimization: Distance culling beyond 36m (sunset fog horizon)
            if (beachHolders.length > 0) {
              const px = room.player.position.x;
              const pz = room.player.position.z;
              const MAX_BEACH_DRAW_DIST_SQ = 36 * 36;
              for (let bi = 0; bi < beachHolders.length; bi++) {
                const bh = beachHolders[bi];
                const bdx = bh.x - px;
                const bdz = bh.z - pz;
                const isVisible = bdx * bdx + bdz * bdz <= MAX_BEACH_DRAW_DIST_SQ;
                if (bh.holder.visible !== isVisible) {
                  bh.holder.visible = isVisible;
                }
              }
            }
          } else if (roomKind === 'tea') {
            const onStage = room.player.position.x >= -9.3 && room.player.position.x <= -5.8 && room.player.position.z >= 3.4 && room.player.position.z <= 7.0;
            const targetY = onStage ? 0.61 : 0;
            currentGroundElevation = THREE.MathUtils.damp(currentGroundElevation, targetY, 14, delta);
          }
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
          const closestBeachSeat = roomKind === 'beach' ? beachSeats.reduce<BeachSeat | null>((best, seat) =>
            !best || room.player.position.distanceToSquared(seat.approach) < room.player.position.distanceToSquared(best.approach) ? seat : best, null) : null;
          const nearBeachSeat = closestBeachSeat !== null && Math.hypot(room.player.position.x - closestBeachSeat.approach.x, room.player.position.z - closestBeachSeat.approach.z) < 2.0;
          const isNearSofa = seatPhase === 'free' && (
            (roomKind === 'loft' && sofaMeshes.length > 0 && Math.min(sideDistance, backDistance) < 1.55) ||
            (roomKind === 'tea' && nearTeaSeat) ||
            (roomKind === 'beach' && nearBeachSeat)
          );
          if (isNearSofa !== wasNearSofa) {
            wasNearSofa = isNearSofa;
            if (mounted.current) {
              setNearSofa(isNearSofa);
              if (isNearSofa) {
                const detected: 'bench' | 'lounger' | 'sofa' =
                  roomKind === 'beach' ? (closestBeachSeat?.seatType ?? 'bench')
                  : roomKind === 'tea' ? 'bench'
                  : 'sofa';
                setNearSeatType(detected);
              }
            }
          }
          if (sitRequested.current) {
            sitRequested.current = false;
            if (isNearSofa && seatPhase === 'free') {
              beginSeat(
                sideDistance < backDistance,
                sideDistance < backDistance ? sideZ : backX,
                roomKind === 'tea' ? closestTeaSeat ?? undefined : undefined,
                roomKind === 'tea' || roomKind === 'beach' ? room.player.position : undefined,
                roomKind === 'beach' ? closestBeachSeat ?? undefined : undefined
              );
            }
          }

          // Spatial audio distance attenuation & proximity check
          const radioDist = room.player.position.distanceTo(radioPos);
          const MAX_HEAR_DIST = 42.0;
          let spatialAtten = 0;
          if (radioDist <= 2.5) {
            spatialAtten = 1.0;
          } else if (radioDist < MAX_HEAR_DIST) {
            const t = (radioDist - 2.5) / (MAX_HEAR_DIST - 2.5);
            spatialAtten = Math.max(0.15, Math.pow(1.0 - t, 1.4));
          } else {
            spatialAtten = 0;
          }
          MusicService.updateSpatialAttenuation(spatialAtten);

          const isNearRadio = radioDist < 2.8;
          if (isNearRadio !== wasNearRadio) {
            wasNearRadio = isNearRadio;
            if (mounted.current) setNearRadio(isNearRadio);
          }

          const isRadioEmitting = MusicService.state.radioEnabled && !MusicService.state.radioMuted && spatialAtten > 0.05;
          radio3D.setPowered(MusicService.state.radioEnabled);
          radio3D.update(delta, isRadioEmitting);

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
          room.player.position.y = currentGroundElevation + jumpHeight + currentSeatElevation;
          const targetScaleY = (!clips.crouchIdle && crouchRef.current) ? 0.65 : 1;
          room.avatarMount.scale.y = THREE.MathUtils.damp(room.avatarMount.scale.y, targetScaleY, 13, delta);

          let wanted: THREE.AnimationAction | undefined;
          if (seatPhase === 'entering') {
            wanted = clips.sitEnter;
          } else if (seatPhase === 'seated') {
            wanted = (currentSeatType === 'lounger' && clips.loungerIdle) ? clips.loungerIdle : clips.sitIdle;
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
          const pose: RoomPose = seatPhase === 'entering' ? 'sit_enter'
            : seatPhase === 'seated' ? (currentSeatType === 'lounger' ? 'lounger_idle' : 'sit_idle')
            : seatPhase === 'exiting' ? 'sit_exit'
            : jumpHeight > 0.05 ? 'jump'
            : crouchRef.current ? (walking ? 'crouch_walk' : 'crouch_idle')
            : walking ? (running ? 'run' : 'walk') : 'idle';
          const normalizedLocalYaw = Math.atan2(Math.sin(room.avatarMount.rotation.y), Math.cos(room.avatarMount.rotation.y));
          const snapshot: RoomMotionSnapshot = {
            x: room.player.position.x, y: room.player.position.y, z: room.player.position.z,
            yaw: normalizedLocalYaw,
            vx: THREE.MathUtils.clamp(velocity.x, -5, 5),
            vz: THREE.MathUtils.clamp(velocity.z, -5, 5),
            pose,
          };
          const moving = Math.hypot(velocity.x, velocity.z) > 0.05 || movingInput;
          const poseChanged = snapshot.pose !== lastSentPosition.pose;
          const moved = Math.hypot(snapshot.x - lastSentPosition.x, snapshot.z - lastSentPosition.z) > 0.015 ||
            Math.abs(THREE.MathUtils.euclideanModulo(snapshot.yaw - lastSentPosition.yaw + Math.PI, Math.PI * 2) - Math.PI) > 0.02;
          const sendDue = lastPositionSent === 0 || poseChanged || (now - lastPositionSent >= 50 && (moving || moved)) || (now - lastPositionSent >= 1000);
          if (sendDue) {
            lastPositionSent = now;
            lastSentPosition = snapshot;
            positionRef.current?.(snapshot);
          }
          heading.set(Math.sin(yaw.current) * Math.cos(pitch.current), Math.sin(pitch.current), -Math.cos(yaw.current) * Math.cos(pitch.current));
          const sittingCamera = seatPhase === 'entering' || seatPhase === 'seated' || seatPhase === 'exiting';
          if (modeRef.current === 'FPP') {
            room.camera.position.set(room.player.position.x, room.player.position.y + (sittingCamera ? (currentSeatType === 'lounger' ? 0.75 : 1.15) : crouchRef.current ? 1.05 : 1.63), room.player.position.z);
            room.camera.lookAt(focus.copy(room.camera.position).add(heading));
          } else {
            focus.set(room.player.position.x, room.player.position.y + (sittingCamera ? (currentSeatType === 'lounger' ? 0.55 : 0.95) : crouchRef.current ? 1.0 : 1.4), room.player.position.z);
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
          if (tap) {
            tapNdc.set(tap.x / windowSize.current.width * 2 - 1, 1 - tap.y / windowSize.current.height * 2);
            ray.setFromCamera(tapNdc, room.camera);
            const radioHits = ray.intersectObjects(radio3D.group.children, true);
            if (radioHits.length > 0 && isNearRadio) {
              openRadioRef.current?.();
            } else if (isNearDoor && portalMeshes.length && ray.intersectObjects(portalMeshes, true).length) {
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
              if (selected && Math.hypot(room.player.position.x - selected.approach.x, room.player.position.z - selected.approach.z) < 2.4) {
                beginSeat(false, 0, selected, hit.point);
              }
            } else if (roomKind === 'beach' && seatPhase === 'free' && beachSeats.length) {
              const hit = ray.intersectObjects(beachSeats.map(seat => seat.tapTarget), false)[0];
              const selected = beachSeats.find(seat => seat.tapTarget === hit?.object);
              if (selected && Math.hypot(room.player.position.x - selected.approach.x, room.player.position.z - selected.approach.z) < 3.2) {
                beginSeat(false, 0, undefined, hit.point, selected);
              }
            }
          }
          beachEnv?.update(delta);
          renderer.render(room.scene, room.camera);
          gl.endFrameEXP();
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
        radio3D?.dispose();
        beachEnv?.dispose();
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
  }, [roomKind, avatar, onPortal, updateStick, peerSnapshotsRef]);

  const toggleView = () => { modeRef.current = modeRef.current === 'FPP' ? 'TPP' : 'FPP'; setViewMode(modeRef.current); };

  return <View style={styles.container}>
    <GLView style={StyleSheet.absoluteFill} onContextCreate={onContextCreate} />
    {status === 'ready' && <GestureDetector gesture={gestures.look}><View style={styles.lookZone} /></GestureDetector>}
    {status === 'initializing' && <View pointerEvents="none" style={styles.loading}><ActivityIndicator color="#FFFFFF" /></View>}
    {status === 'ready' && !!assetStatus && <View pointerEvents="none" style={styles.modelBadge}><Text style={styles.modelText}>{assetStatus}</Text></View>}
    {status === 'error' && <View style={styles.errorCard}><Text style={styles.errorTitle}>Renderer could not start</Text><Text style={styles.errorText}>{error}</Text></View>}
    {status === 'ready' && <>
      <Pressable accessibilityRole="button" accessibilityLabel={`Switch to ${viewMode === 'FPP' ? 'third' : 'first'} person camera`} onPress={toggleView} style={[styles.viewButton, { right: 28 + insets.right }]}>{viewMode === 'FPP' ? <Camera size={19} color="#F7FAF8" /> : <Eye size={19} color="#F7FAF8" />}<Text style={styles.viewText}>{viewMode === 'FPP' ? '3RD PERSON' : '1ST PERSON'}</Text></Pressable>
      {seatUi === 'free' && <GestureDetector gesture={gestures.move}><View accessibilityLabel="Movement joystick. Drag farther forward to sprint." style={[styles.joystickArea, { left: 16 + insets.left, bottom: 8 + insets.bottom }]}>
        <Text style={[styles.sprintLabel, sprinting && styles.sprintActive]}>{sprinting ? 'AUTO SPRINT' : 'MOVE'}</Text>
        <View pointerEvents="none" style={[styles.stickBase, sprinting && styles.stickSprinting, { left: stickAnchor.x - STICK_SIZE / 2, top: stickAnchor.y - STICK_SIZE / 2 }]}>
          <View pointerEvents="none" style={styles.stickGuide} />
          <View pointerEvents="none" style={[styles.stickThumb, { transform: [{ translateX: stick.x * STICK_TRAVEL }, { translateY: stick.y * STICK_TRAVEL }] }]}><View style={styles.thumbCenter} /></View>
        </View>
      </View></GestureDetector>}
      {seatUi === 'free' ? <View style={[styles.actions, { right: 28 + insets.right, bottom: 20 + insets.bottom }]}>
        <GestureDetector gesture={gestures.jumpTap}><View accessible accessibilityRole="button" accessibilityLabel="Jump" style={styles.actionButton}><ArrowBigUp size={30} strokeWidth={2.4} color="#F7FAF8" /><Text style={styles.actionLabel}>JUMP</Text></View></GestureDetector>
        <GestureDetector gesture={gestures.crouchTap}><View accessible accessibilityRole="button" accessibilityLabel={crouched ? 'Stand up' : 'Crouch'} accessibilityState={{ selected: crouched }} style={[styles.actionButton, crouched && styles.crouchedButton]}>{crouched ? <PersonStanding size={30} strokeWidth={2.2} color="#F7FAF8" /> : <Accessibility size={30} strokeWidth={2.2} color="#F7FAF8" />}<Text style={styles.actionLabel}>{crouched ? 'STAND' : 'CROUCH'}</Text></View></GestureDetector>
      </View> : seatUi === 'seated' ? <Pressable accessibilityRole="button" accessibilityLabel="Stand up" onPress={standUp} style={[styles.standButton, { right: 28 + insets.right, bottom: 32 + insets.bottom }]}><Text style={styles.standText}>STAND UP</Text></Pressable> : <View pointerEvents="none" style={styles.seatMessage}><Text style={styles.seatMessageText}>{activeSeatType === 'lounger' ? (seatUi === 'approaching' ? 'Walking to sunbed…' : seatUi === 'entering' ? 'Lying down…' : 'Getting up…') : seatUi === 'approaching' ? (roomKind === 'tea' || roomKind === 'beach' ? 'Walking to bench…' : 'Walking to sofa…') : seatUi === 'entering' ? 'Sitting down…' : 'Standing up…'}</Text></View>}
      {nearDoor && seatUi === 'free' && (roomKind === 'loft' || roomKind === 'roof') && <Pressable accessibilityRole="button" accessibilityLabel={roomKind === 'roof' ? 'Back to Loft' : 'Go to Rooftop'} onPress={onPortal} style={styles.doorButton}><Text style={styles.doorButtonText}>{roomKind === 'roof' ? 'BACK TO LOFT' : 'GO TO ROOFTOP'}</Text></Pressable>}
      {nearSofa && seatUi === 'free' && <Pressable accessibilityRole="button" accessibilityLabel={nearSeatType === 'lounger' ? 'Relax on sunbed' : roomKind === 'tea' || roomKind === 'beach' ? 'Sit on bench' : 'Sit on the black sofa'} onPress={sitDown} style={styles.sitButton}><Text style={styles.doorButtonText}>{nearSeatType === 'lounger' ? 'RELAX ON SUNBED' : roomKind === 'tea' || roomKind === 'beach' ? 'SIT ON BENCH' : 'SIT ON SOFA'}</Text></Pressable>}
      {nearRadio && seatUi === 'free' && <Pressable accessibilityRole="button" accessibilityLabel="Tune room radio" onPress={onOpenRadio} style={styles.radioTuneButton}><RadioIcon size={20} color="#00E5FF" /><Text style={styles.radioTuneButtonText}>TUNE RADIO</Text></Pressable>}
    </>}
  </View>;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  lookZone: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
  loading: { position: 'absolute', alignSelf: 'center', top: '48%', backgroundColor: '#10221DBB', borderRadius: 22, padding: 12 },
  modelBadge: { position: 'absolute', left: 18, top: 85, maxWidth: '60%', backgroundColor: '#10221DEB', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6 },
  modelText: { color: '#FFD49A', fontSize: 10, fontWeight: '700' },
  errorCard: { position: 'absolute', alignSelf: 'center', top: '35%', width: '80%', padding: 20, backgroundColor: colors.surface, borderColor: colors.error, borderWidth: 1, borderRadius: 18 },
  errorTitle: { color: colors.error, fontSize: 18, fontWeight: '800' }, errorText: { color: colors.text, fontSize: 13, marginTop: 8 },
  viewButton: { position: 'absolute', top: 85, right: 28, flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: '#10221DE8', borderRadius: 13, paddingHorizontal: 13, paddingVertical: 11 },
  viewText: { color: '#F7FAF8', fontSize: 10, fontWeight: '900', letterSpacing: 0.6 },
  joystickArea: { position: 'absolute', width: 220, height: 190 },
  sprintLabel: { position: 'absolute', left: 26, top: 2, color: colors.primaryDark, fontSize: 10, fontWeight: '900', letterSpacing: 1.5 }, sprintActive: { color: colors.green },
  stickBase: { position: 'absolute', width: STICK_SIZE, height: STICK_SIZE, borderRadius: STICK_SIZE / 2, backgroundColor: '#FFFFFF85', borderWidth: 2, borderColor: '#15794BAA', alignItems: 'center', justifyContent: 'center' },
  stickSprinting: { borderColor: colors.green },
  stickGuide: { width: 72, height: 72, borderRadius: 36, borderWidth: 1, borderColor: '#15794B66', position: 'absolute' },
  stickThumb: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#FFFFFFE8', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: colors.primary },
  thumbCenter: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.primary },
  actions: { position: 'absolute', right: 28, bottom: 20, gap: 13, alignItems: 'center' },
  actionButton: { width: 68, height: 68, borderRadius: 34, backgroundColor: '#10221DBB', borderWidth: 1.5, borderColor: '#FFFFFF77', alignItems: 'center', justifyContent: 'center' },
  crouchedButton: { borderColor: '#67CC8A', backgroundColor: '#277A55DD' },
  actionLabel: { color: '#F7FAF8', fontSize: 8, fontWeight: '900', letterSpacing: 0.5 },
  standButton: { position: 'absolute', backgroundColor: '#FFFFFFF0', borderWidth: 1.5, borderColor: colors.primary, borderRadius: 18, paddingHorizontal: 18, paddingVertical: 16 },
  standText: { color: colors.text, fontWeight: '900', fontSize: 13 },
  doorButton: { position: 'absolute', bottom: 32, alignSelf: 'center', backgroundColor: '#FFFFFFF0', borderWidth: 1.5, borderColor: colors.primary, borderRadius: 16, paddingHorizontal: 20, paddingVertical: 13 },
  sitButton: { position: 'absolute', bottom: 32, alignSelf: 'center', backgroundColor: '#FFFFFFF0', borderWidth: 1.5, borderColor: colors.primary, borderRadius: 16, paddingHorizontal: 20, paddingVertical: 13 },
  doorButtonText: { color: colors.text, fontWeight: '900', fontSize: 12, letterSpacing: 0.8 },
  radioTuneButton: { position: 'absolute', bottom: 84, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#0F261FF2', borderWidth: 1.8, borderColor: '#00E5FF', borderRadius: 18, paddingHorizontal: 20, paddingVertical: 12, elevation: 6 },
  radioTuneButtonText: { color: '#00E5FF', fontWeight: '900', fontSize: 13, letterSpacing: 1.0 },
  seatMessage: { position: 'absolute', bottom: 70, alignSelf: 'center', backgroundColor: '#FFFFFFE8', borderRadius: 12, paddingHorizontal: 18, paddingVertical: 10 },
  seatMessageText: { color: colors.text, fontWeight: '800', fontSize: 12 },
});
