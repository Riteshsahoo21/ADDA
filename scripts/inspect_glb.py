import json, struct, sys, zipfile
from pathlib import Path

def info(data):
    if data[:4] != b'glTF': raise ValueError('Not GLB')
    length = struct.unpack_from('<I', data, 12)[0]
    doc = json.loads(data[20:20+length])
    nodes = doc.get('nodes', [])
    meshes = doc.get('meshes', [])
    accessors = doc.get('accessors', [])
    positions = [accessors[p['attributes']['POSITION']] for m in meshes for p in m['primitives'] if 'POSITION' in p['attributes']]
    textures = [x.get('mimeType', x.get('uri', '?')) for x in doc.get('images', [])]
    tris = sum((accessors[p['indices']]['count']//3 if 'indices' in p else accessors[p['attributes']['POSITION']]['count']//3) for m in meshes for p in m['primitives'])
    print(json.dumps({'bytes': len(data), 'meshes': len(meshes), 'nodes': len(nodes), 'primitives': len(positions), 'vertices': sum(a['count'] for a in positions), 'triangles': tris, 'animations': [a.get('name') for a in doc.get('animations',[])], 'images': textures, 'materials': len(doc.get('materials',[])), 'extensions': doc.get('extensionsRequired', []), 'bounds': [{'min': a.get('min'), 'max': a.get('max')} for a in positions[:8]], 'extras': doc.get('asset',{}).get('extras')}, indent=2))

for path in sys.argv[1:]:
    p = Path(path)
    print('\n', p)
    if p.suffix == '.zip':
        with zipfile.ZipFile(p) as z:
            for name in z.namelist():
                if name.endswith('.glb'):
                    print(name)
                    info(z.read(name))
    else: info(p.read_bytes())
