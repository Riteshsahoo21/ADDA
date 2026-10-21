"""Build the selfie avatar from its Mixamo walk and seated idle animations.

The crouch is transferred as a local-bone pose delta from the existing Indian
man. Reusing absolute joint rotations would bend this different body badly.
"""
import json
import math
import subprocess
import sys
from pathlib import Path

from build_mixamo_man import (
    blend_pose,
    load_tracks,
    make_clip,
    mix,
    sample,
    static_pose,
    transition,
)

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT.parent / '_avatar_tools'
WALK = TOOLS / 'self-walking.glb'
SIT = TOOLS / 'self-sitting.glb'
SOURCE_MAN = ROOT / 'assets/models/avatar-man.glb'
OUTPUT = ROOT / 'assets/models/avatar-self.glb'


def qmul(a, b):
    x, y, z, w = a
    X, Y, Z, W = b
    return [w * X + x * W + y * Z - z * Y,
            w * Y - x * Z + y * W + z * X,
            w * Z + x * Y - y * X + z * W,
            w * W - x * X - y * Y - z * Z]


def qinverse(q):
    length = sum(v * v for v in q)
    return [-q[0] / length, -q[1] / length, -q[2] / length, q[3] / length]


def transfer_crouch(new_idle, old_idle, old_crouch):
    pose = {}
    for key, value in new_idle.items():
        if key not in old_idle or key not in old_crouch:
            pose[key] = value[:]
        elif key[1] == 'rotation':
            delta = qmul(qinverse(old_idle[key]), old_crouch[key])
            result = qmul(value, delta)
            norm = math.sqrt(sum(v * v for v in result))
            pose[key] = [v / norm for v in result]
        elif key[1] == 'translation':
            pose[key] = [v + c - i for v, c, i in zip(value, old_crouch[key], old_idle[key])]
        else:
            pose[key] = value[:]
    return pose


def main():
    walk_doc, walk_tracks = load_tracks(WALK)
    sit_doc, sit_tracks = load_tracks(SIT)
    _, old_idle_tracks = load_tracks(SOURCE_MAN, 0)
    _, old_crouch_tracks = load_tracks(SOURCE_MAN, 4)
    assert [n.get('name') for n in walk_doc['nodes']] == [n.get('name') for n in sit_doc['nodes']]
    assert walk_tracks.keys() == sit_tracks.keys()
    assert old_idle_tracks.keys() == old_crouch_tracks.keys()

    hip = ('mixamorig:Hips', 'translation')
    hip_start = walk_tracks[hip][1][0]
    walk_fixed = {}
    for key, (times, poses) in walk_tracks.items():
        copied = [p[:] for p in poses]
        if key == hip:
            for pose in copied:
                pose[0], pose[1] = hip_start[0], hip_start[1]
        walk_fixed[key] = ([t[0] for t in times], copied)

    # Opposite phases of the walk cancel the raised leg and make a balanced idle.
    idle = {key: mix(sample(track, 0.25, key[1] == 'rotation'),
                     sample(track, 0.77, key[1] == 'rotation'),
                     0.5, key[1] == 'rotation') for key, track in walk_fixed.items()}
    old_idle = {key: sample(track, 0, key[1] == 'rotation')
                for key, track in old_idle_tracks.items()}
    old_crouch = {key: sample(track, 0, key[1] == 'rotation')
                  for key, track in old_crouch_tracks.items()}
    crouched = transfer_crouch(idle, old_idle, old_crouch)
    # Mixamo rig translations are in centimetres before the GLB parent scale.
    assert 35 < crouched[hip][2] - idle[hip][2] < 65, 'Crouch pelvis delta is implausible'

    # Sitting Idle is a seated loop, not an entry animation. Blend into a frame
    # inside that loop, then play the original loop while the avatar is seated.
    seated = {key: sample(track, 2.0, key[1] == 'rotation')
              for key, track in sit_tracks.items()}
    sit_loop = {key: ([t[0] for t in times], [p[:] for p in poses])
                for key, (times, poses) in sit_tracks.items()}
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
        make_clip('sit_idle', sit_loop),
        make_clip('sit_exit', transition(seated, idle, 0.5)),
    ]
    manifest = TOOLS / 'self-avatar-clips.json'
    manifest.write_text(json.dumps(clips, separators=(',', ':')))
    subprocess.run([sys.executable, str(ROOT / 'scripts/inject_animation_clips.py'),
                    str(WALK), str(manifest), str(OUTPUT)], check=True)
    print('Built', OUTPUT, 'from Walking (2), Sitting Idle, and Indian man crouch')
    print('Animations:', ', '.join(clip['name'] for clip in clips))
    print('Crouch pelvis drop:', round(crouched[hip][2] - idle[hip][2], 3), 'Mixamo cm')


if __name__ == '__main__':
    main()
