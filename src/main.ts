import * as THREE from 'three';
import Stats from 'three/addons/libs/stats.module.js';
import type { FaceTileMap } from './voxel';
import { fbm2d } from './noise';
import { BlockId, Chunk, buildChunkGreedyGeometry } from './terrain';

const app = document.getElementById('app');
if (!app) {
  throw new Error('Missing #app container');
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.warn('Service worker registration failed:', error);
    });
  });
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87b8de);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
app.appendChild(renderer.domElement);

const stats = new Stats();
stats.showPanel(0);
stats.dom.style.position = 'fixed';
stats.dom.style.top = '8px';
stats.dom.style.left = '8px';
stats.dom.style.zIndex = '20';
app.appendChild(stats.dom);

const FRAME_BUDGET_MS = 1000 / 60;
let frameBudgetWarnCooldownMs = 0;

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

const woodLogTiles: FaceTileMap = {
  top: 6,
  bottom: 6,
  north: 7,
  south: 7,
  east: 7,
  west: 7
};

const leavesTiles: FaceTileMap = {
  top: 8,
  bottom: 8,
  north: 8,
  south: 8,
  east: 8,
  west: 8
};

const WORLD_CHUNK_RADIUS = 2;
const CHUNK_SIZE = 16;
const CHUNK_HEIGHT = 12;
const SEA_LEVEL = 4;
const BASE_HEIGHT = 5;
const HEIGHT_AMPLITUDE = 3;
const HEIGHT_NOISE_SCALE = 0.05;

const playerSpawnTerrainPosition = new THREE.Vector3(0, 6, 0);
const terrainTopByCell = new Map<string, number>();
const terrainMeshes: THREE.Mesh[] = [];

const PATH_LINE_Y_OFFSET = 0.08;
const MOVE_TARGET_EPSILON = 0.075;
const MAX_PATH_SEARCH = 5000;

let activePathCells: Array<{ x: number; z: number }> = [];
let activePathIndex = 0;

const pathLine = new THREE.Line(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4 })
);
pathLine.renderOrder = 2;
scene.add(pathLine);

function cellKey(x: number, z: number): string {
  return `${x},${z}`;
}

let worldOffsetX = 0;
let worldOffsetZ = 0;

function terrainToSceneX(x: number): number {
  return x + worldOffsetX;
}

function terrainToSceneZ(z: number): number {
  return z + worldOffsetZ;
}

function sceneToTerrainX(x: number): number {
  return x - worldOffsetX;
}

function sceneToTerrainZ(z: number): number {
  return z - worldOffsetZ;
}

function getTerrainTopY(terrainX: number, terrainZ: number): number | null {
  const cellX = Math.floor(terrainX);
  const cellZ = Math.floor(terrainZ);
  const topY = terrainTopByCell.get(cellKey(cellX, cellZ));
  return topY ?? null;
}

function canOccupyCell(terrainX: number, terrainZ: number): boolean {
  return getTerrainTopY(terrainX, terrainZ) !== null;
}

function clearActivePath(): void {
  activePathCells = [];
  activePathIndex = 0;
  pathLine.geometry.setFromPoints([]);
}

function isWalkableCell(x: number, z: number): boolean {
  return terrainTopByCell.has(cellKey(x, z));
}

function movementCost(fromX: number, fromZ: number, toX: number, toZ: number): number {
  const fromY = terrainTopByCell.get(cellKey(fromX, fromZ));
  const toY = terrainTopByCell.get(cellKey(toX, toZ));
  if (fromY === undefined || toY === undefined) {
    return Number.POSITIVE_INFINITY;
  }

  const rise = toY - fromY;
  if (rise > STEP_UP_LIMIT) {
    return Number.POSITIVE_INFINITY;
  }

  return 1 + Math.max(0, rise) * 0.65;
}

