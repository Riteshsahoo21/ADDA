import * as THREE from 'three';

const letters: Record<string, string[]> = {
  A: ['01110','10001','10001','11111','10001','10001','10001'],
  F: ['11111','10000','10000','11110','10000','10000','10000'],
  O: ['01110','10001','10001','10001','10001','10001','01110'],
  P: ['11110','10001','10001','11110','10000','10000','10000'],
  R: ['11110','10001','10001','11110','10100','10010','10001'],
  T: ['11111','00100','00100','00100','00100','00100','00100'],
  W: ['10001','10001','10001','10101','10101','10101','01010'],
  Y: ['10001','10001','01010','00100','00100','00100','00100'],
};

function posterText(message: string, pixel: number) {
  const vertices: number[] = [];
  const lineWidth = message.length * 6 * pixel - pixel;
  for (let index = 0; index < message.length; index++) {
    const glyph = letters[message[index]];
    if (!glyph) continue;
    for (let row = 0; row < glyph.length; row++) for (let col = 0; col < 5; col++) {
      if (glyph[row][col] !== '1') continue;
      const x = index * 6 * pixel + col * pixel - lineWidth / 2;
      const y = (3 - row) * pixel;
      vertices.push(x,y,0, x+pixel,y,0, x+pixel,y-pixel,0, x,y,0, x+pixel,y-pixel,0, x,y-pixel,0);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: '#352a46', side: THREE.DoubleSide }));
}

