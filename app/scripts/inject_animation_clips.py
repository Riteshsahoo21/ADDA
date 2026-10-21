"""Append local Three.js animation clips to a rigged GLB."""
import json
import re
import struct
import sys
from pathlib import Path

source = Path(sys.argv[1])
clips_file = Path(sys.argv[2])
destination = Path(sys.argv[3])
data = source.read_bytes()
assert data[:4] == b'glTF'
json_length = struct.unpack_from('<I', data, 12)[0]
doc = json.loads(data[20:20 + json_length])
binary_offset = 28 + json_length
binary_length = struct.unpack_from('<I', data, 20 + json_length)[0]
binary = bytearray(data[binary_offset:binary_offset + binary_length])
nodes = {}
for index, node in enumerate(doc['nodes']):
    name = node.get('name')
    if name:
        nodes[name] = index
        nodes[name.replace(':', '')] = index
animations = []

def accessor(values, components):
    while len(binary) % 4:
        binary.append(0)
    offset = len(binary)
    binary.extend(struct.pack('<' + 'f' * len(values), *values))
    view_index = len(doc['bufferViews'])
    doc['bufferViews'].append({'buffer': 0, 'byteOffset': offset, 'byteLength': len(values) * 4})
    entry = {
        'bufferView': view_index,
        'componentType': 5126,
        'count': len(values) // components,
        'type': 'VEC4' if components == 4 else 'VEC3' if components == 3 else 'SCALAR',
    }
    if components == 1:
        entry['min'] = [min(values)]
        entry['max'] = [max(values)]
    index = len(doc['accessors'])
    doc['accessors'].append(entry)
    return index

for clip in json.loads(clips_file.read_text()):
    animation = {'name': clip['name'], 'samplers': [], 'channels': []}
    for track in clip['tracks']:
        match = re.fullmatch(r'\.bones\[([^]]+)\]\.(quaternion|position|scale)', track['name'])
        if not match:
            raise ValueError(f'Unsupported track: {track["name"]}')
        bone, property_name = match.groups()
        if bone not in nodes:
            raise ValueError(f'Missing target bone: {bone}')
        components = 4 if property_name == 'quaternion' else 3
        if len(track['values']) != len(track['times']) * components:
            raise ValueError(f'Incorrect track size: {track["name"]}')
        input_index = accessor(track['times'], 1)
        output_index = accessor(track['values'], components)
        sampler_index = len(animation['samplers'])
        animation['samplers'].append({'input': input_index, 'output': output_index, 'interpolation': 'LINEAR'})
        animation['channels'].append({'sampler': sampler_index, 'target': {'node': nodes[bone], 'path': 'rotation' if property_name == 'quaternion' else 'translation' if property_name == 'position' else 'scale'}})
    animations.append(animation)

doc['animations'] = animations
doc['buffers'][0]['byteLength'] = len(binary)
while len(binary) % 4:
    binary.append(0)
json_bytes = json.dumps(doc, separators=(',', ':')).encode('utf-8')
json_bytes += b' ' * (-len(json_bytes) % 4)
total = 12 + 8 + len(json_bytes) + 8 + len(binary)
destination.write_bytes(b'glTF' + struct.pack('<II', 2, total) + struct.pack('<I4s', len(json_bytes), b'JSON') + json_bytes + struct.pack('<I4s', len(binary), b'BIN\0') + binary)
print(f'{destination}: {len(animations)} clips, {len(binary) / 1024 / 1024:.1f} MiB binary')
