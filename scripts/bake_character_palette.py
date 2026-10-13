"""Bake Kenney's tiny palette PNG into GLB vertex colors for native Expo GL.

Three's browser image loader cannot decode GLB PNGs in React Native. This keeps
the original mesh, rig and animations while replacing the palette texture.
"""

from io import BytesIO
from pathlib import Path
import json
import struct

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'assets/models/character-male-a.glb'
DEST = ROOT / 'assets/models/character-male-a-native.glb'

source = SOURCE.read_bytes()
assert source[:4] == b'glTF'
json_size = struct.unpack_from('<I', source, 12)[0]
data = json.loads(source[20:20 + json_size])
bin_header = 20 + json_size
assert source[bin_header + 4:bin_header + 8] == b'BIN\0'
binary = bytearray(source[bin_header + 8:bin_header + 8 + struct.unpack_from('<I', source, bin_header)[0]])
image_view = data['bufferViews'][data['images'][0]['bufferView']]
palette = Image.open(BytesIO(binary[image_view['byteOffset']:image_view['byteOffset'] + image_view['byteLength']])).convert('RGB')
width, height = palette.size

for mesh in data['meshes']:
    for primitive in mesh['primitives']:
        uv_accessor = data['accessors'][primitive['attributes']['TEXCOORD_0']]
        uv_view = data['bufferViews'][uv_accessor['bufferView']]
        offset = uv_view.get('byteOffset', 0) + uv_accessor.get('byteOffset', 0)
        stride = uv_view.get('byteStride', 8)
        colors = bytearray()
        for index in range(uv_accessor['count']):
            u, v = struct.unpack_from('<ff', binary, offset + index * stride)
            x = min(width - 1, max(0, int((u % 1) * width)))
            # glTF images use a top-left UV origin; unlike a regular OpenGL
            # texture, GLTFLoader uploads them without a vertical flip.
            y = min(height - 1, max(0, int((v % 1) * height)))
            colors.extend(palette.getpixel((x, y)))
        while len(binary) % 4:
            binary.append(0)
        view_index = len(data['bufferViews'])
        data['bufferViews'].append({'buffer': 0, 'byteOffset': len(binary), 'byteLength': len(colors), 'target': 34962})
        binary.extend(colors)
        accessor_index = len(data['accessors'])
        data['accessors'].append({'bufferView': view_index, 'componentType': 5121, 'normalized': True, 'count': uv_accessor['count'], 'type': 'VEC3'})
        primitive['attributes']['COLOR_0'] = accessor_index

material = data['materials'][0]
material['pbrMetallicRoughness'].pop('baseColorTexture', None)
material['pbrMetallicRoughness']['baseColorFactor'] = [1, 1, 1, 1]
data.pop('images', None)
data.pop('textures', None)
data.pop('samplers', None)
data.pop('extensionsUsed', None)
data['buffers'][0]['byteLength'] = len(binary)
while len(binary) % 4:
    binary.append(0)
encoded = json.dumps(data, separators=(',', ':')).encode('utf-8')
encoded += b' ' * (-len(encoded) % 4)
total = 12 + 8 + len(encoded) + 8 + len(binary)
DEST.write_bytes(b'glTF' + struct.pack('<II', 2, total) + struct.pack('<I4s', len(encoded), b'JSON') + encoded + struct.pack('<I4s', len(binary), b'BIN\0') + binary)
print(f'{DEST.name}: {width}x{height} palette baked into vertex colors, {len(binary)} binary bytes')
