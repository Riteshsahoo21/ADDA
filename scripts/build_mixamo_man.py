"""Build the Indian man avatar from animations authored on his own Mixamo rig.

Run after convert_mixamo_walking.py has exported Walking.fbx and Sitting.fbx
with the same textured source mesh.
"""
import argparse
import json
import math
import struct
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT.parent / '_avatar_tools'
WALK = TOOLS / 'indian-man-walking.glb'
SIT = TOOLS / 'indian-man-sitting.glb'
CROUCH = TOOLS / 'indian-man-crouch.glb'
OUTPUT = ROOT / 'assets/models/avatar-man.glb'


def load_tracks(path, animation_index=0):
    data = path.read_bytes()
    json_size = struct.unpack_from('<I', data, 12)[0]
    doc = json.loads(data[20:20 + json_size])
    binary_start = 28 + json_size

    def values(index):
        acc = doc['accessors'][index]
        view = doc['bufferViews'][acc['bufferView']]
        width = {'SCALAR': 1, 'VEC3': 3, 'VEC4': 4}[acc['type']]
        assert acc['componentType'] == 5126 and 'byteStride' not in view
        offset = binary_start + view.get('byteOffset', 0) + acc.get('byteOffset', 0)
        raw = struct.unpack_from('<' + 'f' * acc['count'] * width, data, offset)
        return [list(raw[i:i + width]) for i in range(0, len(raw), width)]

    tracks = {}
    animation = doc['animations'][animation_index]
    for channel in animation['channels']:
        sampler = animation['samplers'][channel['sampler']]
        name = doc['nodes'][channel['target']['node']]['name']
        path_name = channel['target']['path']
        tracks[(name, path_name)] = (values(sampler['input']), values(sampler['output']))
    return doc, tracks


def mix(a, b, amount, rotation=False):
    if rotation:
        dot = sum(x * y for x, y in zip(a, b))
        if dot < 0:
            b = [-x for x in b]
            dot = -dot
        if dot < 0.9995:
            angle = math.acos(max(-1, min(1, dot)))
            sine = math.sin(angle)
            left = math.sin((1 - amount) * angle) / sine
            right = math.sin(amount * angle) / sine
            return [left * x + right * y for x, y in zip(a, b)]
    result = [x * (1 - amount) + y * amount for x, y in zip(a, b)]
    if rotation:
        norm = math.sqrt(sum(x * x for x in result))
        return [x / norm for x in result]
    return result


def sample(track, time, rotation=False):
    times, poses = track
    times = [t[0] if isinstance(t, list) else t for t in times]
    if time <= times[0]:
        return poses[0][:]
    for index in range(1, len(times)):
        if time <= times[index]:
            t = (time - times[index - 1]) / (times[index] - times[index - 1])
            return mix(poses[index - 1], poses[index], t, rotation)
    return poses[-1][:]


def make_clip(name, tracks):
    entries = []
    for (bone, path), (times, poses) in tracks.items():
        property_name = {'translation': 'position', 'rotation': 'quaternion', 'scale': 'scale'}[path]
        entries.append({
            'name': f'.bones[{bone}].{property_name}',
            'times': times,
            'values': [number for pose in poses for number in pose],
        })
    return {'name': name, 'tracks': entries}


def static_pose(pose, duration=1):
    return {key: ([0, duration], [value[:], value[:]]) for key, value in pose.items()}


def blend_pose(a, b, amount):
    return {key: mix(a[key], b[key], amount, key[1] == 'rotation') for key in a}


def transition(start, end, duration):
    return {key: ([0, duration], [start[key], end[key]]) for key in start}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--walk', type=Path, default=WALK)
    parser.add_argument('--sit', type=Path, default=SIT)
    parser.add_argument('--crouch', type=Path, default=CROUCH)
    parser.add_argument('--output', type=Path, default=OUTPUT)
    parser.add_argument('--manifest', type=Path, default=TOOLS / 'mixamo-man-clips.json')
    args = parser.parse_args()
    walk_doc, walk_tracks = load_tracks(args.walk)
    sit_doc, sit_tracks = load_tracks(args.sit)
    crouch_doc, crouch_tracks = load_tracks(args.crouch)
    assert [n.get('name') for n in walk_doc['nodes']] == [n.get('name') for n in sit_doc['nodes']]
    assert [n.get('name') for n in walk_doc['nodes']] == [n.get('name') for n in crouch_doc['nodes']]
    assert walk_tracks.keys() == sit_tracks.keys() == crouch_tracks.keys()

    # Mixamo's Hips translate in FBX Y while walking; the player controller
    # already owns world movement. Blender's export maps FBX Z to world Y.
    hip = ('mixamorig:Hips', 'translation')
    hip_start = walk_tracks[hip][1][0]
    walk_fixed = {}
    for key, (times, poses) in walk_tracks.items():
        copied = [p[:] for p in poses]
        if key == hip:
            for pose in copied:
                pose[0], pose[1] = hip_start[0], hip_start[1]
        walk_fixed[key] = ([t[0] for t in times], copied)

    # Blend opposite gait phases into a balanced standing stance with both
    # feet beneath the body. Sampling a single walk frame leaves a leg raised.
    idle = {key: mix(sample(track, 0.25, key[1] == 'rotation'),
                     sample(track, 0.77, key[1] == 'rotation'),
                     0.5, key[1] == 'rotation') for key, track in walk_fixed.items()}
    seated = {key: sample(track, 0.55, key[1] == 'rotation') for key, track in sit_tracks.items()}
    # Blender's IK solver keeps both feet grounded while lowering the pelvis.
    # This independent squat pose must never be derived from the sit animation.
    crouched = {key: sample(track, 0, key[1] == 'rotation')
                for key, track in crouch_tracks.items()}

    sprint = {key: ([t * 0.72 for t in times], [p[:] for p in poses])
              for key, (times, poses) in walk_fixed.items()}
    crouch_walk = {}
    for key, (times, poses) in walk_fixed.items():
        if key == hip:
            copied = [[crouched[key][0], crouched[key][1],
                       crouched[key][2] + (p[2] - hip_start[2]) * 0.15]
                      for p in poses]
        elif key[1] == 'rotation':
            copied = [mix(crouched[key], p, 0.18, True) for p in poses]
        else:
            copied = [crouched[key][:] for _ in poses]
        crouch_walk[key] = (times[:], copied)

    # Controller supplies jump height, so this clip changes pose only.
    jump = blend_pose(idle, crouched, 0.2)
    jump_tracks = transition(idle, jump, 0.15)
    for key, (times, poses) in jump_tracks.items():
        times.extend([0.4, 0.65])
        poses.extend([jump[key][:], idle[key][:]])

    clips = [
        make_clip('idle', static_pose(idle)),
        make_clip('walk', walk_fixed),
        make_clip('sprint', sprint),
        make_clip('jump', jump_tracks),
        make_clip('crouch_idle', static_pose(crouched)),
        make_clip('crouch_walk', crouch_walk),
        make_clip('sit_enter', transition(idle, seated, 0.55)),
        make_clip('sit_idle', static_pose(seated)),
        make_clip('sit_exit', transition(seated, idle, 0.5)),
    ]
    manifest = args.manifest
    manifest.write_text(json.dumps(clips, separators=(',', ':')))
    subprocess.run([sys.executable, str(ROOT / 'scripts/inject_animation_clips.py'),
                    str(args.walk), str(manifest), str(args.output)], check=True)
    print('Clips:', ', '.join(clip['name'] for clip in clips))


if __name__ == '__main__':
    main()
