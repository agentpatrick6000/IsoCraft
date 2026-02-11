import * as THREE from 'three';
import type { FaceTileMap } from './voxel';
import { BlockId, Chunk, buildChunkGreedyGeometry } from './terrain';

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

const camera = new THREE.OrthographicCamera();
const ISO_ELEVATION = Math.atan(Math.sin(Math.PI / 4));
const BASE_CAMERA_DISTANCE = 24;
const ZOOM_LEVELS: number[] = [14, 20, 28];
let zoomLevel = 1;
let currentFrustumSize: number = ZOOM_LEVELS[zoomLevel];
let desiredFrustumSize: number = currentFrustumSize;

const textureLoader = new THREE.TextureLoader();
const worldRoot = new THREE.Group();
scene.add(worldRoot);

const grassTiles: FaceTileMap = {
  top: 0,
  bottom: 2,
  north: 1,
  south: 1,
  east: 1,
  west: 1
};

const dirtTiles: FaceTileMap = {
  top: 2,
  bottom: 2,
  north: 2,
  south: 2,
  east: 2,
  west: 2
};

const stoneTiles: FaceTileMap = {
  top: 3,
  bottom: 3,
  north: 3,
  south: 3,
  east: 3,
  west: 3
};

textureLoader.load('/textures/atlas.png', (atlasTexture) => {
  atlasTexture.magFilter = THREE.NearestFilter;
  atlasTexture.minFilter = THREE.NearestFilter;
  atlasTexture.generateMipmaps = false;
  atlasTexture.wrapS = THREE.ClampToEdgeWrapping;
  atlasTexture.wrapT = THREE.ClampToEdgeWrapping;
  atlasTexture.colorSpace = THREE.SRGBColorSpace;

  const chunk = new Chunk(16, 8, 16);
  chunk.fillFlatLayers(3);

  const geometry = buildChunkGreedyGeometry({
    chunk,
    blockTiles: {
      [BlockId.Air]: grassTiles,
      [BlockId.Grass]: grassTiles,
      [BlockId.Dirt]: dirtTiles,
      [BlockId.Stone]: stoneTiles
    }
  });

  const material = new THREE.MeshStandardMaterial({ map: atlasTexture });
  const chunkMesh = new THREE.Mesh(geometry, material);
  chunkMesh.position.set(-8, 0, -8);
  worldRoot.add(chunkMesh);
});

const player = new THREE.Mesh(
  new THREE.BoxGeometry(1, 0.2, 1),
  new THREE.MeshStandardMaterial({ color: 0xeab308 })
);
player.position.set(0, 4.1, 0);
scene.add(player);

const followOffset = new THREE.Vector3();
let followPlayer = true;

let yawCurrent = THREE.MathUtils.degToRad(45);
let yawStart = yawCurrent;
let yawTarget = yawCurrent;
let rotationStartMs = 0;
const ROTATE_DURATION_MS = 200;

function updateCameraProjection(): void {
  const aspect = window.innerWidth / window.innerHeight;
  camera.left = (-currentFrustumSize * aspect) / 2;
  camera.right = (currentFrustumSize * aspect) / 2;
  camera.top = currentFrustumSize / 2;
  camera.bottom = -currentFrustumSize / 2;
  camera.near = 0.1;
  camera.far = 200;
  camera.updateProjectionMatrix();
}

function snapYaw(fromYaw: number): number {
  const quarter = Math.PI / 2;
  return Math.round(fromYaw / quarter) * quarter;
}

function rotateSnap(direction: 1 | -1): void {
  const quarter = Math.PI / 2;
  const base = snapYaw(yawTarget);
  yawStart = yawCurrent;
  yawTarget = base + direction * quarter;
  rotationStartMs = performance.now();
}

const projectedForward = new THREE.Vector3();
const projectedRight = new THREE.Vector3();

