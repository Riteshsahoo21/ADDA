import * as THREE from 'three';

type Edge = { x: number; z: number; dx: number; dz: number; length: number };

/** Four sides of a small enclosed roadside hangout. */
export function createTeaBoundary(scene: THREE.Scene, halfExtent = 13) {
  const span = halfExtent * 2;
  const edges: Edge[] = [
    { x: -halfExtent, z: -halfExtent, dx: 1, dz: 0, length: span },
    { x: halfExtent, z: halfExtent, dx: -1, dz: 0, length: span },
    { x: halfExtent, z: -halfExtent, dx: 0, dz: 1, length: span },
    { x: -halfExtent, z: halfExtent, dx: 0, dz: -1, length: span },
  ];
  const metal = new THREE.MeshStandardMaterial({ color: '#7d8583', metalness: 0.72, roughness: 0.42 });
  const curbMaterial = new THREE.MeshStandardMaterial({ color: '#85837b', roughness: 0.94 });
  const postGeometry = new THREE.CylinderGeometry(0.046, 0.056, 2.2, 8);
  const postCount = edges.length * 14;
  const posts = new THREE.InstancedMesh(postGeometry, metal, postCount);
  posts.name = 'Tea Party boundary posts';
  const postMatrix = new THREE.Matrix4();
  let postIndex = 0;
  const wirePositions: number[] = [];
  const addWire = (edge: Edge, u0: number, y0: number, u1: number, y1: number) => {
    const low = Math.max(0, -u0 / (u1 - u0));
    const high = Math.min(1, (edge.length - u0) / (u1 - u0));
    if (high <= low) return;
    for (const t of [low, high]) {
      const u = u0 + (u1 - u0) * t;
      wirePositions.push(edge.x + edge.dx * u, y0 + (y1 - y0) * t, edge.z + edge.dz * u);
    }
  };
  for (const edge of edges) {
    for (let i = 0; i <= 13; i++) {
      const u = i * 2;
      postMatrix.makeTranslation(edge.x + edge.dx * u, 1.1, edge.z + edge.dz * u);
      posts.setMatrixAt(postIndex++, postMatrix);
    }
    const alongX = edge.dz === 0;
    for (const height of [0.33, 2.08]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(alongX ? span : 0.055, 0.055, alongX ? 0.055 : span), metal);
      rail.position.set(edge.x + edge.dx * halfExtent, height, edge.z + edge.dz * halfExtent);
      scene.add(rail);
    }
    const curb = new THREE.Mesh(new THREE.BoxGeometry(alongX ? span : 0.2, 0.23, alongX ? 0.2 : span), curbMaterial);
    curb.position.set(edge.x + edge.dx * halfExtent, 0.115, edge.z + edge.dz * halfExtent);
    scene.add(curb);
    for (let u = -1.6; u < edge.length + 1.6; u += 0.27) {
      addWire(edge, u, 0.34, u + 1.55, 2.05);
      addWire(edge, u, 2.05, u + 1.55, 0.34);
    }
  }
  posts.instanceMatrix.needsUpdate = true;
  scene.add(posts);
  const wireGeometry = new THREE.BufferGeometry();
  wireGeometry.setAttribute('position', new THREE.Float32BufferAttribute(wirePositions, 3));
  const wire = new THREE.LineSegments(wireGeometry, new THREE.LineBasicMaterial({ color: '#7f8989', transparent: true, opacity: 0.82 }));
  wire.name = 'Tea Party chain link wire';
  scene.add(wire);
}

/** The supplied Sketchfab maple has already been flattened to two draw calls. */
export function addMapleTrees(scene: THREE.Scene, model: THREE.Group) {
  const sourceBounds = new THREE.Box3().setFromObject(model);
  const height = sourceBounds.getSize(new THREE.Vector3()).y;
  const center = sourceBounds.getCenter(new THREE.Vector3());
  model.scale.setScalar(5.3 / height);
  model.position.set(-center.x * model.scale.x, -sourceBounds.min.y * model.scale.y, -center.z * model.scale.z);
  const template = model.clone(true);
  // Keep every trunk inside the fence and beside the two shop rows. The
  // road occupies x=-3.15..3.15 and remains completely clear.
  const locations = [
    [-11.7, -9.5], [-11.6, -4.6], [-11.7, 3.8], [-11.6, 9.8],
    [11.7, -9.5], [11.6, -4.6], [11.7, 3.8], [11.6, 9.8],
  ];
  for (let index = 0; index < locations.length; index++) {
    const [x, z] = locations[index];
    // Clone the unshifted template. Cloning a tree already placed at -11.7 m
    // made subsequent positions cumulative and put the right-hand trees on
    // the asphalt.
    const tree = template.clone(true);
    tree.name = `Sketchfab maple tree ${index + 1}`;
    tree.position.x += x;
    tree.position.z += z;
    tree.rotation.y = (index * 2.399) % (Math.PI * 2);
    const variation = 0.88 + (index % 4) * 0.075;
    tree.scale.multiplyScalar(variation);
    scene.add(tree);
    if (__DEV__) {
      const bounds = new THREE.Box3().setFromObject(tree);
      console.info('[ADDA tea tree v2]', index, 'trunk', x, z,
        'world x', bounds.min.x.toFixed(2), bounds.max.x.toFixed(2));
    }
  }
}
