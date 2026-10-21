"""Make a Hyper3D T-pose character clean and unrigged for Mixamo.

Usage: blender --background --python scripts/prepare_self_mixamo.py --
       source.glb aligned.glb mixamo.fbx
"""
import sys

import bpy
from mathutils import Vector

source, aligned_glb, mixamo_fbx = sys.argv[sys.argv.index('--') + 1:][:3]
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=source)
character = max((obj for obj in bpy.context.scene.objects if obj.type == 'MESH'),
                key=lambda obj: len(obj.data.vertices))

# Generated arm tips lean toward the camera and hang below the shoulders.
# Straighten the rest mesh progressively from shoulder to fingertip so Mixamo
# receives a horizontal T-pose. This is geometry cleanup, not a rig.
world = character.matrix_world.copy()
inverse = world.inverted()
points = [world @ vertex.co for vertex in character.data.vertices]
foot = min(point.z for point in points)
for vertex, point in zip(character.data.vertices, points):
    reach = min(1.0, max(0.0, (abs(point.x) - 0.28) / 0.51))
    point.y += 0.14 * reach
    point.z += 0.05 * reach - foot
    vertex.co = inverse @ point
character.data.update()
character.name = 'ADDA Self T Pose'
character.vertex_groups.clear()

bpy.ops.object.select_all(action='DESELECT')
character.select_set(True)
bpy.context.view_layer.objects.active = character
bpy.ops.export_scene.gltf(filepath=aligned_glb, export_format='GLB',
                          use_selection=True, export_animations=False,
                          export_image_format='AUTO')
bpy.ops.export_scene.fbx(filepath=mixamo_fbx, use_selection=True,
                         object_types={'MESH'}, add_leaf_bones=False,
                         path_mode='COPY', embed_textures=True, bake_anim=False)
print('MIXAMO READY', mixamo_fbx, 'vertices', len(character.data.vertices))
