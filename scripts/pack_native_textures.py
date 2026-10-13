"""Extract embedded GLB images to a raw RGBA pack for Expo GL DataTexture.

GLTFLoader's browser Image/Blob path is unavailable in React Native. We keep
the original GLB intact and bundle predecoded, size-capped pixels beside it.
"""
import io, json, struct, sys
from pathlib import Path
from PIL import Image

source, target, max_edge = Path(sys.argv[1]), Path(sys.argv[2]), int(sys.argv[3])
data = source.read_bytes()
assert data[:4] == b'glTF'
json_length = struct.unpack_from('<I', data, 12)[0]
doc = json.loads(data[20:20 + json_length])
binary_offset = 28 + json_length
pixels = bytearray()
images = []
for entry in doc.get('images', []):
    view = doc['bufferViews'][entry['bufferView']]
    start = binary_offset + view.get('byteOffset', 0)
    encoded = data[start:start + view['byteLength']]
    image = Image.open(io.BytesIO(encoded)).convert('RGBA')
    image.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
    payload = image.tobytes()
    images.append({'offset': len(pixels), 'width': image.width, 'height': image.height})
    pixels.extend(payload)
target.with_suffix('.rgba').write_bytes(pixels)
target.with_suffix('.json').write_text(json.dumps(images, separators=(',', ':')))
print(f'{source.name}: {len(images)} textures, {len(pixels) / 1024 / 1024:.1f} MiB RGBA')
