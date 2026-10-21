"""Build a realistic 3D road, curb, sidewalk, and terrain ground GLB for the Tea Party scene.

Uses photorealistic CC0 PBR textures:
- Asphalt road with baked center dashed yellow line and white border markings
- Weathered concrete paver sidewalks & raised curbs for the chai stall and shops
- Natural undulating grass/soil terrain spanning 52m x 52m
"""
import json, math, struct
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

def build_road_texture(source_asphalt: Path, out_path: Path):
    base = Image.open(source_asphalt).convert('RGBA')
    w, h = base.size

    overlay = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    # Yellow center dashed stripe (at U = 0.5)
    center_x = w // 2
    dash_w = int(w * 0.024)  # ~0.15m wide
    draw.rectangle(
        [center_x - dash_w // 2, int(h * 0.18), center_x + dash_w // 2, int(h * 0.82)],
        fill=(230, 175, 55, 230)
    )

    # White solid shoulder lines (at U ~ 0.06 and U ~ 0.94)
    edge_w = int(w * 0.018)
    left_x = int(w * 0.06)
    right_x = int(w * 0.94)
    draw.rectangle([left_x - edge_w // 2, 0, left_x + edge_w // 2, h], fill=(235, 235, 235, 220))
    draw.rectangle([right_x - edge_w // 2, 0, right_x + edge_w // 2, h], fill=(235, 235, 235, 220))

    # Subtle darker wheel wear paths (U ~ 0.27 and U ~ 0.73)
    wear_overlay = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    wear_draw = ImageDraw.Draw(wear_overlay)
    wear_w = int(w * 0.12)
    wear_draw.rectangle([int(w * 0.27) - wear_w // 2, 0, int(w * 0.27) + wear_w // 2, h], fill=(16, 16, 16, 40))
    wear_draw.rectangle([int(w * 0.73) - wear_w // 2, 0, int(w * 0.73) + wear_w // 2, h], fill=(16, 16, 16, 40))
    wear_overlay = wear_overlay.filter(ImageFilter.GaussianBlur(14))

    comp = Image.alpha_composite(base, wear_overlay)
    comp = Image.alpha_composite(comp, overlay)
    comp.convert('RGB').save(out_path, format='JPEG', quality=92)
    print(f'Wrote {out_path.name}')

def build_sidewalk_texture(source_concrete: Path, out_path: Path):
    base = Image.open(source_concrete).convert('RGBA')
    w, h = base.size

    # Add subtle paver grid lines for authentic square paving slabs
    overlay = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    grid_size = w // 2  # 2x2 large slabs per tile
    for i in range(1, 2):
        draw.line([(0, i * grid_size), (w, i * grid_size)], fill=(30, 28, 26, 70), width=3)
        draw.line([(i * grid_size, 0), (i * grid_size, h)], fill=(30, 28, 26, 70), width=3)
    overlay = overlay.filter(ImageFilter.GaussianBlur(1))

    comp = Image.alpha_composite(base, overlay)
    comp.convert('RGB').save(out_path, format='JPEG', quality=92)
    print(f'Wrote {out_path.name}')

class GlbBuilder:
    def __init__(self):
        self.bin = bytearray()
        self.buffer_views = []
        self.accessors = []
        self.materials = []
        self.textures = []
        self.images = []
        self.samplers = [{
            'magFilter': 9729,  # LINEAR
            'minFilter': 9987,  # LINEAR_MIPMAP_LINEAR
            'wrapS': 10497,     # REPEAT
            'wrapT': 10497      # REPEAT
        }]
        self.meshes = []
        self.nodes = []

    def add_image_from_file(self, img_path: Path) -> int:
        data = img_path.read_bytes()
        mime = 'image/jpeg' if img_path.suffix.lower() in ['.jpg', '.jpeg'] else 'image/png'
        while len(self.bin) % 4 != 0:
            self.bin.append(0)
        offset = len(self.bin)
        self.bin.extend(data)

        bv_idx = len(self.buffer_views)
        self.buffer_views.append({
            'buffer': 0,
            'byteOffset': offset,
            'byteLength': len(data)
        })

        img_idx = len(self.images)
        self.images.append({
            'bufferView': bv_idx,
            'mimeType': mime
        })

        tex_idx = len(self.textures)
        self.textures.append({
            'sampler': 0,
            'source': img_idx
        })
        return tex_idx

    def add_material(self, name: str, texture_idx: int, roughness: float = 0.8, double_sided: bool = False) -> int:
        mat_idx = len(self.materials)
        self.materials.append({
            'name': name,
            'pbrMetallicRoughness': {
                'baseColorTexture': {'index': texture_idx},
                'metallicFactor': 0.05,
                'roughnessFactor': roughness
            },
            'doubleSided': double_sided
        })
        return mat_idx

    def add_buffer_data(self, data: bytes, target: int = None) -> int:
        while len(self.bin) % 4 != 0:
            self.bin.append(0)
        offset = len(self.bin)
        self.bin.extend(data)
        bv_idx = len(self.buffer_views)
        bv_def = {
            'buffer': 0,
            'byteOffset': offset,
            'byteLength': len(data)
        }
        if target:
            bv_def['target'] = target
        self.buffer_views.append(bv_def)
        return bv_idx

    def add_accessor(self, bv_idx: int, component_type: int, count: int, acc_type: str, min_v=None, max_v=None) -> int:
        acc_idx = len(self.accessors)
        acc_def = {
            'bufferView': bv_idx,
            'byteOffset': 0,
            'componentType': component_type,
            'count': count,
            'type': acc_type
        }
        if min_v is not None:
            acc_def['min'] = min_v
        if max_v is not None:
            acc_def['max'] = max_v
        self.accessors.append(acc_def)
        return acc_idx

    def add_mesh_primitive(self, name: str, positions, normals, uvs, indices, material_idx: int):
        pos_bytes = bytearray()
        min_p = [float('inf'), float('inf'), float('inf')]
        max_p = [float('-inf'), float('-inf'), float('-inf')]
        for p in positions:
            pos_bytes.extend(struct.pack('<fff', p[0], p[1], p[2]))
            for i in range(3):
                min_p[i] = min(min_p[i], p[i])
                max_p[i] = max(max_p[i], p[i])
        pos_bv = self.add_buffer_data(pos_bytes, target=34962)
        pos_acc = self.add_accessor(pos_bv, 5126, len(positions), 'VEC3', min_p, max_p)

        norm_bytes = bytearray()
        for n in normals:
            norm_bytes.extend(struct.pack('<fff', n[0], n[1], n[2]))
        norm_bv = self.add_buffer_data(norm_bytes, target=34962)
        norm_acc = self.add_accessor(norm_bv, 5126, len(normals), 'VEC3')

        uv_bytes = bytearray()
        for u in uvs:
            uv_bytes.extend(struct.pack('<ff', u[0], u[1]))
        uv_bv = self.add_buffer_data(uv_bytes, target=34962)
        uv_acc = self.add_accessor(uv_bv, 5126, len(uvs), 'VEC2')

        idx_bytes = bytearray()
        for idx in indices:
            idx_bytes.extend(struct.pack('<I', idx))
        idx_bv = self.add_buffer_data(idx_bytes, target=34963)
        idx_acc = self.add_accessor(idx_bv, 5125, len(indices), 'SCALAR')

        mesh_idx = len(self.meshes)
        self.meshes.append({
            'name': name,
            'primitives': [{
                'attributes': {
                    'POSITION': pos_acc,
                    'NORMAL': norm_acc,
                    'TEXCOORD_0': uv_acc
                },
                'indices': idx_acc,
                'material': material_idx
            }]
        })

        node_idx = len(self.nodes)
        self.nodes.append({
            'name': name,
            'mesh': mesh_idx
        })
        return node_idx

    def export(self, out_path: Path):
        doc = {
            'asset': {'version': '2.0', 'generator': 'ADDA Tea Ground Builder'},
            'scene': 0,
            'scenes': [{'nodes': list(range(len(self.nodes)))}],
            'nodes': self.nodes,
            'meshes': self.meshes,
            'materials': self.materials,
            'textures': self.textures,
            'images': self.images,
            'samplers': self.samplers,
            'accessors': self.accessors,
            'bufferViews': self.buffer_views,
            'buffers': [{'byteLength': len(self.bin)}]
        }

        encoded_json = json.dumps(doc, separators=(',', ':')).encode('utf-8')
        encoded_json += b' ' * (-len(encoded_json) % 4)

        while len(self.bin) % 4 != 0:
            self.bin.append(0)

        total_len = 12 + 8 + len(encoded_json) + 8 + len(self.bin)
        res = bytearray(b'glTF')
        res.extend(struct.pack('<II', 2, total_len))
        res.extend(struct.pack('<I4s', len(encoded_json), b'JSON'))
        res.extend(encoded_json)
        res.extend(struct.pack('<I4s', len(self.bin), b'BIN\x00'))
        res.extend(self.bin)

        out_path.write_bytes(res)
        print(f'Wrote {out_path.name}: {len(res) // 1024} KiB ({len(self.meshes)} meshes, {len(self.images)} textures)')

def build_scene():
    root = Path(__file__).resolve().parent.parent
    raw_dir = root / 'assets' / 'raw_textures'
    models_dir = root / 'assets' / 'models'

    asphalt_source = raw_dir / 'asphalt_diff.jpg'
    asphalt_marked = raw_dir / 'asphalt_road_diff.jpg'
    build_road_texture(asphalt_source, asphalt_marked)

    concrete_source = raw_dir / 'concrete_diff.jpg'
    sidewalk_paver = raw_dir / 'concrete_sidewalk_pavers.jpg'
    build_sidewalk_texture(concrete_source, sidewalk_paver)

    builder = GlbBuilder()
    tex_road = builder.add_image_from_file(asphalt_marked)
    tex_concrete = builder.add_image_from_file(sidewalk_paver)
    tex_ground = builder.add_image_from_file(raw_dir / 'forest_diff.jpg')

    mat_road = builder.add_material('Road_Asphalt', tex_road, roughness=0.82)
    mat_concrete = builder.add_material('Curb_Sidewalk', tex_concrete, roughness=0.78, double_sided=True)
    mat_ground = builder.add_material('Terrain_Ground', tex_ground, roughness=0.95)

    # ----------------------------------------------------
    # 1. ROAD (Crowned 6.3m wide road from z=-24 to z=+24)
    # ----------------------------------------------------
    road_x = [-3.15, -1.575, 0.0, 1.575, 3.15]
    road_y = [0.005, 0.011, 0.015, 0.011, 0.005]
    road_u = [0.0, 0.25, 0.50, 0.75, 1.0]

    road_z_steps = 27
    # Confine the road and ground strictly to the enclosed hangout area inside the fence.
    # Nothing extends past the fence perimeter at z = ±13.0m and x = ±13.0m.
    z_min, z_max = -13.0, 13.0
    v_repeats = 16.0

    road_pos = []
    road_norm = []
    road_uv = []
    road_idx = []

    for zi in range(road_z_steps):
        t_z = zi / (road_z_steps - 1)
        z = z_min + t_z * (z_max - z_min)
        v = t_z * v_repeats
        for xi in range(len(road_x)):
            road_pos.append([road_x[xi], road_y[xi], z])
            road_norm.append([0.0, 1.0, 0.0])
            road_uv.append([road_u[xi], v])

    cols = len(road_x)
    for zi in range(road_z_steps - 1):
        for xi in range(cols - 1):
            i0 = zi * cols + xi
            i1 = i0 + 1
            i2 = (zi + 1) * cols + xi
            i3 = i2 + 1
            road_idx.extend([i0, i2, i1, i1, i2, i3])

    builder.add_mesh_primitive('Asphalt_Road', road_pos, road_norm, road_uv, road_idx, mat_road)

    # ----------------------------------------------------
    # 2. RAISED CURBS (Left at x=-3.15 to -3.45, Right at x=3.15 to 3.45)
    # ----------------------------------------------------
    curb_pos = []
    curb_norm = []
    curb_uv = []
    curb_idx = []

    def add_curb_strip(x_inner, x_outer, facing_road_sign):
        base_v = len(curb_pos)
        z_steps = 27
        c_v_repeats = 16.0
        for zi in range(z_steps):
            tz = zi / (z_steps - 1)
            z = z_min + tz * (z_max - z_min)
            v = tz * c_v_repeats

            # P0: road contact
            curb_pos.append([x_inner, 0.005, z])
            curb_norm.append([facing_road_sign, 0.0, 0.0])
            curb_uv.append([0.0, v])

            # P1: curb bevel top inner
            curb_pos.append([x_inner, 0.12, z])
            curb_norm.append([facing_road_sign * 0.707, 0.707, 0.0])
            curb_uv.append([0.35, v])

            # P2: curb top outer
            curb_pos.append([x_outer, 0.12, z])
            curb_norm.append([0.0, 1.0, 0.0])
            curb_uv.append([1.0, v])

        for zi in range(z_steps - 1):
            r0 = base_v + zi * 3
            r1 = r0 + 3
            if facing_road_sign > 0:
                curb_idx.extend([r0, r0 + 1, r1, r1, r0 + 1, r1 + 1])
                curb_idx.extend([r0 + 1, r0 + 2, r1 + 1, r1 + 1, r0 + 2, r1 + 2])
            else:
                curb_idx.extend([r0, r1, r0 + 1, r0 + 1, r1, r1 + 1])
                curb_idx.extend([r0 + 1, r1 + 1, r0 + 2, r0 + 2, r1 + 1, r1 + 2])

    add_curb_strip(-3.15, -3.45, 1.0)
    add_curb_strip(3.15, 3.45, -1.0)

    # ----------------------------------------------------
    # 3. SIDEWALKS (Strictly within fence z=-13.0 to z=+13.0)
    # ----------------------------------------------------
    def add_sidewalk(x_min_v, x_max_v, z_start, z_end):
        base_v = len(curb_pos)
        xs = 8
        zs = 24
        width = x_max_v - x_min_v
        length = z_end - z_start
        u_rep = width / 1.5
        v_rep = length / 1.5

        for zi in range(zs):
            tz = zi / (zs - 1)
            z = z_start + tz * length
            v = tz * v_rep
            for xi in range(xs):
                tx = xi / (xs - 1)
                x = x_min_v + tx * width
                u = tx * u_rep
                curb_pos.append([x, 0.11, z])
                curb_norm.append([0.0, 1.0, 0.0])
                curb_uv.append([u, v])

        for zi in range(zs - 1):
            for xi in range(xs - 1):
                i0 = base_v + zi * xs + xi
                i1 = i0 + 1
                i2 = base_v + (zi + 1) * xs + xi
                i3 = i2 + 1
                curb_idx.extend([i0, i2, i1, i1, i2, i3])

    add_sidewalk(-10.5, -3.45, z_min, z_max)
    add_sidewalk(3.45, 10.5, z_min, z_max)

    builder.add_mesh_primitive('Curbs_And_Sidewalks', curb_pos, curb_norm, curb_uv, curb_idx, mat_concrete)

    # ----------------------------------------------------
    # 4. NATURAL GROUND (FLANKING SIDES STRICTLY WITHIN FENCE)
    #    Confined within x = ±13.0 and z = ±13.0
    # ----------------------------------------------------
    ground_pos = []
    ground_norm = []
    ground_uv = []
    ground_idx = []

    def add_ground_flank(x_min_v, x_max_v, z_start, z_end):
        base_v = len(ground_pos)
        xs = 6
        zs = 20
        width = x_max_v - x_min_v
        length = z_end - z_start
        u_rep = width / 2.0
        v_rep = length / 2.0

        for zi in range(zs):
            tz = zi / (zs - 1)
            z = z_start + tz * length
            v = tz * v_rep
            for xi in range(xs):
                tx = xi / (xs - 1)
                x = x_min_v + tx * width
                u = tx * u_rep
                dist_from_sidewalk = (x - x_min_v) / width if x_min_v > 0 else (x_max_v - x) / width
                y = max(0.0, 0.08 - dist_from_sidewalk * 0.08)
                ground_pos.append([x, y, z])
                ground_norm.append([0.0, 1.0, 0.0])
                ground_uv.append([u, v])

        for zi in range(zs - 1):
            for xi in range(xs - 1):
                i0 = base_v + zi * xs + xi
                i1 = i0 + 1
                i2 = base_v + (zi + 1) * xs + xi
                i3 = i2 + 1
                ground_idx.extend([i0, i2, i1, i1, i2, i3])

    # Confine terrain flank to strictly within fence perimeter:
    add_ground_flank(-13.0, -10.5, z_min, z_max)
    add_ground_flank(10.5, 13.0, z_min, z_max)

    builder.add_mesh_primitive('Natural_Ground_Terrain', ground_pos, ground_norm, ground_uv, ground_idx, mat_ground)

    out_glb = models_dir / 'tea-ground.glb'
    builder.export(out_glb)

if __name__ == '__main__':
    build_scene()
