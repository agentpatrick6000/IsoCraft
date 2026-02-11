import * as THREE from 'three';
import type { FaceTileMap } from './voxel';
import { fbm2d } from './noise';
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

const sandTiles: FaceTileMap = {
  top: 4,
  bottom: 4,
  north: 4,
  south: 4,
  east: 4,
  west: 4
};

const waterTiles: FaceTileMap = {
  top: 5,
  bottom: 5,
  north: 5,
  south: 5,
  east: 5,
  west: 5
};

const WORLD_CHUNK_RADIUS = 2;
const CHUNK_SIZE = 16;
const CHUNK_HEIGHT = 12;
const SEA_LEVEL = 4;
const BASE_HEIGHT = 5;
const HEIGHT_AMPLITUDE = 3;
const HEIGHT_NOISE_SCALE = 0.05;

const playerSpawnPosition = new THREE.Vector3(0, 6, 0);

textureLoader.load('/textures/atlas.png', (atlasTexture) => {
  atlasTexture.magFilter = THREE.NearestFilter;
  atlasTexture.minFilter = THREE.NearestFilter;
  atlasTexture.generateMipmaps = false;
  atlasTexture.wrapS = THREE.ClampToEdgeWrapping;
  atlasTexture.wrapT = THREE.ClampToEdgeWrapping;
  atlasTexture.colorSpace = THREE.SRGBColorSpace;

  const material = new THREE.MeshStandardMaterial({ map: atlasTexture });

  for (let chunkX = -WORLD_CHUNK_RADIUS; chunkX <= WORLD_CHUNK_RADIUS; chunkX++) {
    for (let chunkZ = -WORLD_CHUNK_RADIUS; chunkZ <= WORLD_CHUNK_RADIUS; chunkZ++) {
      const chunk = new Chunk(CHUNK_SIZE, CHUNK_HEIGHT, CHUNK_SIZE);

      chunk.fillFromHeightSampler((localX, localZ) => {
        const worldX = chunkX * CHUNK_SIZE + localX;
        const worldZ = chunkZ * CHUNK_SIZE + localZ;
        const noiseValue = fbm2d(worldX * HEIGHT_NOISE_SCALE, worldZ * HEIGHT_NOISE_SCALE, {
          seed: 4242,
          octaves: 5,
          lacunarity: 2,
          gain: 0.5
        });

        return BASE_HEIGHT + Math.round((noiseValue - 0.5) * HEIGHT_AMPLITUDE * 2);
      }, SEA_LEVEL);

      const geometry = buildChunkGreedyGeometry({
        chunk,
        blockTiles: {
          [BlockId.Air]: grassTiles,
          [BlockId.Grass]: grassTiles,
          [BlockId.Dirt]: dirtTiles,
          [BlockId.Stone]: stoneTiles,
          [BlockId.Sand]: sandTiles,
          [BlockId.Water]: waterTiles
        }
      });

      const chunkMesh = new THREE.Mesh(geometry, material);
      chunkMesh.position.set(chunkX * CHUNK_SIZE, 0, chunkZ * CHUNK_SIZE);
      worldRoot.add(chunkMesh);

      if (chunkX === 0 && chunkZ === 0) {
        const centerX = Math.floor(CHUNK_SIZE / 2);
        const centerZ = Math.floor(CHUNK_SIZE / 2);
        playerSpawnPosition.set(
          chunkX * CHUNK_SIZE + centerX,
          chunk.getTopSolidY(centerX, centerZ) + 1,
          chunkZ * CHUNK_SIZE + centerZ
        );
      }
    }
  }

  const worldWidth = (WORLD_CHUNK_RADIUS * 2 + 1) * CHUNK_SIZE;
  worldRoot.position.set(-worldWidth / 2, 0, -worldWidth / 2);
  player.position.copy(playerSpawnPosition).add(worldRoot.position);
});

const player = new THREE.Group();

const playerBody = new THREE.Mesh(
  new THREE.BoxGeometry(0.9, 1.2, 0.9),
  new THREE.MeshStandardMaterial({ color: 0x22d3ee, roughness: 0.65, metalness: 0.05 })
);
playerBody.position.y = 0.6;

const playerHead = new THREE.Mesh(
  new THREE.BoxGeometry(0.8, 0.8, 0.8),
  new THREE.MeshStandardMaterial({ color: 0xf97316, roughness: 0.6, metalness: 0.02 })
);
playerHead.position.y = 1.6;

const playerMarker = new THREE.Mesh(
  new THREE.RingGeometry(0.62, 0.78, 24),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, side: THREE.DoubleSide })
);
playerMarker.rotation.x = -Math.PI / 2;
playerMarker.position.y = 0.02;

player.add(playerBody, playerHead, playerMarker);
player.position.copy(playerSpawnPosition);
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
  const hits = raycaster.intersectObject(player, true);

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