function findPath(startX: number, startZ: number, goalX: number, goalZ: number): Array<{ x: number; z: number }> {
  if (!isWalkableCell(startX, startZ) || !isWalkableCell(goalX, goalZ)) {
    return [];
  }

  if (startX === goalX && startZ === goalZ) {
    return [{ x: startX, z: startZ }];
  }

  const openSet = new Set<string>();
  const closedSet = new Set<string>();
  const cameFrom = new Map<string, string>();
  const gScore = new Map<string, number>();
  const fScore = new Map<string, number>();

  const startKey = cellKey(startX, startZ);
  const goalKey = cellKey(goalX, goalZ);

  const heuristic = (x: number, z: number): number => Math.abs(goalX - x) + Math.abs(goalZ - z);

  openSet.add(startKey);
  gScore.set(startKey, 0);
  fScore.set(startKey, heuristic(startX, startZ));

  let explored = 0;

  while (openSet.size > 0 && explored < MAX_PATH_SEARCH) {
    explored += 1;

    let currentKey = '';
    let currentF = Number.POSITIVE_INFINITY;

    for (const key of openSet) {
      const score = fScore.get(key) ?? Number.POSITIVE_INFINITY;
      if (score < currentF) {
        currentF = score;
        currentKey = key;
      }
    }

    if (!currentKey) {
      break;
    }

    if (currentKey === goalKey) {
      const path: Array<{ x: number; z: number }> = [];
      let traceKey: string | undefined = currentKey;
      while (traceKey) {
        const [xText, zText] = traceKey.split(',');
        path.push({ x: Number.parseInt(xText, 10), z: Number.parseInt(zText, 10) });
        traceKey = cameFrom.get(traceKey);
      }
      path.reverse();
      return path;
    }

    openSet.delete(currentKey);
    closedSet.add(currentKey);

    const [cxText, czText] = currentKey.split(',');
    const cx = Number.parseInt(cxText, 10);
    const cz = Number.parseInt(czText, 10);

    const neighbors = [
      { x: cx + 1, z: cz },
      { x: cx - 1, z: cz },
      { x: cx, z: cz + 1 },
      { x: cx, z: cz - 1 }
    ];

    for (const neighbor of neighbors) {
      if (!isWalkableCell(neighbor.x, neighbor.z)) {
        continue;
      }

      const neighborKey = cellKey(neighbor.x, neighbor.z);
      if (closedSet.has(neighborKey)) {
        continue;
      }

      const stepCost = movementCost(cx, cz, neighbor.x, neighbor.z);
      if (!Number.isFinite(stepCost)) {
        continue;
      }

      const tentativeG = (gScore.get(currentKey) ?? Number.POSITIVE_INFINITY) + stepCost;
      if (tentativeG >= (gScore.get(neighborKey) ?? Number.POSITIVE_INFINITY)) {
        continue;
      }

      cameFrom.set(neighborKey, currentKey);
      gScore.set(neighborKey, tentativeG);
      fScore.set(neighborKey, tentativeG + heuristic(neighbor.x, neighbor.z));
      openSet.add(neighborKey);
    }
  }

  return [];
}

function rebuildPathVisual(): void {
  if (activePathCells.length <= 1 || activePathIndex >= activePathCells.length - 1) {
    pathLine.geometry.setFromPoints([]);
    return;
  }

  const points: THREE.Vector3[] = [];
  for (let i = activePathIndex; i < activePathCells.length; i++) {
    const cell = activePathCells[i];
    const topY = terrainTopByCell.get(cellKey(cell.x, cell.z));
    if (topY === undefined) {
      continue;
    }
    points.push(
      new THREE.Vector3(
        terrainToSceneX(cell.x + 0.5),
        topY + 1 + PATH_LINE_Y_OFFSET,
        terrainToSceneZ(cell.z + 0.5)
      )
    );
  }

  pathLine.geometry.setFromPoints(points);
}

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
player.position.copy(playerSpawnTerrainPosition);
scene.add(player);

const playerTerrainPos = new THREE.Vector3(playerSpawnTerrainPosition.x, playerSpawnTerrainPosition.y, playerSpawnTerrainPosition.z);
const currentMoveDir = new THREE.Vector3();
const candidateTerrainPos = new THREE.Vector3();
const collisionProbe = new THREE.Vector3();
const upAxis = new THREE.Vector3(0, 1, 0);

const PLAYER_MOVE_SPEED = 4.25;
const STEP_UP_LIMIT = 1;
const INPUT_LERP = 0.25;
const EPS = 1e-5;