/** Close the loft's open right side and furnish it with a rooftop doorway. */
export function createLoftDetails(scene: THREE.Scene, floor: THREE.Box3) {
  const group = new THREE.Group();
  group.name = 'Loft new right wall and details';
  const wallLength = floor.max.z - floor.min.z - 0.22;
  const wallMaterial = new THREE.MeshStandardMaterial({ color: '#292533', roughness: 0.98 });
  const wallMesh = new THREE.Mesh(new THREE.BoxGeometry(wallLength, 5.3, 0.16), wallMaterial);
  wallMesh.name = 'Empty loft wall';
  wallMesh.position.set(0, 2.65, -0.07);
  group.add(wallMesh);
  const trimMaterial = new THREE.MeshStandardMaterial({ color: '#41342f', roughness: 0.88 });
  for (const y of [0.1, 5.22]) {
    const trim = new THREE.Mesh(new THREE.BoxGeometry(wallLength, 0.12, 0.08), trimMaterial);
    trim.position.set(0, y, 0.05);
    group.add(trim);
  }

  const frameMaterial = new THREE.MeshStandardMaterial({ color: '#301f1d', roughness: 0.78 });
  const canvasMaterial = new THREE.MeshStandardMaterial({ color: '#e9ddc7', roughness: 1 });
  const inkMaterial = new THREE.MeshBasicMaterial({ color: '#263845', side: THREE.DoubleSide });
  const snowMaterial = new THREE.MeshBasicMaterial({ color: '#f9f2e4', side: THREE.DoubleSide });
  const sunMaterial = new THREE.MeshBasicMaterial({ color: '#c84f4d', side: THREE.DoubleSide });

  const painting = new THREE.Group();
  painting.position.set(-1.5, 2.86, 0.055);
  painting.scale.setScalar(1.2);
  const frame = new THREE.Mesh(new THREE.BoxGeometry(1.72, 1.12, 0.07), frameMaterial);
  painting.add(frame);
  const canvas = new THREE.Mesh(new THREE.PlaneGeometry(1.57, 0.97), canvasMaterial);
  canvas.position.z = 0.046;
  painting.add(canvas);
  const sun = new THREE.Mesh(new THREE.CircleGeometry(0.18, 32), sunMaterial);
  sun.position.set(0.46, 0.2, 0.052);
  painting.add(sun);
  const mountainShape = new THREE.Shape();
  mountainShape.moveTo(-0.72, -0.43);
  mountainShape.lineTo(-0.14, 0.25);
  mountainShape.lineTo(0.59, -0.43);
  mountainShape.closePath();
  const mountain = new THREE.Mesh(new THREE.ShapeGeometry(mountainShape), inkMaterial);
  mountain.position.z = 0.054;
  painting.add(mountain);
  const snowShape = new THREE.Shape();
  snowShape.moveTo(-0.27, 0.1);
  snowShape.lineTo(-0.14, 0.25);
  snowShape.lineTo(0.03, 0.09);
  snowShape.lineTo(-0.05, 0.12);
  snowShape.lineTo(-0.12, 0.05);
  snowShape.closePath();
  const snow = new THREE.Mesh(new THREE.ShapeGeometry(snowShape), snowMaterial);
  snow.position.z = 0.056;
  painting.add(snow);
  for (let i = 0; i < 4; i++) {
    const wave = new THREE.Mesh(new THREE.BoxGeometry(1.32 - i * 0.16, 0.013, 0.004), inkMaterial);
    wave.position.set(-0.04, -0.29 - i * 0.047, 0.058);
    painting.add(wave);
  }
  group.add(painting);

  const scroll = new THREE.Group();
  scroll.position.set(-3.52, 2.7, 0.055);
  const scrollFrame = new THREE.Mesh(new THREE.BoxGeometry(0.84, 1.36, 0.05), frameMaterial);
  scroll.add(scrollFrame);
  const scrollPaper = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 1.23), canvasMaterial);
  scrollPaper.position.z = 0.03;
  scroll.add(scrollPaper);
  const scrollSun = new THREE.Mesh(new THREE.CircleGeometry(0.17, 24), sunMaterial);
  scrollSun.position.set(0.13, 0.31, 0.036);
  scroll.add(scrollSun);
  for (const [x, y, width] of [[-0.17, -0.26, 0.42], [0.03, -0.35, 0.34], [-0.05, -0.44, 0.48]]) {
    const ink = new THREE.Mesh(new THREE.BoxGeometry(width, 0.025, 0.005), inkMaterial);
    ink.position.set(x, y, 0.038);
    scroll.add(ink);
  }
  group.add(scroll);

  const doorX = 1.65;
  const door = new THREE.Mesh(
    new THREE.BoxGeometry(0.94, 1.88, 0.09),
    new THREE.MeshStandardMaterial({ color: '#4d302c', roughness: 0.67 }),
  );
  door.name = 'Rooftop door';
  door.position.set(doorX, 0.94, 0.09);
  group.add(door);
  const jamb = new THREE.Mesh(new THREE.BoxGeometry(1.08, 1.99, 0.075), frameMaterial);
  jamb.position.set(doorX, 0.995, 0.04);
  group.add(jamb);
  const doorInset = new THREE.Mesh(
    new THREE.BoxGeometry(0.75, 1.65, 0.016),
    new THREE.MeshStandardMaterial({ color: '#6a4640', roughness: 0.7 }),
  );
  doorInset.position.set(doorX, 0.94, 0.146);
  group.add(doorInset);
  const handle = new THREE.Mesh(
    new THREE.SphereGeometry(0.045, 12, 8),
    new THREE.MeshStandardMaterial({ color: '#d9ae70', metalness: 0.6, roughness: 0.3 }),
  );
  handle.position.set(doorX - 0.3, 0.88, 0.171);
  group.add(handle);
  const portalLight = new THREE.Mesh(
    new THREE.BoxGeometry(0.75, 0.055, 0.02),
    new THREE.MeshBasicMaterial({ color: '#ad87f3' }),
  );
  portalLight.position.set(doorX, 1.71, 0.16);
  group.add(portalLight);

  const poster = new THREE.Group();
  poster.position.set(doorX, 2.28, 0.08);
  const posterBoard = new THREE.Mesh(
    new THREE.BoxGeometry(1.52, 0.49, 0.045),
    new THREE.MeshStandardMaterial({ color: '#e6dbc8', roughness: 0.9 }),
  );
  poster.add(posterBoard);
  const topLine = posterText('WAY TO', 0.026);
  topLine.position.set(0, 0.105, 0.027);
  poster.add(topLine);
  const bottomLine = posterText('ROOFTOP', 0.026);
  bottomLine.position.set(0, -0.085, 0.027);
  poster.add(bottomLine);
  group.add(poster);

  // This side is open in the supplied GLB. The wall's front faces -X, toward
  // the player; local horizontal position runs along the room's Z axis.
  group.rotation.y = -Math.PI / 2;
  group.position.set(floor.max.x - 0.17, 0, (floor.min.z + floor.max.z) / 2);
  scene.add(group);
  group.updateMatrixWorld(true);
  return { wallMesh, doorPosition: group.localToWorld(new THREE.Vector3(doorX, 0, 0.22)), tapMeshes: [door, doorInset, jamb, handle, portalLight, posterBoard] };
}
