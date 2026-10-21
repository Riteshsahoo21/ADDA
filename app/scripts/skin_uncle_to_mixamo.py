"""Transfer the working man's Mixamo skin weights to a similar T-pose mesh.

Usage: blender --background --python scripts/skin_uncle_to_mixamo.py --
       mixamo-rigged.glb character-source.glb character-rigged.glb

For a generated character with arms shorter and farther forward than the rig,
pass --arm-reach, --arm-depth, and --arm-height in metres. These move the arm
vertices into the rig's T-pose before projecting weights.

This is a geometric projection. Inspect every animation afterwards; a similar
height alone does not guarantee good weights around loose clothes or fingers.
"""
import sys
from mathutils import Vector

import bpy

args = sys.argv[sys.argv.index('--') + 1:]
reference, generated, output = args[:3]

def option(name):
    return float(args[args.index(name) + 1]) if name in args else 0.0

arm_reach = option('--arm-reach')
arm_depth = option('--arm-depth')
arm_height = option('--arm-height')
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=reference)
rig = next(obj for obj in bpy.context.scene.objects if obj.type == 'ARMATURE')
old_mesh = max((obj for obj in bpy.context.scene.objects if obj.type == 'MESH'),
               key=lambda obj: len(obj.data.vertices))
old_meshes = set(obj for obj in bpy.context.scene.objects if obj.type == 'MESH')
rig.data.pose_position = 'REST'
bpy.context.view_layer.update()

bpy.ops.import_scene.gltf(filepath=generated)
candidate = max((obj for obj in bpy.context.scene.objects
                 if obj.type == 'MESH' and obj not in old_meshes),
                key=lambda obj: len(obj.data.vertices))

def bounds(obj):
    points = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    return [min(p[i] for p in points) for i in range(3)], [max(p[i] for p in points) for i in range(3)]

old_min, old_max = bounds(old_mesh)
new_min, new_max = bounds(candidate)
scale = (old_max[2] - old_min[2]) / (new_max[2] - new_min[2])
candidate.scale *= scale
candidate.location.z += old_min[2] - new_min[2] * scale
candidate.location.x += (old_min[0] + old_max[0] - (new_min[0] + new_max[0]) * scale) / 2
bpy.context.view_layer.update()
print('ALIGNED HEIGHT', round(scale, 4), 'old', old_min, old_max,
      'new', *bounds(candidate))

# The photo-derived mesh has arms pitched forward and shorter than Mixamo's
# horizontal T-pose. Correct its rest geometry progressively from shoulder to
# fingertip; projecting weights before this caused elbows and hands to map to
# chest bones.
if arm_reach or arm_depth or arm_height:
    for vertex in candidate.data.vertices:
        x = vertex.co.x
        reach = min(1.0, max(0.0, (abs(x) - 0.30) / 0.43))
        vertex.co.x += (1 if x > 0 else -1) * arm_reach * reach
        vertex.co.y += arm_depth * reach
        vertex.co.z += arm_height * reach
    candidate.data.update()
    print('ALIGNED ARMS', arm_reach, arm_depth, arm_height, *bounds(candidate))

for group in old_mesh.vertex_groups:
    candidate.vertex_groups.new(name=group.name)
transfer = candidate.modifiers.new('Project Mixamo skin weights', 'DATA_TRANSFER')
transfer.object = old_mesh
transfer.use_vert_data = True
transfer.data_types_verts = {'VGROUP_WEIGHTS'}
transfer.vert_mapping = 'POLYINTERP_NEAREST'
transfer.layers_vgroup_select_src = 'ALL'
transfer.layers_vgroup_select_dst = 'NAME'
bpy.ops.object.select_all(action='DESELECT')
candidate.select_set(True)
bpy.context.view_layer.objects.active = candidate
bpy.ops.object.modifier_apply(modifier=transfer.name)
counts = [sum(1 for g in v.groups if g.weight > 0.001) for v in candidate.data.vertices]
print('SKIN COVERAGE', len(candidate.data.vertices), 'unweighted', counts.count(0),
      'mean influences', sum(counts) / len(counts))

armature = candidate.modifiers.new('Mixamo rig', 'ARMATURE')
armature.object = rig
candidate.parent = rig
candidate.matrix_parent_inverse = rig.matrix_world.inverted()
candidate.name = 'ADDA Character'
for obj in old_meshes:
    obj.hide_render = True
    obj.hide_set(True)

bpy.ops.object.select_all(action='DESELECT')
rig.select_set(True)
candidate.select_set(True)
bpy.context.view_layer.objects.active = rig
rig.data.pose_position = 'POSE'
bpy.ops.export_scene.gltf(filepath=output, export_format='GLB',
                          use_selection=True, export_animations=False,
                          export_image_format='AUTO')
print('EXPORTED', output)