function syncPlayerScenePositionFromTerrain(): void {
  player.position.set(
    terrainToSceneX(playerTerrainPos.x),
    playerTerrainPos.y,
    terrainToSceneZ(playerTerrainPos.z)
  );
}

textureLoader.load('/textures/atlas.png', (atlasTexture) => {
  atlasTexture.magFilter = THREE.NearestFilter;
  atlasTexture.minFilter = THREE.NearestFilter;
  atlasTexture.generateMipmaps = false;
  atlasTexture.wrapS = THREE.ClampToEdgeWrapping;
  atlasTexture.wrapT = THREE.ClampToEdgeWrapping;
  atlasTexture.colorSpace = THREE.SRGBColorSpace;

  const terrainMaterial = new THREE.MeshStandardMaterial({ map: atlasTexture });
  const leavesMaterial = new THREE.MeshStandardMaterial({
    map: atlasTexture,
    transparent: true,
    opacity: 0.72,
    alphaTest: 0.05,
    depthWrite: false
  });

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
      chunk.addTrees({ worldChunkX: chunkX, worldChunkZ: chunkZ, chunkSize: CHUNK_SIZE, seed: 13371 });

      for (let localX = 0; localX < CHUNK_SIZE; localX++) {
        for (let localZ = 0; localZ < CHUNK_SIZE; localZ++) {
          const worldX = chunkX * CHUNK_SIZE + localX;
          const worldZ = chunkZ * CHUNK_SIZE + localZ;
          terrainTopByCell.set(cellKey(worldX, worldZ), chunk.getTopSolidY(localX, localZ));
        }
      }

      const blockTiles = {
        [BlockId.Air]: grassTiles,
        [BlockId.Grass]: grassTiles,
        [BlockId.Dirt]: dirtTiles,
        [BlockId.Stone]: stoneTiles,
        [BlockId.Sand]: sandTiles,
        [BlockId.Water]: waterTiles,
        [BlockId.WoodLog]: woodLogTiles,
        [BlockId.Leaves]: leavesTiles
      };

      const terrainGeometry = buildChunkGreedyGeometry({
        chunk,
        blockTiles,
        shouldRender: (block) => block !== BlockId.Air && block !== BlockId.Leaves,
        isOpaque: (block) => block !== BlockId.Air && block !== BlockId.Leaves
      });

      const leavesGeometry = buildChunkGreedyGeometry({
        chunk,
        blockTiles,
        shouldRender: (block) => block === BlockId.Leaves,
        isOpaque: (block) => block === BlockId.Leaves
      });

      const chunkMesh = new THREE.Mesh(terrainGeometry, terrainMaterial);
      chunkMesh.position.set(chunkX * CHUNK_SIZE, 0, chunkZ * CHUNK_SIZE);
      worldRoot.add(chunkMesh);
      terrainMeshes.push(chunkMesh);

      const leavesMesh = new THREE.Mesh(leavesGeometry, leavesMaterial);
      leavesMesh.position.set(chunkX * CHUNK_SIZE, 0, chunkZ * CHUNK_SIZE);
      leavesMesh.renderOrder = 1;
      worldRoot.add(leavesMesh);

      if (chunkX === 0 && chunkZ === 0) {
        const centerX = Math.floor(CHUNK_SIZE / 2);
        const centerZ = Math.floor(CHUNK_SIZE / 2);
        playerSpawnTerrainPosition.set(
          chunkX * CHUNK_SIZE + centerX + 0.5,
          chunk.getTopSolidY(centerX, centerZ) + 1,
          chunkZ * CHUNK_SIZE + centerZ + 0.5
        );
      }
    }
  }

  const worldWidth = (WORLD_CHUNK_RADIUS * 2 + 1) * CHUNK_SIZE;
  worldOffsetX = -worldWidth / 2;
  worldOffsetZ = -worldWidth / 2;
  worldRoot.position.set(worldOffsetX, 0, worldOffsetZ);

  playerTerrainPos.copy(playerSpawnTerrainPosition);
  syncPlayerScenePositionFromTerrain();
});

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

function screenToNdc(clientX: number, clientY: number): void {
  const rect = renderer.domElement.getBoundingClientRect();
  pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
}

