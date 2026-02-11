import * as THREE from 'three';

const app = document.getElementById('app');
if (!app) {
  throw new Error('Missing #app container');
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1e293b);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(2, 2, 3);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
app.appendChild(renderer.domElement);

const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
const boxMaterial = new THREE.MeshStandardMaterial({ color: 0x22c55e });
const cube = new THREE.Mesh(boxGeometry, boxMaterial);
scene.add(cube);

const ambient = new THREE.AmbientLight(0xffffff, 0.7);
scene.add(ambient);

const directional = new THREE.DirectionalLight(0xffffff, 1.2);
directional.position.set(3, 5, 2);
scene.add(directional);

function animate(): void {
  cube.rotation.x += 0.01;
  cube.rotation.y += 0.015;
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
