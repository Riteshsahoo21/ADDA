"""Bake Quaternius CC0 Humanoid Animation Library (UAL1) clips into boy and girl rigs.

Extracts authored in-place locomotion clips:
- idle (Idle_Loop)
- walk (Walk_Loop)
- sprint / run (Sprint_Loop)
- jog (Jog_Fwd_Loop)
- jump (Jump_Loop)
- jump_start (Jump_Start)
- jump_land (Jump_Land)
- crouch_idle (Crouch_Idle_Loop)
- crouch_walk (Crouch_Fwd_Loop)

Maps animation tracks directly to the shared 65-bone humanoid skeleton.
"""
import copy, json, struct
from pathlib import Path

def bake_animations(char_path: Path, ual_path: Path, out_path: Path):
    char_data = char_path.read_bytes()
    assert char_data[:4] == b'glTF'
    cl = struct.unpack_from('<I', char_data, 12)[0]
    char_doc = json.loads(char_data[20:20 + cl])
    bl = struct.unpack_from('<I', char_data, 20 + cl)[0]
    char_bin = bytearray(char_data[28 + cl:28 + cl + bl])

    ual_data = ual_path.read_bytes()
    assert ual_data[:4] == b'glTF'
    ual_cl = struct.unpack_from('<I', ual_data, 12)[0]
    ual_doc = json.loads(ual_data[20:20 + ual_cl])
    ual_bl = struct.unpack_from('<I', ual_data, 20 + ual_cl)[0]
    ual_bin = ual_data[28 + ual_cl:28 + ual_cl + ual_bl]

    # Desired animations and their aliases
    anim_definitions = [
        ('Idle_Loop', ['idle', 'Idle_Loop']),
        ('Walk_Loop', ['walk', 'Walk_Loop']),
        ('Sprint_Loop', ['sprint', 'run', 'Sprint_Loop']),
        ('Jog_Fwd_Loop', ['jog', 'Jog_Fwd_Loop']),
        ('Jump_Loop', ['jump', 'Jump_Loop']),
        ('Jump_Start', ['jump_start', 'Jump_Start']),
        ('Jump_Land', ['jump_land', 'Jump_Land']),
        ('Crouch_Idle_Loop', ['crouch_idle', 'crouchIdle', 'Crouch_Idle_Loop']),
        ('Crouch_Fwd_Loop', ['crouch_walk', 'crouchWalk', 'Crouch_Fwd_Loop']),
    ]

    ual_anims_by_name = {a.get('name'): a for a in ual_doc.get('animations', [])}

    # Track buffer copies
    while len(char_bin) % 4 != 0:
        char_bin.append(0)

    accessor_map = {}
    bv_map = {}
    new_bvs = []
    new_accessors = []

    def get_or_copy_accessor(acc_idx):
        if acc_idx in accessor_map:
            return accessor_map[acc_idx]
        acc = copy.deepcopy(ual_doc['accessors'][acc_idx])
        old_bv_idx = acc['bufferView']

        if old_bv_idx not in bv_map:
            old_bv = ual_doc['bufferViews'][old_bv_idx]
            bv_data = ual_bin[old_bv['byteOffset']:old_bv['byteOffset'] + old_bv['byteLength']]
            while len(char_bin) % 4 != 0:
                char_bin.append(0)
            new_offset = len(char_bin)
            char_bin.extend(bv_data)

            new_bv = copy.deepcopy(old_bv)
            new_bv['buffer'] = 0
            new_bv['byteOffset'] = new_offset

            new_bv_idx = len(char_doc['bufferViews']) + len(new_bvs)
            new_bvs.append(new_bv)
            bv_map[old_bv_idx] = new_bv_idx

        acc['bufferView'] = bv_map[old_bv_idx]
        new_acc_idx = len(char_doc['accessors']) + len(new_accessors)
        new_accessors.append(acc)
        accessor_map[acc_idx] = new_acc_idx
        return new_acc_idx

    new_anims = []
    for source_name, target_names in anim_definitions:
        source_anim = ual_anims_by_name.get(source_name)
        if not source_anim:
            print(f'Warning: {source_name} not found in UAL')
            continue

        base_anim = copy.deepcopy(source_anim)
        for s in base_anim['samplers']:
            s['input'] = get_or_copy_accessor(s['input'])
            s['output'] = get_or_copy_accessor(s['output'])

        for target_name in target_names:
            anim_instance = copy.deepcopy(base_anim)
            anim_instance['name'] = target_name
            new_anims.append(anim_instance)

    char_doc['bufferViews'].extend(new_bvs)
    char_doc['accessors'].extend(new_accessors)
    char_doc['animations'] = new_anims
    char_doc['buffers'][0]['byteLength'] = len(char_bin)

    encoded = json.dumps(char_doc, separators=(',', ':')).encode('utf-8')
    encoded += b' ' * (-len(encoded) % 4)
    while len(char_bin) % 4 != 0:
        char_bin.append(0)

    result = bytearray(b'glTF')
    result.extend(struct.pack('<II', 2, 20 + len(encoded) + 8 + len(char_bin)))
    result.extend(struct.pack('<I4s', len(encoded), b'JSON'))
    result.extend(encoded)
    result.extend(struct.pack('<I4s', len(char_bin), b'BIN\x00'))
    result.extend(char_bin)

    out_path.write_bytes(result)
    print(f'Baked {len(new_anims)} animation entries into {out_path.name} ({len(result) // 1024} KiB)')

def main():
    root = Path(__file__).resolve().parent.parent
    models = root / 'assets' / 'models'
    ual = models / 'ual1.glb'
    assert ual.exists(), f'Missing {ual}'

    for name in ['boy', 'girl']:
        target = models / f'{name}.glb'
        print(f'Processing {name}...')
        bake_animations(target, ual, target)

if __name__ == '__main__':
    main()
