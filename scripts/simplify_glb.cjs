const fs = require('fs');
const MeshoptSimplifier = require('meshoptimizer/meshopt_simplifier');

function unpack(path) {
  const glb = fs.readFileSync(path);
  if (glb.toString('ascii', 0, 4) !== 'glTF') throw new Error('Expected GLB');
  const jsonLength = glb.readUInt32LE(12);
  const json = JSON.parse(glb.toString('utf8', 20, 20 + jsonLength));
  return { json, binary: glb.subarray(28 + jsonLength) };
}
function pack(path, json, binary) {
  let encoded = Buffer.from(JSON.stringify(json));
  encoded = Buffer.concat([encoded, Buffer.alloc((4 - encoded.length % 4) % 4, 0x20)]);
  binary = Buffer.concat([binary, Buffer.alloc((4 - binary.length % 4) % 4)]);
  const header = Buffer.alloc(20);
  header.write('glTF'); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + encoded.length + 8 + binary.length, 8);
  header.writeUInt32LE(encoded.length, 12); header.write('JSON', 16);
  const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(binary.length, 0); binHeader.write('BIN\0', 4);
  fs.writeFileSync(path, Buffer.concat([header, encoded, binHeader, binary]));
}

async function main() {
  await MeshoptSimplifier.ready;
  const [source, output, targetTriangles = '120000'] = process.argv.slice(2);
  const { json, binary } = unpack(source);
  const primitive = json.meshes[0].primitives[0];
  const viewData = index => {
    const accessor = json.accessors[index];
    const view = json.bufferViews[accessor.bufferView];
    if (accessor.byteOffset || view.byteStride) throw new Error('Interleaved/sparse accessors not supported');
    const length = accessor.count * (accessor.type === 'VEC3' ? 3 : accessor.type === 'VEC2' ? 2 : 1) * 4;
    return binary.subarray(view.byteOffset || 0, (view.byteOffset || 0) + length);
  };
  const posData = viewData(primitive.attributes.POSITION);
  const positions = new Float32Array(posData.buffer, posData.byteOffset, posData.length / 4);
  const indexData = viewData(primitive.indices);
  const indices = new Uint32Array(indexData.buffer, indexData.byteOffset, indexData.length / 4);
  const target = Math.min(indices.length, Number(targetTriangles) * 3);
  const [simplified, error] = MeshoptSimplifier.simplify(indices, positions, 3, target, 0.3);
  const [remap, vertexCount] = MeshoptSimplifier.compactMesh(simplified);
  console.log({ beforeTriangles: indices.length / 3, afterTriangles: simplified.length / 3, vertexCount, error });
  const pieces = []; const views = []; const accessors = [];
  let length = 0;
  const append = (data, target) => {
    const aligned = (length + 3) & ~3;
    if (aligned > length) pieces.push(Buffer.alloc(aligned - length));
    length = aligned;
    const viewIndex = views.length;
    views.push({ buffer: 0, byteOffset: length, byteLength: data.length, ...(target ? { target } : {}) });
    pieces.push(data); length += data.length;
    return viewIndex;
  };
  const attributes = {};
  for (const [semantic, oldIndex] of Object.entries(primitive.attributes)) {
    const oldAccessor = json.accessors[oldIndex];
    if (oldAccessor.componentType !== 5126) throw new Error(`Unsupported ${semantic}`);
    const sourceData = viewData(oldIndex);
    const stride = sourceData.length / oldAccessor.count;
    const compacted = Buffer.alloc(vertexCount * stride);
    for (let old = 0; old < oldAccessor.count; old++) {
      const next = remap[old];
      if (next !== 0xffffffff) sourceData.copy(compacted, next * stride, old * stride, (old + 1) * stride);
    }
    const accessor = { ...oldAccessor, bufferView: append(compacted, 34962), count: vertexCount };
    if (semantic === 'POSITION') {
      accessor.min = [Infinity, Infinity, Infinity]; accessor.max = [-Infinity, -Infinity, -Infinity];
      for (let v = 0; v < vertexCount; v++) for (let c = 0; c < 3; c++) {
        const value = compacted.readFloatLE(v * 12 + c * 4);
        accessor.min[c] = Math.min(accessor.min[c], value); accessor.max[c] = Math.max(accessor.max[c], value);
      }
    }
    attributes[semantic] = accessors.push(accessor) - 1;
  }
  const newIndices = Buffer.from(simplified.buffer, simplified.byteOffset, simplified.byteLength);
  const indexAccessor = accessors.push({ bufferView: append(newIndices, 34963), componentType: 5125, count: simplified.length, type: 'SCALAR' }) - 1;
  for (const image of json.images || []) {
    const oldView = json.bufferViews[image.bufferView];
    const data = binary.subarray(oldView.byteOffset || 0, (oldView.byteOffset || 0) + oldView.byteLength);
    image.bufferView = append(data);
  }
  json.meshes[0].primitives[0] = { ...primitive, attributes, indices: indexAccessor };
  json.accessors = accessors; json.bufferViews = views; json.buffers = [{ byteLength: length }];
  pack(output, json, Buffer.concat(pieces));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