function panByScreenDelta(deltaX: number, deltaY: number): void {
  const panScale = currentFrustumSize / Math.min(window.innerWidth, window.innerHeight);

  camera.getWorldDirection(projectedForward);
  projectedForward.y = 0;
  projectedForward.normalize();

  projectedRight.crossVectors(projectedForward, camera.up).normalize();

  followOffset
    .addScaledVector(projectedRight, -deltaX * panScale)
    .addScaledVector(projectedForward, deltaY * panScale);

  followPlayer = false;
}

function setZoomLevel(nextLevel: number): void {
  zoomLevel = THREE.MathUtils.clamp(nextLevel, 0, ZOOM_LEVELS.length - 1);
  desiredFrustumSize = ZOOM_LEVELS[zoomLevel];
}

scene.add(new THREE.AmbientLight(0xffffff, 0.6));

const sun = new THREE.DirectionalLight(0xffffff, 1.15);
sun.position.set(20, 28, 14);
sun.target.position.set(0, 0, 0);
scene.add(sun);
scene.add(sun.target);

const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();

function recenterIfPlayerTapped(clientX: number, clientY: number): void {
  const rect = renderer.domElement.getBoundingClientRect();
  pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(pointerNdc, camera);
  const hits = raycaster.intersectObject(player, false);

  if (hits.length > 0) {
    followPlayer = true;
    followOffset.set(0, 0, 0);
  }
}

window.addEventListener('keydown', (event) => {
  if (event.repeat) return;

  if (event.key.toLowerCase() === 'q') {
    rotateSnap(-1);
  } else if (event.key.toLowerCase() === 'e') {
    rotateSnap(1);
  }
});

renderer.domElement.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    if (event.deltaY > 0) {
      setZoomLevel(zoomLevel + 1);
    } else if (event.deltaY < 0) {
      setZoomLevel(zoomLevel - 1);
    }
  },
  { passive: false }
);

let isMiddlePanning = false;
let mouseLastX = 0;
let mouseLastY = 0;
let didMousePan = false;

renderer.domElement.addEventListener('mousedown', (event) => {
  if (event.button !== 1) return;
  event.preventDefault();
  isMiddlePanning = true;
  didMousePan = false;
  mouseLastX = event.clientX;
  mouseLastY = event.clientY;
});

window.addEventListener('mousemove', (event) => {
  if (!isMiddlePanning) return;

  const dx = event.clientX - mouseLastX;
  const dy = event.clientY - mouseLastY;
  if (Math.abs(dx) + Math.abs(dy) > 0) {
    didMousePan = true;
    panByScreenDelta(dx, dy);
  }

  mouseLastX = event.clientX;
  mouseLastY = event.clientY;
});

window.addEventListener('mouseup', (event) => {
  if (event.button !== 1) return;
  isMiddlePanning = false;
});

renderer.domElement.addEventListener('click', (event) => {
  if (didMousePan) {
    didMousePan = false;
    return;
  }
  recenterIfPlayerTapped(event.clientX, event.clientY);
});

type ActiveTouchState = {
  lastCenterX: number;
  lastCenterY: number;
  lastDistance: number;
  lastAngle: number;
  dragMoved: boolean;
  rotateCooldown: boolean;
};

const activeTouch: ActiveTouchState = {
  lastCenterX: 0,
  lastCenterY: 0,
  lastDistance: 0,
  lastAngle: 0,
  dragMoved: false,
  rotateCooldown: false
};

function touchCenter(touches: TouchList): { x: number; y: number } {
  if (touches.length === 1) {
    return { x: touches[0].clientX, y: touches[0].clientY };
  }

  return {
    x: (touches[0].clientX + touches[1].clientX) / 2,
    y: (touches[0].clientY + touches[1].clientY) / 2
  };
}

function touchDistance(touches: TouchList): number {
  if (touches.length < 2) return 0;
  const dx = touches[1].clientX - touches[0].clientX;
  const dy = touches[1].clientY - touches[0].clientY;
  return Math.hypot(dx, dy);
}

function touchAngle(touches: TouchList): number {
  if (touches.length < 2) return 0;
  const dx = touches[1].clientX - touches[0].clientX;
  const dy = touches[1].clientY - touches[0].clientY;
  return Math.atan2(dy, dx);
}

