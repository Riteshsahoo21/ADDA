# ADDA local 3D assets

The Android rooms load local GLBs through `expo-asset` and `expo-gl`. Each textured model has a matching `.rgba` and `.json` pack in `assets/textures/`; `scripts/pack_native_textures.py` creates those packs for native texture loading. No model is fetched from a web URL at runtime.

| Room or character | Local asset | Source recorded in the file or project |
| --- | --- | --- |
| Loft 16 | `assets/models/loft16.glb` | [Loft 16 interior by dasy444](https://sketchfab.com/3d-models/loft-16-interior-6fcba30b42d94581b068b448b6da85a2), Sketchfab Standard License, supplied by the user |
| School Rooftop | `assets/models/school-rooftop.glb` | [School Rooftop by clonekrakein](https://sketchfab.com/3d-models/school-rooftop-c732045a20d143ccbce092d461ba065b), CC BY 4.0, supplied by the user |
| Tea Party chai stall and shops | `assets/models/chai-stall.glb`, `assets/models/three-shops.glb` | Converted from the two user supplied ZIP archives |
| Man, Indian Woman, Chinese Woman, Nepali Woman, White Top Woman, Uncle, Photo Boy, My Avatar | `assets/models/avatar-man.glb`, `assets/models/avatar-woman.glb`, `assets/models/avatar-chinese-woman.glb`, `assets/models/avatar-nepali-woman.glb`, `assets/models/avatar-white-top-woman.glb`, `assets/models/avatar-uncle.glb`, `assets/models/avatar-photo-boy.glb`, `assets/models/avatar-self.glb` | Hyper3D meshes with Mixamo skeletons and local animation clips. Indian Woman uses `Walking (3).fbx` and `Sitting Idle (1).fbx`; Chinese Woman uses `Walking (4).fbx` and `Sitting Idle (2).fbx`; Nepali Woman uses `Walking (5).fbx` and `Sitting Idle (3).fbx`; White Top Woman uses `Walking (7).fbx` and `Sitting Idle (4).fbx`. All four use the Indian Man crouch pose delta. My Avatar uses `Walking (2).fbx`, `Sitting Idle.fbx`, and the same crouch transfer. |
| Tea Party ground | `assets/models/tea-ground.glb` | Generated from procedural geometry and local textures |
| Tea Party maple trees | `assets/models/maple-tree.glb` | [Maple Tree by atrodler](https://sketchfab.com/3d-models/maple-tree-4b27adcf92f644bdabf8ecc6c5bef399), CC BY 4.0, supplied by the user as `maple_tree.glb`; static meshes merged for Android while preserving textures |

The rooftop and Loft contain the supplied geometry. The new Loft wall, wall art, and interaction targets are procedural Three.js meshes. Returning to Loft uses the steel door already in the rooftop GLB. The rooftop GLB is scaled in the scene without modifying the supplied file.

Tea Party uses the supplied maple inside its four-sided procedural chain-link fence, on the grass strips beside the shop rows. The road is free of trees. The road, sidewalks, and terrain terminate at the same distant edge behind the fog.

The bundled models are in `assets/models/`. Standalone source GLB and FBX exports are stored in `../source-assets/` and are not loaded by the app. The old source ZIP archives were removed during workspace cleanup. To validate bundled assets, run `node scripts/verify_native_glb.mjs`.
