# ADDA — Apna Virtual Hangout

Android React Native app with native `expo-gl` rendering. No WebView or browser-rendered 3D scene is used. The installed debug APK opens ADDA directly; Expo Go is not needed.

## Current rooms

- **Loft 16:** the supplied `loft_16_interior.glb` replaces the former home scene. Walk up to the black sofa for **Sit on sofa**, or tap it; the avatar uses bundled sit/idle/stand animation clips. The wall door leads to School Rooftop.
- **School Rooftop:** the supplied `school_rooftop.glb` is scaled and centered for the avatar. Its return door is solid; walk near it for **Back to Loft**.
- **Tea Party:** the supplied ZIP exports become a chai stall with two sittable benches opposite three shops across an evening road. Approach a chai bench for **Sit on bench**, then use **Stand up** to leave it. The road and shop fronts are walkable, with collision around the stall counter, benches, and shop row. The road and grass terrain end together beyond a four-sided chain-link fence. The supplied Sketchfab maple trees stand inside the fence beside the shops, leaving the road clear.
- Choose **Boy** or **Girl** after selecting Loft 16 or Tea Party. Both use Quaternius's human-proportioned CC0 models. FPP hides the avatar; TPP shows it.
- The lower-left thumbstick relocates to the first touch. Push it fully forward to auto-sprint. A second finger can turn the camera anywhere on the right side while moving; the avatar faces its camera-relative travel direction. Jump/Crouch remain usable during movement. Both rooms fill the landscape screen and hide Android's system bars until exit.

The native texture adapter reads predecoded RGBA packs alongside local GLBs. Three.js's browser `Image`/`Blob` texture path does not work in Expo GL. `scripts/pack_native_textures.py` builds those packs from GLBs without changing the source GLB. The chai mesh was simplified from 1,000,000 to 230,950 triangles with `meshoptimizer`; its source ZIP remains at the project root. This may alter small geometric details. Tea and shop textures are rendered at 1024px rather than the original 2048px to limit mobile memory use. No hardware FPS result is claimed; the in-app counter measures the JavaScript render loop only.

## Versions

Expo SDK 57, React Native 0.86, React 19.2, TypeScript, `expo-gl` 57, and Three.js 0.162. Three r162 is retained because it still supports the WebGL 1 context supplied by Expo GL on the tested phone. `expo-three` is not required. A small adapter in `src/three/renderer/createNativeRenderer.ts` connects Three to Expo GL.

## Windows USB run

Install Node.js 22.13+, JDK 17, Android SDK Platform 36, Build Tools, Command Line Tools, and Platform Tools. Set `ANDROID_HOME`/`ANDROID_SDK_ROOT` to the SDK directory and `JAVA_HOME` to JDK 17. Connect an Android phone by USB, enable USB debugging, and accept its RSA prompt.

In PowerShell window 1:

```powershell
cd D:\hangout\adda
adb devices
npm.cmd install
adb reverse tcp:8081 tcp:8081
npm.cmd start
```

In PowerShell window 2, for the first install or after native dependency/config changes:

```powershell
cd D:\hangout\adda
npm.cmd run android -- --device 2602BPC18I
```

Use the model/serial shown by `adb devices -l` if it differs. `npm.cmd start` configures IPv4 localhost and USB port reversal. Keep Metro running; JavaScript, UI, scene, and bundled asset changes normally reload through Fast Refresh. A changed native module, plugin, or Gradle setting needs a new Android build. After changing `metro.config.js`, restart Metro. If a GL scene stays stale after Fast Refresh, open the React Native development menu and Reload. Do not use remote Chrome JS debugging with Expo GL.

For device logs:

```powershell
adb logcat -s ReactNativeJS:V Expo:V EXGL:V AndroidRuntime:E
```

## Phone check

1. Enter any nonempty username/password, then open **The Adda Gang** home screen.
2. Tap **Loft 16**, choose **Boy** or **Girl**, and confirm the imported furnished room appears in landscape.
3. Switch FPP/TPP. Check forward/back/left/right facing, then move with the left thumb while turning the camera with the right finger and tap Jump without lifting either finger.
4. In Loft 16, walk near the sofa, tap **Sit on sofa**, then **Stand up**. Find the wall door below **WAY TO ROOFTOP**, enter the rooftop, and walk near its door to return.
5. Exit; open **Tea Party** with either avatar. Approach either chai bench, tap **Sit on bench**, check the sit and stand animations, then cross the road and walk along all three shop fronts.
6. Exit and confirm the portrait home screen returns without a crash.

If a model fails, the room displays a model warning instead of silently hiding it. If the GL context fails, the screen shows a renderer error and Metro/Android logs include `[ADDA GL]`.

## Checks

```powershell
npm.cmd run typecheck
npm.cmd run lint
npx.cmd expo install --check
node scripts/verify_native_glb.mjs
```

See [ASSET_GUIDE.md](ASSET_GUIDE.md) for asset sources and licenses.
