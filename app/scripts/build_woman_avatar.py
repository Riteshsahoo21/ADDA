"""Build a woman avatar from her Mixamo walk and seated idle.

The standing pose comes from opposite gait phases. The crouch uses the man's
local-bone pose change, applied to the woman's own standing pose.
"""

import json
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
from build_self_avatar import transfer_crouch

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT.parent / '_avatar_tools'
NAME = sys.argv[1] if len(sys.argv) > 1 else 'indian-woman'
if NAME not in {'indian-woman', 'chinese-woman', 'nepali-woman', 'white-top-woman'}:
    raise SystemExit(f'Unknown woman avatar: {NAME}')
WALK = TOOLS / f'{NAME}-walking.glb'
SIT = TOOLS / f'{NAME}-sitting.glb'
SOURCE_MAN = ROOT / 'assets/models/avatar-man.glb'
OUTPUT_NAME = {'indian-woman': 'avatar-woman.glb', 'chinese-woman': 'avatar-chinese-woman.glb',
               'nepali-woman': 'avatar-nepali-woman.glb',
               'white-top-woman': 'avatar-white-top-woman.glb'}[NAME]
OUTPUT = ROOT / 'assets/models' / OUTPUT_NAME
MANIFEST = TOOLS / f'{NAME}-avatar-clips.json'


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
    duration = walk_tracks[hip][0][-1][0]
    walk_fixed = {}
    for key, (times, poses) in walk_tracks.items():
        copied = [p[:] for p in poses]
        if key == hip:
            for pose in copied:
                pose[0], pose[1] = hip_start[0], hip_start[1]
        walk_fixed[key] = ([t[0] for t in times], copied)

    idle = {key: mix(sample(track, duration * 0.25, key[1] == 'rotation'),
                     sample(track, duration * 0.75, key[1] == 'rotation'),
                     0.5, key[1] == 'rotation') for key, track in walk_fixed.items()}
    old_idle = {key: sample(track, 0, key[1] == 'rotation')
                for key, track in old_idle_tracks.items()}
    old_crouch = {key: sample(track, 0, key[1] == 'rotation')
                  for key, track in old_crouch_tracks.items()}
    crouched = transfer_crouch(idle, old_idle, old_crouch)
    if NAME == 'chinese-woman':
        # Her shorter legs put the transferred squat 10 cm through the floor.
        crouched[hip][2] -= 10
    elif NAME == 'nepali-woman':
        # Keep the transferred squat at the same floor contact as her idle.
        crouched[hip][2] -= 7
    elif NAME == 'white-top-woman':
        # Her proportions need a higher pelvis to keep both shoes at floor level.
        crouched[hip][2] -= 14
    assert 30 < crouched[hip][2] - idle[hip][2] < 65, 'Crouch pelvis delta is implausible'

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
    MANIFEST.write_text(json.dumps(clips, separators=(',', ':')))
    subprocess.run([sys.executable, str(ROOT / 'scripts/inject_animation_clips.py'),
                    str(WALK), str(MANIFEST), str(OUTPUT)], check=True)
    print('Built', OUTPUT)
    print('Animations:', ', '.join(clip['name'] for clip in clips))
    print('Crouch pelvis drop:', round(crouched[hip][2] - idle[hip][2], 3), 'Mixamo cm')


if __name__ == '__main__':
    main()
