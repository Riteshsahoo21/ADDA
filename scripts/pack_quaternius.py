"""Package the official Quaternius CC0 Standard glTF pair as self-contained GLBs."""
import json, struct, sys, zipfile
from pathlib import Path

archive = zipfile.ZipFile(sys.argv[1])
base = 'Universal Base Characters[Standard]/Base Characters/Godot - UE/'
out = Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)

for gender, source in [('boy', 'Superhero_Male_FullBody'), ('girl', 'Superhero_Female_FullBody')]:
    doc = json.loads(archive.read(base + source + '.gltf'))
    assert len(doc['buffers']) == 1
    binary = bytearray(archive.read(base + doc['buffers'][0].pop('uri')))
    for image in doc.get('images', []):
        name = image.pop('uri')
        while len(binary) % 4: binary.append(0)
        offset = len(binary)
        try:
            payload = archive.read(base + name)
        except KeyError:
            payload = archive.read(base + name.replace('_png.png', '.png'))
        binary.extend(payload)
        image['bufferView'] = len(doc['bufferViews'])
        doc['bufferViews'].append({'buffer': 0, 'byteOffset': offset, 'byteLength': len(payload)})
    doc['buffers'][0]['byteLength'] = len(binary)
    encoded = json.dumps(doc, separators=(',', ':')).encode()
    encoded += b' ' * (-len(encoded) % 4)
    binary.extend(b'\x00' * (-len(binary) % 4))
    result = bytearray(b'glTF')
    result.extend(struct.pack('<II', 2, 20 + len(encoded) + 8 + len(binary)))
    result.extend(struct.pack('<I4s', len(encoded), b'JSON'))
    result.extend(encoded)
    result.extend(struct.pack('<I4s', len(binary), b'BIN\x00'))
    result.extend(binary)
    (out / f'{gender}.glb').write_bytes(result)
    print(gender, len(result) // 1024, 'KiB')