function recenterIfPlayerTapped(clientX: number, clientY: number): boolean {
  screenToNdc(clientX, clientY);

  raycaster.setFromCamera(pointerNdc, camera);
  const hits = raycaster.intersectObject(player, true);

  if (hits.length > 0) {
    followPlayer = true;
    followOffset.set(0, 0, 0);
    clearActivePath();
    return true;
  }

  return false;
}

function setTapMoveTarget(clientX: number, clientY: number): void {
  if (terrainMeshes.length === 0) {
    return;
  }

  screenToNdc(clientX, clientY);
  raycaster.setFromCamera(pointerNdc, camera);

  const terrainHits = raycaster.intersectObjects(terrainMeshes, false);
  if (terrainHits.length === 0) {
    clearActivePath();
    return;
  }

  const hit = terrainHits[0];
  const terrainX = sceneToTerrainX(hit.point.x);
  const terrainZ = sceneToTerrainZ(hit.point.z);

  const startX = Math.floor(playerTerrainPos.x);
  const startZ = Math.floor(playerTerrainPos.z);
  const goalX = Math.floor(terrainX);
  const goalZ = Math.floor(terrainZ);

  const path = findPath(startX, startZ, goalX, goalZ);
  if (path.length <= 1) {
    clearActivePath();
    return;
  }

  activePathCells = path;
  activePathIndex = 1;
  rebuildPathVisual();
}

function handleTap(clientX: number, clientY: number): void {
  if (recenterIfPlayerTapped(clientX, clientY)) {
    return;
  }

  setTapMoveTarget(clientX, clientY);
}

const movementKeys = new Set<string>();
const keyAlias: Record<string, string> = {
  arrowup: 'w',
  arrowdown: 's',
  arrowleft: 'a',
  arrowright: 'd'
};

window.addEventListener('keydown', (event) => {
  const key = event.key.toLowerCase();

  if (!event.repeat) {
    if (key === 'q') {
      rotateSnap(-1);
    } else if (key === 'e') {
      rotateSnap(1);
    }
  }

  const mapped = keyAlias[key] ?? key;
  if (mapped === 'w' || mapped === 'a' || mapped === 's' || mapped === 'd') {
    movementKeys.add(mapped);
  }
});

