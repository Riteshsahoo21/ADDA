"""Export the aligned photo boy as a clean, skinless Mixamo FBX."""
import sys
import bpy

source, output = sys.argv[sys.argv.index('--') + 1:][:2]
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=source)

character = max((obj for obj in bpy.context.scene.objects if obj.type == 'MESH'),
                key=lambda obj: len(obj.data.vertices))
for rig in (obj for obj in bpy.context.scene.objects if obj.type == 'ARMATURE'):
    rig.data.pose_position = 'REST'

# Preserve the world-space T-pose when removing the temporary transferred rig.
world = character.matrix_world.copy()
character.parent = None
character.matrix_world = world
for modifier in list(character.modifiers):
    if modifier.type == 'ARMATURE':
        character.modifiers.remove(modifier)
character.vertex_groups.clear()
character.name = 'ADDA Photo Boy T Pose'

bpy.ops.object.select_all(action='DESELECT')
character.select_set(True)
bpy.context.view_layer.objects.active = character
bpy.ops.export_scene.fbx(filepath=output, use_selection=True, object_types={'MESH'},
                         add_leaf_bones=False, path_mode='COPY', embed_textures=True,
                         bake_anim=False)
print('EXPORTED MIXAMO FBX', output, 'vertices', len(character.data.vertices))
