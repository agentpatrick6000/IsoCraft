import * as THREE from 'three';

const app = document.getElementById('app');
if (!app) {
  throw new Error('Missing #app container');
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87b8de);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
app.appendChild(renderer.domElement);

const frustumSize = 20;
const camera = new THREE.OrthographicCamera();

const ISO_AZIMUTH = THREE.MathUtils.degToRad(45);
const ISO_ELEVATION = Math.atan(Math.sin(Math.PI / 4));
const cameraDistance = 24;

function updateCameraProjection(): void {
  const aspect = window.innerWidth / window.innerHeight;
  camera.left = (-frustumSize * aspect) / 2;
  camera.right = (frustumSize * aspect) / 2;
  camera.top = frustumSize / 2;
  camera.bottom = -frustumSize / 2;
  camera.near = 0.1;
  camera.far = 200;
  camera.updateProjectionMatrix();
}

const target = new THREE.Vector3(0, 0, 0);
const spherical = new THREE.Spherical(cameraDistance, Math.PI / 2 - ISO_ELEVATION, ISO_AZIMUTH);
const cameraOffset = new THREE.Vector3().setFromSpherical(spherical);
camera.position.copy(target).add(cameraOffset);
camera.lookAt(target);
updateCameraProjection();

scene.add(new THREE.AmbientLight(0xffffff, 0.6));

const sun = new THREE.DirectionalLight(0xffffff, 1.15);
sun.position.set(20, 28, 14);
sun.target.position.set(0, 0, 0);
scene.add(sun);
scene.add(sun.target);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(64, 64, 1, 1),
  new THREE.MeshStandardMaterial({ color: 0x3fa34d, roughness: 1 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = false;
scene.add(ground);

const grid = new THREE.GridHelper(64, 64, 0x1f2937, 0x475569);
grid.position.y = 0.01;
scene.add(grid);

const originMarker = new THREE.Mesh(
  new THREE.BoxGeometry(1, 0.2, 1),
  new THREE.MeshStandardMaterial({ color: 0xeab308 })
);
originMarker.position.y = 0.1;
scene.add(originMarker);

function animate(): void {
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

animate();

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  updateCameraProjection();
});
