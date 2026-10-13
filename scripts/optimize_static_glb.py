"""Flatten a static Sketchfab GLB into one mesh per material for mobile rendering.

Keeps the original materials, samplers, and embedded images. The source file is
left intact for attribution and reprocessing. Animated or skinned GLBs are not
supported by this small offline converter.
"""

import copy
import json
import struct
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np


source, output = map(Path, sys.argv[1:3])
keep_materials = {int(value) for value in sys.argv[3].split(',')} if len(sys.argv) > 3 else None
raw = source.read_bytes()
if raw[:4] != b'glTF':
    raise ValueError('Expected GLB')
json_length = struct.unpack_from('<I', raw, 12)[0]
document = json.loads(raw[20:20 + json_length])
binary_start = 28 + json_length
if document.get('animations') or document.get('skins'):
    raise ValueError('Only static unskinned models are supported')


def read_accessor(index):
    accessor = document['accessors'][index]
    view = document['bufferViews'][accessor['bufferView']]
    dtype = {5126: np.dtype('<f4'), 5125: np.dtype('<u4'), 5123: np.dtype('<u2')}[accessor['componentType']]
    columns = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}[accessor['type']]
    offset = binary_start + view.get('byteOffset', 0) + accessor.get('byteOffset', 0)
    stride = view.get('byteStride', dtype.itemsize * columns)
    return np.ndarray((accessor['count'], columns), dtype=dtype, buffer=raw, offset=offset,
                      strides=(stride, dtype.itemsize)).copy()


def node_matrix(node):
    if 'matrix' in node:
        return np.array(node['matrix'], dtype=np.float64).reshape(4, 4, order='F')
    result = np.eye(4, dtype=np.float64)
    if 'rotation' in node:
        x, y, z, w = node['rotation']
        result[:3, :3] = [
            [1 - 2 * (y*y + z*z), 2 * (x*y - z*w), 2 * (x*z + y*w)],
            [2 * (x*y + z*w), 1 - 2 * (x*x + z*z), 2 * (y*z - x*w)],
            [2 * (x*z - y*w), 2 * (y*z + x*w), 1 - 2 * (x*x + y*y)],
        ]
    result[:3, :3] *= np.array(node.get('scale', [1, 1, 1]), dtype=np.float64)
    result[:3, 3] = node.get('translation', [0, 0, 0])
    return result


groups = defaultdict(lambda: defaultdict(list))


def visit(node_index, parent_matrix):
    node = document['nodes'][node_index]
    matrix = parent_matrix @ node_matrix(node)
    if 'mesh' in node:
        for primitive in document['meshes'][node['mesh']]['primitives']:
            if keep_materials is not None and primitive.get('material', -1) not in keep_materials:
                continue
            if primitive.get('mode', 4) != 4:
                raise ValueError('Only triangle primitives are supported')
            attrs = primitive['attributes']
            signature = (primitive.get('material', -1), tuple(sorted(attrs)))
            positions = read_accessor(attrs['POSITION']).astype(np.float64)
            positions = positions @ matrix[:3, :3].T + matrix[:3, 3]
            normal_matrix = np.linalg.inv(matrix[:3, :3]).T
            normals = read_accessor(attrs['NORMAL']).astype(np.float64) @ normal_matrix.T
            normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-10)
            index = read_accessor(primitive['indices']).reshape(-1).astype(np.uint32)
            batch = groups[signature]
            start = sum(len(points) for points in batch['POSITION'])
            batch['POSITION'].append(positions.astype('<f4'))
            batch['NORMAL'].append(normals.astype('<f4'))
            for name in attrs:
                if name not in ('POSITION', 'NORMAL'):
                    batch[name].append(read_accessor(attrs[name]).astype('<f4'))
            batch['indices'].append(index + start)
    for child in node.get('children', []):
        visit(child, matrix)


for root in document['scenes'][document.get('scene', 0)]['nodes']:
    visit(root, np.eye(4, dtype=np.float64))

result = {key: copy.deepcopy(document[key]) for key in ('asset', 'materials', 'textures', 'samplers', 'images') if key in document}
result.update({'scene': 0, 'scenes': [{'nodes': []}], 'nodes': [], 'meshes': [], 'accessors': [], 'bufferViews': [], 'buffers': [{'byteLength': 0}]})
payload = bytearray()


def add_bytes(data, target=None):
    payload.extend(b'\0' * (-len(payload) % 4))
    view = {'buffer': 0, 'byteOffset': len(payload), 'byteLength': len(data)}
    if target is not None:
        view['target'] = target
    result['bufferViews'].append(view)
    payload.extend(data)
    return len(result['bufferViews']) - 1


def add_array(values, kind, target, bounds=False):
    values = np.ascontiguousarray(values)
    accessor = {'bufferView': add_bytes(values.tobytes(), target), 'componentType': 5125 if kind == 'SCALAR' else 5126,
                'count': len(values), 'type': kind}
    if bounds:
        accessor['min'] = values.min(axis=0).astype(float).tolist()
        accessor['max'] = values.max(axis=0).astype(float).tolist()
    result['accessors'].append(accessor)
    return len(result['accessors']) - 1


for (material, names), batches in groups.items():
    attrs = {}
    for name in names:
        merged = np.concatenate(batches[name])
        attrs[name] = add_array(merged, 'VEC3' if name in ('POSITION', 'NORMAL') else 'VEC2', 34962, name == 'POSITION')
    indices = np.concatenate(batches['indices']).astype('<u4')
    primitive = {'attributes': attrs, 'indices': add_array(indices, 'SCALAR', 34963)}
    if material >= 0:
        primitive['material'] = material
    result['meshes'].append({'primitives': [primitive], 'name': f'merged_material_{material}'})
    result['nodes'].append({'mesh': len(result['meshes']) - 1})
    result['scenes'][0]['nodes'].append(len(result['nodes']) - 1)

for image in result.get('images', []):
    old = document['bufferViews'][image['bufferView']]
    start = binary_start + old.get('byteOffset', 0)
    image['bufferView'] = add_bytes(raw[start:start + old['byteLength']])

result['buffers'][0]['byteLength'] = len(payload)
encoded = json.dumps(result, separators=(',', ':')).encode()
encoded += b' ' * (-len(encoded) % 4)
payload.extend(b'\0' * (-len(payload) % 4))
header = struct.pack('<4sII', b'glTF', 2, 12 + 8 + len(encoded) + 8 + len(payload))
output.write_bytes(header + struct.pack('<I4s', len(encoded), b'JSON') + encoded +
                   struct.pack('<I4s', len(payload), b'BIN\0') + payload)
print(f'{source.name}: {len(document["meshes"])} meshes -> {len(result["meshes"])} meshes, {len(raw)} -> {output.stat().st_size} bytes')
