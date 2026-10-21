"""Export a Mixamo FBX with its original GLB or FBX character texture as GLB.

Usage: blender --background --python scripts/convert_mixamo_fbx.py -- \
    Walking.fbx assets/models/hyper3d-indian-man-tpose-reference.glb out.glb walk
"""
import sys

import bpy


fbx, reference_glb, output_glb, clip_name = sys.argv[sys.argv.index('--') + 1:][:4]
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.fbx(filepath=fbx)
rig = next(obj for obj in bpy.context.scene.objects if obj.type == 'ARMATURE')
mesh = next(obj for obj in bpy.context.scene.objects if obj.type == 'MESH')
action = next(iter(bpy.data.actions))
action.name = clip_name

if reference_glb.lower().endswith('.fbx'):
    bpy.ops.import_scene.fbx(filepath=reference_glb)
else:
    bpy.ops.import_scene.gltf(filepath=reference_glb)
source_mesh = next(obj for obj in bpy.context.scene.objects if obj.type == 'MESH' and obj is not mesh)
mesh.data.materials.clear()
mesh.data.materials.append(source_mesh.data.materials[0])

bpy.ops.object.select_all(action='DESELECT')
rig.select_set(True)
mesh.select_set(True)
bpy.context.view_layer.objects.active = rig
bpy.ops.export_scene.gltf(
    filepath=output_glb, export_format='GLB', use_selection=True,
    export_animations=True, export_nla_strips=False, export_image_format='AUTO',
)
print('Exported', output_glb, 'with', action.name)