renderer.domElement.addEventListener(
  'touchstart',
  (event) => {
    const center = touchCenter(event.touches);
    activeTouch.lastCenterX = center.x;
    activeTouch.lastCenterY = center.y;
    activeTouch.lastDistance = touchDistance(event.touches);
    activeTouch.lastAngle = touchAngle(event.touches);
    activeTouch.dragMoved = false;
    activeTouch.rotateCooldown = false;
  },
  { passive: true }
);

renderer.domElement.addEventListener(
  'touchmove',
  (event) => {
    if (event.touches.length === 1) {
      const center = touchCenter(event.touches);
      const dx = center.x - activeTouch.lastCenterX;
      const dy = center.y - activeTouch.lastCenterY;

      if (Math.abs(dx) + Math.abs(dy) > 1) {
        activeTouch.dragMoved = true;
        panByScreenDelta(dx, dy);
      }

      activeTouch.lastCenterX = center.x;
      activeTouch.lastCenterY = center.y;
      return;
    }

    if (event.touches.length >= 2) {
      const center = touchCenter(event.touches);
      const dx = center.x - activeTouch.lastCenterX;
      const dy = center.y - activeTouch.lastCenterY;
      if (Math.abs(dx) + Math.abs(dy) > 1) {
        panByScreenDelta(dx, dy);
      }

      const distance = touchDistance(event.touches);
      const pinchDelta = distance - activeTouch.lastDistance;
      if (Math.abs(pinchDelta) > 16) {
        if (pinchDelta > 0) setZoomLevel(zoomLevel - 1);
        else setZoomLevel(zoomLevel + 1);
        activeTouch.lastDistance = distance;
      }

      const angle = touchAngle(event.touches);
      const angleDelta = angle - activeTouch.lastAngle;
      if (!activeTouch.rotateCooldown && Math.abs(angleDelta) > THREE.MathUtils.degToRad(18)) {
        rotateSnap(angleDelta > 0 ? 1 : -1);
        activeTouch.rotateCooldown = true;
      }

      activeTouch.lastCenterX = center.x;
      activeTouch.lastCenterY = center.y;
      activeTouch.lastAngle = angle;
    }
  },
  { passive: true }
);

renderer.domElement.addEventListener(
  'touchend',
  (event) => {
    if (!activeTouch.dragMoved && event.changedTouches.length > 0) {
      const touch = event.changedTouches[0];
      recenterIfPlayerTapped(touch.clientX, touch.clientY);
    }

    if (event.touches.length > 0) {
      const center = touchCenter(event.touches);
      activeTouch.lastCenterX = center.x;
      activeTouch.lastCenterY = center.y;
      activeTouch.lastDistance = touchDistance(event.touches);
      activeTouch.lastAngle = touchAngle(event.touches);
      activeTouch.rotateCooldown = false;
    }
  },
  { passive: true }
);

function animate(timeMs: number): void {
  if (rotationStartMs > 0) {
    const t = THREE.MathUtils.clamp((timeMs - rotationStartMs) / ROTATE_DURATION_MS, 0, 1);
    const eased = t * (2 - t);
    yawCurrent = THREE.MathUtils.lerp(yawStart, yawTarget, eased);
    if (t >= 1) {
      yawCurrent = yawTarget;
      rotationStartMs = 0;
    }
  }

  currentFrustumSize = THREE.MathUtils.lerp(currentFrustumSize, desiredFrustumSize, 0.18);
  updateCameraProjection();

  const target = new THREE.Vector3().copy(player.position);
  if (!followPlayer) {
    target.add(followOffset);
  }

  const spherical = new THREE.Spherical(BASE_CAMERA_DISTANCE, Math.PI / 2 - ISO_ELEVATION, yawCurrent);
  const cameraOffset = new THREE.Vector3().setFromSpherical(spherical);

  camera.position.copy(target).add(cameraOffset);
  camera.lookAt(target);

  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

requestAnimationFrame(animate);

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  updateCameraProjection();
});
