"""Create a grounded crouch for the man's Mixamo rig using Blender IK.

Usage: blender --background --python scripts/create_mixamo_crouch.py -- avatar-man.glb crouch.glb
"""
import sys
import math
from pathlib import Path

import bpy
from mathutils import Quaternion

source, output = sys.argv[sys.argv.index('--') + 1:][:2]
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=source)
rig = next(obj for obj in bpy.context.scene.objects if obj.type == 'ARMATURE')
mesh = next(obj for obj in bpy.context.scene.objects if obj.type == 'MESH' and len(obj.data.vertices) > 1000)
for track in rig.animation_data.nla_tracks:
    track.mute = True
rig.animation_data.action = bpy.data.actions['idle']
bpy.context.scene.frame_set(1)

for side in ('Left', 'Right'):
    shin = rig.pose.bones[f'mixamorig:{side}Leg']
    foot = rig.pose.bones[f'mixamorig:{side}Foot']
    ankle = rig.matrix_world @ foot.head
    target = bpy.data.objects.new(f'{side} ankle target', None)
    bpy.context.collection.objects.link(target)
    target.location = ankle
    constraint = shin.constraints.new('IK')
    constraint.target = target
    constraint.chain_count = 2

hips = rig.pose.bones['mixamorig:Hips']
hips.location.y -= 48  # FBX-centimetre rig; maps to 48 cm lower in world Z.
spine = rig.pose.bones['mixamorig:Spine']
spine.rotation_mode = 'QUATERNION'
spine.rotation_quaternion = Quaternion((1, 0, 0), math.radians(32)) @ spine.rotation_quaternion
for frame in (1, 2):
    hips.keyframe_insert(data_path='location', frame=frame)
    spine.keyframe_insert(data_path='rotation_quaternion', frame=frame)
bpy.context.view_layer.update()
for name in ('Hips', 'Head', 'LeftLeg', 'LeftFoot', 'RightLeg', 'RightFoot'):
    bone = rig.pose.bones.get('mixamorig:' + name)
    if bone:
        print('CROUCH BONE', name, tuple(round(v, 3) for v in rig.matrix_world @ bone.head))

bpy.ops.object.select_all(action='DESELECT')
rig.select_set(True)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode='POSE')
bpy.ops.pose.select_all(action='SELECT')
bpy.ops.nla.bake(frame_start=1, frame_end=2, step=1, only_selected=True,
                 visual_keying=True, clear_constraints=True, use_current_action=False,
                 bake_types={'POSE'})
bpy.ops.object.mode_set(mode='OBJECT')
rig.animation_data.action.name = 'crouch_ik'
for track in list(rig.animation_data.nla_tracks):
    rig.animation_data.nla_tracks.remove(track)
for action in list(bpy.data.actions):
    if action is not rig.animation_data.action:
        bpy.data.actions.remove(action)
bpy.ops.object.select_all(action='DESELECT')
rig.select_set(True)
mesh.select_set(True)
bpy.context.view_layer.objects.active = rig
bpy.ops.export_scene.gltf(filepath=output, export_format='GLB', use_selection=True,
                          export_animations=True, export_nla_strips=False,
                          export_image_format='AUTO')
print('CROUCH OUTPUT', Path(output).stat().st_size)