window.addEventListener('keyup', (event) => {
  const key = event.key.toLowerCase();
  const mapped = keyAlias[key] ?? key;
  if (mapped === 'w' || mapped === 'a' || mapped === 's' || mapped === 'd') {
    movementKeys.delete(mapped);
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
  handleTap(event.clientX, event.clientY);
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
      handleTap(touch.clientX, touch.clientY);
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

function applyPlayerMovement(deltaSeconds: number): void {
  if (terrainTopByCell.size === 0) {
    return;
  }

  const inputX = (movementKeys.has('d') ? 1 : 0) - (movementKeys.has('a') ? 1 : 0);
  const inputZ = (movementKeys.has('w') ? 1 : 0) - (movementKeys.has('s') ? 1 : 0);
  const hasKeyboardInput = inputX !== 0 || inputZ !== 0;

  camera.getWorldDirection(projectedForward);
  projectedForward.y = 0;
  if (projectedForward.lengthSq() < EPS) {
    projectedForward.set(0, 0, 1);
  } else {
    projectedForward.normalize();
  }

  projectedRight.crossVectors(projectedForward, upAxis).normalize();

  const desiredMoveDir = new THREE.Vector3();

  if (hasKeyboardInput) {
    clearActivePath();
    desiredMoveDir
      .addScaledVector(projectedRight, inputX)
      .addScaledVector(projectedForward, inputZ)
      .normalize();
  } else if (activePathCells.length > 0 && activePathIndex < activePathCells.length) {
    const targetCell = activePathCells[activePathIndex];
    const targetPos = new THREE.Vector3(targetCell.x + 0.5, 0, targetCell.z + 0.5);
    const toTarget = targetPos.sub(new THREE.Vector3(playerTerrainPos.x, 0, playerTerrainPos.z));

    if (toTarget.lengthSq() <= MOVE_TARGET_EPSILON * MOVE_TARGET_EPSILON) {
      activePathIndex += 1;
      if (activePathIndex >= activePathCells.length) {
        clearActivePath();
      } else {
        rebuildPathVisual();
      }
    } else {
      desiredMoveDir.copy(toTarget.normalize());
    }
  }

  currentMoveDir.lerp(desiredMoveDir, hasKeyboardInput ? INPUT_LERP : 0.35);
  if (currentMoveDir.lengthSq() < EPS) {
    currentMoveDir.set(0, 0, 0);
    return;
  }

  candidateTerrainPos.copy(playerTerrainPos).addScaledVector(currentMoveDir, PLAYER_MOVE_SPEED * deltaSeconds);

  collisionProbe.set(candidateTerrainPos.x, 0, playerTerrainPos.z);
  if (canOccupyCell(collisionProbe.x, collisionProbe.z)) {
    const nextTopY = getTerrainTopY(collisionProbe.x, collisionProbe.z)!;
    if (nextTopY - (playerTerrainPos.y - 1) <= STEP_UP_LIMIT) {
      playerTerrainPos.x = candidateTerrainPos.x;
      playerTerrainPos.y = nextTopY + 1;
    }
  }

  collisionProbe.set(playerTerrainPos.x, 0, candidateTerrainPos.z);
  if (canOccupyCell(collisionProbe.x, collisionProbe.z)) {
    const nextTopY = getTerrainTopY(collisionProbe.x, collisionProbe.z)!;
    if (nextTopY - (playerTerrainPos.y - 1) <= STEP_UP_LIMIT) {
      playerTerrainPos.z = candidateTerrainPos.z;
      playerTerrainPos.y = nextTopY + 1;
    }
  }

  const currentTopY = getTerrainTopY(playerTerrainPos.x, playerTerrainPos.z);
  if (currentTopY !== null) {
    playerTerrainPos.y = currentTopY + 1;
  }

  if (activePathCells.length > 0 && activePathIndex < activePathCells.length) {
    rebuildPathVisual();
  }

  syncPlayerScenePositionFromTerrain();
}

const cameraTarget = new THREE.Vector3();
const spherical = new THREE.Spherical();
const cameraOffset = new THREE.Vector3();

let lastFrameMs = performance.now();

function animate(timeMs: number): void {
  stats.begin();

  const frameTimeMs = Math.max(0, timeMs - lastFrameMs);
  const deltaSeconds = Math.min(0.05, frameTimeMs / 1000);
  lastFrameMs = timeMs;

  if (frameTimeMs > FRAME_BUDGET_MS && timeMs >= frameBudgetWarnCooldownMs) {
    const overBudgetMs = frameTimeMs - FRAME_BUDGET_MS;
    console.warn(
      `[perf] frame time ${frameTimeMs.toFixed(2)}ms exceeds 60fps budget by ${overBudgetMs.toFixed(2)}ms`
    );
    frameBudgetWarnCooldownMs = timeMs + 1500;
  }

  if (rotationStartMs > 0) {
    const t = THREE.MathUtils.clamp((timeMs - rotationStartMs) / ROTATE_DURATION_MS, 0, 1);
    const eased = t * (2 - t);
    yawCurrent = THREE.MathUtils.lerp(yawStart, yawTarget, eased);
    if (t >= 1) {
      yawCurrent = yawTarget;
      rotationStartMs = 0;
    }
  }

  applyPlayerMovement(deltaSeconds);

  currentFrustumSize = THREE.MathUtils.lerp(currentFrustumSize, desiredFrustumSize, 0.18);
  updateCameraProjection();

  cameraTarget.copy(player.position);
  if (!followPlayer) {
    cameraTarget.add(followOffset);
  }

  spherical.set(BASE_CAMERA_DISTANCE, Math.PI / 2 - ISO_ELEVATION, yawCurrent);
  cameraOffset.setFromSpherical(spherical);

  camera.position.copy(cameraTarget).add(cameraOffset);
  camera.lookAt(cameraTarget);

  renderer.render(scene, camera);
  stats.end();
  requestAnimationFrame(animate);
}

requestAnimationFrame(animate);

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  updateCameraProjection();
});
