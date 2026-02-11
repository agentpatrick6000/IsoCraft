import * as THREE from 'three';
import Stats from 'three/addons/libs/stats.module.js';
import { createVoxelBlockMesh, type FaceTileMap } from './voxel';
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
let worldAtlasTexture: THREE.Texture | null = null;
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

const coalOreTiles: FaceTileMap = {
  top: 9,
  bottom: 9,
  north: 9,
  south: 9,
  east: 9,
  west: 9
};

const ironOreTiles: FaceTileMap = {
  top: 10,
  bottom: 10,
  north: 10,
  south: 10,
  east: 10,
  west: 10
};

const goldOreTiles: FaceTileMap = {
  top: 11,
  bottom: 11,
  north: 11,
  south: 11,
  east: 11,
  west: 11
};

const blockTilesById: Record<BlockId, FaceTileMap> = {
  [BlockId.Air]: grassTiles,
  [BlockId.Grass]: grassTiles,
  [BlockId.Dirt]: dirtTiles,
  [BlockId.Stone]: stoneTiles,
  [BlockId.Sand]: sandTiles,
  [BlockId.Water]: waterTiles,
  [BlockId.WoodLog]: woodLogTiles,
  [BlockId.Leaves]: leavesTiles,
  [BlockId.CoalOre]: coalOreTiles,
  [BlockId.IronOre]: ironOreTiles,
  [BlockId.GoldOre]: goldOreTiles
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

type WorldChunk = {
  chunkX: number;
  chunkZ: number;
  chunk: Chunk;
  terrainMesh: THREE.Mesh;
  leavesMesh: THREE.Mesh;
};

const terrainMeshes: THREE.Mesh[] = [];
const leavesMeshes: THREE.Mesh[] = [];
const worldChunks: WorldChunk[] = [];
const worldChunkByKey = new Map<string, WorldChunk>();

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

function worldChunkKey(chunkX: number, chunkZ: number): string {
  return `${chunkX},${chunkZ}`;
}

function splitChunkAndLocal(worldCoord: number): { chunk: number; local: number } {
  const chunk = Math.floor(worldCoord / CHUNK_SIZE);
  const local = worldCoord - chunk * CHUNK_SIZE;
  return { chunk, local };
}

function updateTopYForColumn(chunkX: number, chunkZ: number, localX: number, localZ: number): void {
  const record = worldChunkByKey.get(worldChunkKey(chunkX, chunkZ));
  if (!record) {
    return;
  }

  const worldX = chunkX * CHUNK_SIZE + localX;
  const worldZ = chunkZ * CHUNK_SIZE + localZ;
  terrainTopByCell.set(cellKey(worldX, worldZ), record.chunk.getTopSolidY(localX, localZ));
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

function paintOreTilesOnAtlas(atlasTexture: THREE.Texture): void {
  const atlasImage = atlasTexture.image as HTMLImageElement | undefined;
  if (!atlasImage) {
    return;
  }

  const tileSize = 16;
  const canvas = document.createElement('canvas');
  canvas.width = atlasImage.width;
  canvas.height = atlasImage.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return;
  }

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(atlasImage, 0, 0);

  const stoneTileX = (3 % 4) * tileSize;
  const stoneTileY = Math.floor(3 / 4) * tileSize;

  type OrePattern = { tileIndex: number; tint: string; fleckCount: number; seed: number };
  const orePatterns: OrePattern[] = [
    { tileIndex: 9, tint: '#2f2f34', fleckCount: 14, seed: 101 },
    { tileIndex: 10, tint: '#b7936a', fleckCount: 13, seed: 202 },
    { tileIndex: 11, tint: '#f7c845', fleckCount: 12, seed: 303 }
  ];

  const rand = (x: number, y: number, seed: number): number => {
    const n = Math.sin((x + 1) * 83.7 + (y + 1) * 29.3 + seed * 11.9) * 43758.5453;
    return n - Math.floor(n);
  };

  for (const ore of orePatterns) {
    const tileX = (ore.tileIndex % 4) * tileSize;
    const tileY = Math.floor(ore.tileIndex / 4) * tileSize;

    ctx.drawImage(canvas, stoneTileX, stoneTileY, tileSize, tileSize, tileX, tileY, tileSize, tileSize);
    ctx.fillStyle = ore.tint;

    for (let i = 0; i < ore.fleckCount; i++) {
      const px = Math.floor(rand(i, ore.seed, 7) * (tileSize - 3));
      const py = Math.floor(rand(i, ore.seed, 19) * (tileSize - 3));
      const w = rand(i, ore.seed, 31) > 0.6 ? 2 : 1;
      const h = rand(i, ore.seed, 47) > 0.7 ? 2 : 1;
      ctx.fillRect(tileX + px, tileY + py, w, h);
    }
  }

  atlasTexture.image = canvas;
  atlasTexture.needsUpdate = true;
}

textureLoader.load('/textures/atlas.png', (atlasTexture) => {
  paintOreTilesOnAtlas(atlasTexture);

  atlasTexture.magFilter = THREE.NearestFilter;
  atlasTexture.minFilter = THREE.NearestFilter;
  worldAtlasTexture = atlasTexture;
  atlasTexture.generateMipmaps = false;
  updateHeldItemVisual();
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
      chunk.addCaves({ worldChunkX: chunkX, worldChunkZ: chunkZ, chunkSize: CHUNK_SIZE, seed: 31841 });
      chunk.addOreDeposits({ worldChunkX: chunkX, worldChunkZ: chunkZ, chunkSize: CHUNK_SIZE, seed: 24013 });
      chunk.addTrees({ worldChunkX: chunkX, worldChunkZ: chunkZ, chunkSize: CHUNK_SIZE, seed: 13371 });

      for (let localX = 0; localX < CHUNK_SIZE; localX++) {
        for (let localZ = 0; localZ < CHUNK_SIZE; localZ++) {
          const worldX = chunkX * CHUNK_SIZE + localX;
          const worldZ = chunkZ * CHUNK_SIZE + localZ;
          terrainTopByCell.set(cellKey(worldX, worldZ), chunk.getTopSolidY(localX, localZ));
        }
      }

      const terrainGeometry = buildChunkGreedyGeometry({
        chunk,
        blockTiles: blockTilesById,
        shouldRender: (block) => block !== BlockId.Air && block !== BlockId.Leaves,
        isOpaque: (block) => block !== BlockId.Air && block !== BlockId.Leaves
      });

      const leavesGeometry = buildChunkGreedyGeometry({
        chunk,
        blockTiles: blockTilesById,
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
      leavesMeshes.push(leavesMesh);

      const record: WorldChunk = { chunkX, chunkZ, chunk, terrainMesh: chunkMesh, leavesMesh };
      worldChunks.push(record);
      worldChunkByKey.set(worldChunkKey(chunkX, chunkZ), record);

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

type PlacementTarget = {
  chunkX: number;
  chunkZ: number;
  localX: number;
  localY: number;
  localZ: number;
  worldX: number;
  worldY: number;
  worldZ: number;
};

type MiningTarget = {
  chunkX: number;
  chunkZ: number;
  localX: number;
  localY: number;
  localZ: number;
  worldX: number;
  worldY: number;
  worldZ: number;
  block: BlockId;
};

const blockMiningTimeMs: Partial<Record<BlockId, number>> = {
  [BlockId.Grass]: 420,
  [BlockId.Dirt]: 380,
  [BlockId.Sand]: 360,
  [BlockId.WoodLog]: 700,
  [BlockId.Leaves]: 220,
  [BlockId.Stone]: 1200,
  [BlockId.CoalOre]: 1650,
  [BlockId.IronOre]: 1850,
  [BlockId.GoldOre]: 2200
};

const miningOverlay = document.createElement('div');
miningOverlay.style.position = 'fixed';
miningOverlay.style.left = '50%';
miningOverlay.style.bottom = '18px';
miningOverlay.style.transform = 'translateX(-50%)';
miningOverlay.style.width = '180px';
miningOverlay.style.height = '10px';
miningOverlay.style.background = 'rgba(0,0,0,0.45)';
miningOverlay.style.border = '1px solid rgba(255,255,255,0.45)';
miningOverlay.style.borderRadius = '999px';
miningOverlay.style.overflow = 'hidden';
miningOverlay.style.pointerEvents = 'none';
miningOverlay.style.display = 'none';
miningOverlay.style.zIndex = '25';

const miningFill = document.createElement('div');
miningFill.style.width = '0%';
miningFill.style.height = '100%';
miningFill.style.background = 'linear-gradient(90deg, #fde047, #f59e0b)';
miningOverlay.appendChild(miningFill);
app.appendChild(miningOverlay);

let selectedPlaceBlock: BlockId | null = BlockId.Dirt;

type InventoryStack = {
  block: BlockId;
  count: number;
};

type ItemVisual = {
  label: string;
  tile: number;
  color: string;
};

const itemVisualByBlock: Partial<Record<BlockId, ItemVisual>> = {
  [BlockId.Grass]: { label: 'Grass', tile: 0, color: '#3f8f3f' },
  [BlockId.Dirt]: { label: 'Dirt', tile: 2, color: '#8b5a3c' },
  [BlockId.Stone]: { label: 'Stone', tile: 3, color: '#7b7b84' },
  [BlockId.Sand]: { label: 'Sand', tile: 4, color: '#d8c070' },
  [BlockId.WoodLog]: { label: 'Log', tile: 7, color: '#8b6a45' },
  [BlockId.Leaves]: { label: 'Leaves', tile: 8, color: '#58a158' },
  [BlockId.CoalOre]: { label: 'Coal Ore', tile: 9, color: '#50505a' },
  [BlockId.IronOre]: { label: 'Iron Ore', tile: 10, color: '#b7936a' },
  [BlockId.GoldOre]: { label: 'Gold Ore', tile: 11, color: '#f7c845' }
};

const HOTBAR_SLOT_COUNT = 5;
const BACKPACK_SLOT_COUNT = 20;
const TOTAL_INVENTORY_SLOTS = HOTBAR_SLOT_COUNT + BACKPACK_SLOT_COUNT;
const INVENTORY_STACK_LIMIT = 64;

const inventorySlots: Array<InventoryStack | null> = Array.from({ length: TOTAL_INVENTORY_SLOTS }, () => null);
inventorySlots[0] = { block: BlockId.Dirt, count: 48 };

let selectedHotbarIndex = 0;
let selectedInventoryIndex: number | null = null;
let heldItemMesh: THREE.Mesh | null = null;

const hotbarRoot = document.createElement('div');
hotbarRoot.style.position = 'fixed';
hotbarRoot.style.left = '50%';
hotbarRoot.style.bottom = '16px';
hotbarRoot.style.transform = 'translateX(-50%)';
hotbarRoot.style.display = 'flex';
hotbarRoot.style.alignItems = 'center';
hotbarRoot.style.gap = '8px';
hotbarRoot.style.padding = '8px 10px';
hotbarRoot.style.borderRadius = '14px';
hotbarRoot.style.background = 'rgba(8,10,14,0.62)';
hotbarRoot.style.border = '1px solid rgba(255,255,255,0.2)';
hotbarRoot.style.backdropFilter = 'blur(1px)';
hotbarRoot.style.zIndex = '26';
hotbarRoot.style.pointerEvents = 'none';
app.appendChild(hotbarRoot);

const hotbarButtons: HTMLButtonElement[] = [];
const hotbarIcons: HTMLDivElement[] = [];
const hotbarCounts: HTMLSpanElement[] = [];

function applyIconStyle(icon: HTMLDivElement, block: BlockId | null): void {
  if (block === null) {
    icon.style.backgroundImage = 'none';
    icon.style.backgroundColor = 'rgba(255,255,255,0.06)';
    return;
  }

  const visual = itemVisualByBlock[block];
  if (!visual) {
    icon.style.backgroundImage = 'none';
    icon.style.backgroundColor = 'rgba(255,255,255,0.06)';
    return;
  }

  const tileX = (visual.tile % 4) * 16;
  const tileY = Math.floor(visual.tile / 4) * 16;
  icon.style.backgroundColor = visual.color;
  icon.style.backgroundImage = "url('/textures/atlas.png')";
  icon.style.backgroundRepeat = 'no-repeat';
  icon.style.backgroundSize = '64px 64px';
  icon.style.backgroundPosition = `-${tileX}px -${tileY}px`;
}

for (let index = 0; index < HOTBAR_SLOT_COUNT; index++) {
  const button = document.createElement('button');
  button.type = 'button';
  button.style.width = '52px';
  button.style.height = '52px';
  button.style.borderRadius = '10px';
  button.style.border = '2px solid rgba(255,255,255,0.2)';
  button.style.background = 'rgba(0,0,0,0.58)';
  button.style.position = 'relative';
  button.style.pointerEvents = 'auto';
  button.style.touchAction = 'manipulation';
  button.style.padding = '0';

  const icon = document.createElement('div');
  icon.style.position = 'absolute';
  icon.style.left = '7px';
  icon.style.top = '7px';
  icon.style.width = '28px';
  icon.style.height = '28px';
  icon.style.borderRadius = '6px';
  icon.style.imageRendering = 'pixelated';
  icon.style.boxShadow = 'inset 0 0 0 1px rgba(255,255,255,0.15)';

  const count = document.createElement('span');
  count.style.position = 'absolute';
  count.style.right = '5px';
  count.style.bottom = '4px';
  count.style.color = '#fff';
  count.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, monospace';
  count.style.fontSize = '13px';
  count.style.fontWeight = '700';
  count.style.textShadow = '0 1px 2px rgba(0,0,0,0.9)';
  count.textContent = '';

  button.append(icon, count);

  const selectSlot = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    selectedHotbarIndex = index;
    refreshPlacementHud();
  };

  button.addEventListener('click', selectSlot);
  button.addEventListener('touchstart', selectSlot, { passive: false });

  hotbarButtons.push(button);
  hotbarIcons.push(icon);
  hotbarCounts.push(count);
  hotbarRoot.appendChild(button);
}

const backpackButton = document.createElement('button');
backpackButton.type = 'button';
backpackButton.textContent = '🎒';
backpackButton.title = 'Inventory';
backpackButton.style.width = '44px';
backpackButton.style.height = '44px';
backpackButton.style.borderRadius = '10px';
backpackButton.style.border = '2px solid rgba(255,255,255,0.2)';
backpackButton.style.background = 'rgba(0,0,0,0.58)';
backpackButton.style.color = '#fff';
backpackButton.style.fontSize = '20px';
backpackButton.style.pointerEvents = 'auto';
backpackButton.style.touchAction = 'manipulation';
hotbarRoot.appendChild(backpackButton);

const craftButton = document.createElement('button');
craftButton.type = 'button';
craftButton.textContent = '🛠️';
craftButton.title = 'Crafting';
craftButton.style.width = '44px';
craftButton.style.height = '44px';
craftButton.style.borderRadius = '10px';
craftButton.style.border = '2px solid rgba(255,255,255,0.2)';
craftButton.style.background = 'rgba(0,0,0,0.58)';
craftButton.style.color = '#fff';
craftButton.style.fontSize = '20px';
craftButton.style.pointerEvents = 'auto';
craftButton.style.touchAction = 'manipulation';
hotbarRoot.appendChild(craftButton);

const inventoryOverlay = document.createElement('div');
inventoryOverlay.style.position = 'fixed';
inventoryOverlay.style.inset = '0';
inventoryOverlay.style.background = 'rgba(0,0,0,0.6)';
inventoryOverlay.style.display = 'none';
inventoryOverlay.style.alignItems = 'center';
inventoryOverlay.style.justifyContent = 'center';
inventoryOverlay.style.zIndex = '40';
inventoryOverlay.style.pointerEvents = 'auto';
app.appendChild(inventoryOverlay);

const inventoryPanel = document.createElement('div');
inventoryPanel.style.width = 'min(92vw, 460px)';
inventoryPanel.style.maxHeight = '84vh';
inventoryPanel.style.overflow = 'auto';
inventoryPanel.style.background = 'rgba(14,16,22,0.94)';
inventoryPanel.style.border = '1px solid rgba(255,255,255,0.2)';
inventoryPanel.style.borderRadius = '14px';
inventoryPanel.style.padding = '14px';
inventoryPanel.style.color = '#fff';
inventoryPanel.style.fontFamily = 'system-ui, sans-serif';
inventoryPanel.addEventListener('click', (event) => event.stopPropagation());
inventoryOverlay.appendChild(inventoryPanel);

const inventoryHeader = document.createElement('div');
inventoryHeader.style.display = 'flex';
inventoryHeader.style.justifyContent = 'space-between';
inventoryHeader.style.alignItems = 'center';
inventoryHeader.style.marginBottom = '12px';

const inventoryTitle = document.createElement('strong');
inventoryTitle.textContent = 'Inventory';

const inventoryCloseButton = document.createElement('button');
inventoryCloseButton.type = 'button';
inventoryCloseButton.textContent = 'Close';
inventoryCloseButton.style.borderRadius = '8px';
inventoryCloseButton.style.border = '1px solid rgba(255,255,255,0.25)';
inventoryCloseButton.style.background = 'rgba(255,255,255,0.08)';
inventoryCloseButton.style.color = '#fff';
inventoryCloseButton.style.padding = '5px 10px';
inventoryHeader.append(inventoryTitle, inventoryCloseButton);
inventoryPanel.appendChild(inventoryHeader);

const inventoryGrid = document.createElement('div');
inventoryGrid.style.display = 'grid';
inventoryGrid.style.gridTemplateColumns = 'repeat(5, minmax(0, 1fr))';
inventoryGrid.style.gap = '8px';
inventoryPanel.appendChild(inventoryGrid);

const inventoryHotbarLabel = document.createElement('div');
inventoryHotbarLabel.textContent = 'Hotbar';
inventoryHotbarLabel.style.marginTop = '14px';
inventoryHotbarLabel.style.marginBottom = '8px';
inventoryHotbarLabel.style.fontSize = '13px';
inventoryHotbarLabel.style.opacity = '0.85';
inventoryPanel.appendChild(inventoryHotbarLabel);

const inventoryHotbarGrid = document.createElement('div');
inventoryHotbarGrid.style.display = 'grid';
inventoryHotbarGrid.style.gridTemplateColumns = 'repeat(5, minmax(0, 1fr))';
inventoryHotbarGrid.style.gap = '8px';
inventoryPanel.appendChild(inventoryHotbarGrid);

const inventorySelectionInfo = document.createElement('div');
inventorySelectionInfo.style.marginTop = '12px';
inventorySelectionInfo.style.fontSize = '13px';
inventorySelectionInfo.style.opacity = '0.9';
inventorySelectionInfo.textContent = 'Tap an item, then tap destination to move.';
inventoryPanel.appendChild(inventorySelectionInfo);

const inventoryButtons: HTMLButtonElement[] = [];
const inventoryIcons: HTMLDivElement[] = [];
const inventoryCounts: HTMLSpanElement[] = [];

function createInventorySlotButton(slotIndex: number): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.style.height = '54px';
  button.style.borderRadius = '10px';
  button.style.border = '2px solid rgba(255,255,255,0.2)';
  button.style.background = 'rgba(0,0,0,0.55)';
  button.style.position = 'relative';
  button.style.padding = '0';

  const icon = document.createElement('div');
  icon.style.position = 'absolute';
  icon.style.left = '8px';
  icon.style.top = '8px';
  icon.style.width = '28px';
  icon.style.height = '28px';
  icon.style.borderRadius = '6px';
  icon.style.imageRendering = 'pixelated';
  icon.style.boxShadow = 'inset 0 0 0 1px rgba(255,255,255,0.15)';

  const count = document.createElement('span');
  count.style.position = 'absolute';
  count.style.right = '6px';
  count.style.bottom = '5px';
  count.style.color = '#fff';
  count.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, monospace';
  count.style.fontSize = '12px';
  count.style.fontWeight = '700';
  count.style.textShadow = '0 1px 2px rgba(0,0,0,0.9)';

  button.append(icon, count);
  button.addEventListener('click', (event) => {
    event.preventDefault();
    moveInventorySelection(slotIndex);
  });

  inventoryIcons[slotIndex] = icon;
  inventoryCounts[slotIndex] = count;
  inventoryButtons[slotIndex] = button;
  return button;
}

for (let i = HOTBAR_SLOT_COUNT; i < TOTAL_INVENTORY_SLOTS; i++) {
  inventoryGrid.appendChild(createInventorySlotButton(i));
}
for (let i = 0; i < HOTBAR_SLOT_COUNT; i++) {
  inventoryHotbarGrid.appendChild(createInventorySlotButton(i));
}

function stackLabel(stack: InventoryStack | null): string {
  if (!stack) return 'Empty';
  return itemVisualByBlock[stack.block]?.label ?? 'Item';
}

function getSelectedHotbarStack(): InventoryStack | null {
  return inventorySlots[selectedHotbarIndex];
}

function updateHeldItemVisual(): void {
  const selectedStack = getSelectedHotbarStack();
  const selectedBlock = selectedStack?.block ?? null;
  const currentBlock = (heldItemMesh?.userData?.block as BlockId | undefined) ?? null;

  if (selectedBlock === null) {
    if (heldItemMesh) {
      player.remove(heldItemMesh);
      heldItemMesh = null;
    }
    return;
  }

  if (heldItemMesh && currentBlock === selectedBlock) {
    return;
  }

  if (heldItemMesh) {
    player.remove(heldItemMesh);
    heldItemMesh = null;
  }

  if (!worldAtlasTexture) {
    heldItemMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.32, 0.32, 0.32),
      new THREE.MeshStandardMaterial({ color: 0xd1d5db, roughness: 0.7, metalness: 0.05 })
    );
  } else {
    heldItemMesh = createVoxelBlockMesh({
      atlasTexture: worldAtlasTexture,
      tiles: blockTilesById[selectedBlock],
      atlasColumns: 4,
      atlasRows: 4,
      size: 0.32
    });
  }

  heldItemMesh.userData.block = selectedBlock;
  heldItemMesh.position.set(0.52, 0.98, 0.18);
  heldItemMesh.rotation.set(0.22, -0.42, 0);
  player.add(heldItemMesh);
}

function canAddItemToInventory(block: BlockId, amount = 1): boolean {
  let capacity = 0;
  for (let i = 0; i < TOTAL_INVENTORY_SLOTS; i++) {
    const slot = inventorySlots[i];
    if (!slot) {
      capacity += INVENTORY_STACK_LIMIT;
    } else if (slot.block === block) {
      capacity += INVENTORY_STACK_LIMIT - slot.count;
    }
    if (capacity >= amount) {
      return true;
    }
  }

  return capacity >= amount;
}

function addItemToInventory(block: BlockId, amount = 1): number {
  let remaining = amount;

  for (let i = 0; i < TOTAL_INVENTORY_SLOTS && remaining > 0; i++) {
    const stack = inventorySlots[i];
    if (!stack || stack.block !== block || stack.count >= INVENTORY_STACK_LIMIT) continue;
    const room = INVENTORY_STACK_LIMIT - stack.count;
    const transfer = Math.min(room, remaining);
    stack.count += transfer;
    remaining -= transfer;
  }

  for (let i = 0; i < TOTAL_INVENTORY_SLOTS && remaining > 0; i++) {
    if (inventorySlots[i]) continue;
    const transfer = Math.min(INVENTORY_STACK_LIMIT, remaining);
    inventorySlots[i] = { block, count: transfer };
    remaining -= transfer;
  }

  refreshPlacementHud();
  return amount - remaining;
}

function moveInventorySelection(targetIndex: number): void {
  const targetStack = inventorySlots[targetIndex];
  if (selectedInventoryIndex === null) {
    if (!targetStack) return;
    selectedInventoryIndex = targetIndex;
    refreshPlacementHud();
    return;
  }

  if (selectedInventoryIndex === targetIndex) {
    selectedInventoryIndex = null;
    refreshPlacementHud();
    return;
  }

  const sourceIndex = selectedInventoryIndex;
  const sourceStack = inventorySlots[sourceIndex];
  if (!sourceStack) {
    selectedInventoryIndex = null;
    refreshPlacementHud();
    return;
  }

  if (!targetStack) {
    inventorySlots[targetIndex] = sourceStack;
    inventorySlots[sourceIndex] = null;
  } else if (targetStack.block === sourceStack.block) {
    const room = INVENTORY_STACK_LIMIT - targetStack.count;
    const transfer = Math.min(room, sourceStack.count);
    targetStack.count += transfer;
    sourceStack.count -= transfer;
    if (sourceStack.count <= 0) inventorySlots[sourceIndex] = null;
  } else {
    inventorySlots[targetIndex] = sourceStack;
    inventorySlots[sourceIndex] = targetStack;
  }

  selectedInventoryIndex = null;
  refreshPlacementHud();
}

const placementHud = document.createElement('div');
placementHud.style.position = 'fixed';
placementHud.style.left = '50%';
placementHud.style.bottom = '84px';
placementHud.style.transform = 'translateX(-50%)';
placementHud.style.padding = '5px 10px';
placementHud.style.borderRadius = '8px';
placementHud.style.background = 'rgba(0,0,0,0.48)';
placementHud.style.border = '1px solid rgba(255,255,255,0.3)';
placementHud.style.color = '#fff';
placementHud.style.fontFamily = 'system-ui, sans-serif';
placementHud.style.fontSize = '12px';
placementHud.style.zIndex = '25';
placementHud.style.pointerEvents = 'none';
app.appendChild(placementHud);

const placementPreview = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshBasicMaterial({ color: 0x60a5fa, transparent: true, opacity: 0.35, depthWrite: false })
);
placementPreview.visible = false;
placementPreview.renderOrder = 3;
scene.add(placementPreview);

let activePlacementTarget: PlacementTarget | null = null;

function refreshPlacementHud(): void {
  const selectedStack = getSelectedHotbarStack();
  selectedPlaceBlock = selectedStack?.block ?? null;

  for (let i = 0; i < HOTBAR_SLOT_COUNT; i++) {
    const button = hotbarButtons[i];
    const stack = inventorySlots[i];
    applyIconStyle(hotbarIcons[i], stack?.block ?? null);
    hotbarCounts[i].textContent = stack ? String(stack.count) : '';

    const isSelected = i === selectedHotbarIndex;
    button.style.border = isSelected ? '2px solid #facc15' : '2px solid rgba(255,255,255,0.2)';
    button.style.boxShadow = isSelected ? '0 0 0 1px rgba(250,204,21,0.35)' : 'none';
    button.style.opacity = stack || isSelected ? '1' : '0.72';
    button.title = stackLabel(stack);
  }

  for (let i = 0; i < TOTAL_INVENTORY_SLOTS; i++) {
    const button = inventoryButtons[i];
    if (!button) continue;
    const stack = inventorySlots[i];
    applyIconStyle(inventoryIcons[i], stack?.block ?? null);
    inventoryCounts[i].textContent = stack ? String(stack.count) : '';

    const isHotbarSlot = i < HOTBAR_SLOT_COUNT;
    const isSource = selectedInventoryIndex === i;
    button.style.border = isSource
      ? '2px solid #38bdf8'
      : isHotbarSlot
      ? '2px solid rgba(250,204,21,0.4)'
      : '2px solid rgba(255,255,255,0.2)';
  }

  if (selectedInventoryIndex !== null) {
    const stack = inventorySlots[selectedInventoryIndex];
    inventorySelectionInfo.textContent = stack
      ? `Selected: ${stackLabel(stack)} ×${stack.count}. Tap destination slot.`
      : 'Tap an item, then tap destination to move.';
  } else {
    inventorySelectionInfo.textContent = 'Tap an item, then tap destination to move.';
  }

  updateHeldItemVisual();

  if (!selectedStack) {
    placementHud.textContent = 'Selected: Empty slot — pick a hotbar item';
    return;
  }

  const label = itemVisualByBlock[selectedStack.block]?.label ?? 'Item';
  placementHud.textContent = `Selected: ${label} (${selectedStack.count}) — RMB / long-press to place`;
}

backpackButton.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  inventoryOverlay.style.display = 'flex';
  selectedInventoryIndex = null;
  refreshPlacementHud();
});

inventoryCloseButton.addEventListener('click', (event) => {
  event.preventDefault();
  inventoryOverlay.style.display = 'none';
  selectedInventoryIndex = null;
  refreshPlacementHud();
});

inventoryOverlay.addEventListener('click', () => {
  inventoryOverlay.style.display = 'none';
  selectedInventoryIndex = null;
  refreshPlacementHud();
});

type CraftCategory = 'All' | 'Tools' | 'Building' | 'Materials';
type CraftIngredient = { block: BlockId; count: number };
type CraftRecipe = {
  id: string;
  name: string;
  category: Exclude<CraftCategory, 'All'>;
  output: { block: BlockId; count: number };
  inputs: CraftIngredient[];
};

const craftRecipes: CraftRecipe[] = [
  {
    id: 'leaf-mulch',
    name: 'Leaf Mulch',
    category: 'Materials',
    output: { block: BlockId.Dirt, count: 1 },
    inputs: [{ block: BlockId.Leaves, count: 3 }]
  },
  {
    id: 'stone-pack',
    name: 'Stone Pack',
    category: 'Building',
    output: { block: BlockId.Stone, count: 1 },
    inputs: [{ block: BlockId.Dirt, count: 4 }]
  },
  {
    id: 'charcoal-mix',
    name: 'Charcoal Mix',
    category: 'Tools',
    output: { block: BlockId.CoalOre, count: 1 },
    inputs: [
      { block: BlockId.WoodLog, count: 2 },
      { block: BlockId.Leaves, count: 2 }
    ]
  }
];

let activeCraftCategory: CraftCategory = 'All';
const craftingOverlay = document.createElement('div');
craftingOverlay.style.position = 'fixed';
craftingOverlay.style.inset = '0';
craftingOverlay.style.background = 'rgba(0,0,0,0.62)';
craftingOverlay.style.display = 'none';
craftingOverlay.style.alignItems = 'center';
craftingOverlay.style.justifyContent = 'center';
craftingOverlay.style.zIndex = '45';
craftingOverlay.style.pointerEvents = 'auto';
app.appendChild(craftingOverlay);

const craftingPanel = document.createElement('div');
craftingPanel.style.width = 'min(92vw, 520px)';
craftingPanel.style.maxHeight = '84vh';
craftingPanel.style.display = 'flex';
craftingPanel.style.flexDirection = 'column';
craftingPanel.style.background = 'rgba(14,16,22,0.95)';
craftingPanel.style.border = '1px solid rgba(255,255,255,0.2)';
craftingPanel.style.borderRadius = '14px';
craftingPanel.style.padding = '12px';
craftingPanel.style.color = '#fff';
craftingPanel.style.fontFamily = 'system-ui, sans-serif';
craftingPanel.addEventListener('click', (event) => event.stopPropagation());
craftingOverlay.appendChild(craftingPanel);

const craftingHeader = document.createElement('div');
craftingHeader.style.display = 'flex';
craftingHeader.style.justifyContent = 'space-between';
craftingHeader.style.alignItems = 'center';
craftingHeader.style.marginBottom = '10px';

const craftingTitle = document.createElement('strong');
craftingTitle.textContent = 'Crafting';
const craftingCloseButton = document.createElement('button');
craftingCloseButton.type = 'button';
craftingCloseButton.textContent = 'Close';
craftingCloseButton.style.borderRadius = '8px';
craftingCloseButton.style.border = '1px solid rgba(255,255,255,0.25)';
craftingCloseButton.style.background = 'rgba(255,255,255,0.08)';
craftingCloseButton.style.color = '#fff';
craftingCloseButton.style.padding = '5px 10px';
craftingHeader.append(craftingTitle, craftingCloseButton);
craftingPanel.appendChild(craftingHeader);

const craftingCategoryRow = document.createElement('div');
craftingCategoryRow.style.display = 'flex';
craftingCategoryRow.style.gap = '6px';
craftingCategoryRow.style.flexWrap = 'wrap';
craftingCategoryRow.style.marginBottom = '10px';
craftingPanel.appendChild(craftingCategoryRow);

const craftingList = document.createElement('div');
craftingList.style.overflowY = 'auto';
craftingList.style.maxHeight = '58vh';
craftingList.style.display = 'flex';
craftingList.style.flexDirection = 'column';
craftingList.style.gap = '8px';
craftingPanel.appendChild(craftingList);

const craftingHint = document.createElement('div');
craftingHint.style.marginTop = '10px';
craftingHint.style.opacity = '0.85';
craftingHint.style.fontSize = '12px';
craftingHint.textContent = 'Tap recipe to craft 1. Long-press a craftable recipe to craft max.';
craftingPanel.appendChild(craftingHint);

function getInventoryCount(block: BlockId): number {
  let total = 0;
  for (const slot of inventorySlots) {
    if (slot?.block === block) {
      total += slot.count;
    }
  }
  return total;
}

function removeItemFromInventory(block: BlockId, amount: number): boolean {
  if (getInventoryCount(block) < amount) {
    return false;
  }

  let remaining = amount;
  for (let i = 0; i < TOTAL_INVENTORY_SLOTS && remaining > 0; i++) {
    const slot = inventorySlots[i];
    if (!slot || slot.block !== block) continue;
    const take = Math.min(slot.count, remaining);
    slot.count -= take;
    remaining -= take;
    if (slot.count <= 0) {
      inventorySlots[i] = null;
    }
  }

  return remaining <= 0;
}

function canCraftRecipe(recipe: CraftRecipe): boolean {
  return recipe.inputs.every((input) => getInventoryCount(input.block) >= input.count);
}

function craftRecipe(recipe: CraftRecipe, amount: number): number {
  let crafted = 0;
  for (let i = 0; i < amount; i++) {
    if (!canCraftRecipe(recipe)) break;
    if (!canAddItemToInventory(recipe.output.block, recipe.output.count)) break;

    let consumedAll = true;
    for (const input of recipe.inputs) {
      if (!removeItemFromInventory(input.block, input.count)) {
        consumedAll = false;
        break;
      }
    }

    if (!consumedAll) break;
    addItemToInventory(recipe.output.block, recipe.output.count);
    crafted += 1;
  }

  if (crafted > 0) {
    refreshPlacementHud();
    renderCraftingRecipes();
  }

  return crafted;
}

function maxCraftableCount(recipe: CraftRecipe): number {
  let max = Number.POSITIVE_INFINITY;
  for (const input of recipe.inputs) {
    max = Math.min(max, Math.floor(getInventoryCount(input.block) / input.count));
  }
  return Number.isFinite(max) ? max : 0;
}

function itemLabel(block: BlockId): string {
  return itemVisualByBlock[block]?.label ?? 'Item';
}

function renderCraftingRecipes(): void {
  while (craftingList.firstChild) {
    craftingList.removeChild(craftingList.firstChild);
  }

  const recipes = craftRecipes.filter((recipe) => activeCraftCategory === 'All' || recipe.category === activeCraftCategory);
  const sorted = recipes.sort((a, b) => Number(canCraftRecipe(b)) - Number(canCraftRecipe(a)));

  for (const recipe of sorted) {
    const available = canCraftRecipe(recipe);
    const recipeButton = document.createElement('button');
    recipeButton.type = 'button';
    recipeButton.style.width = '100%';
    recipeButton.style.textAlign = 'left';
    recipeButton.style.border = available ? '1px solid rgba(134,239,172,0.5)' : '1px solid rgba(255,255,255,0.2)';
    recipeButton.style.background = available ? 'rgba(34,197,94,0.12)' : 'rgba(0,0,0,0.25)';
    recipeButton.style.borderRadius = '10px';
    recipeButton.style.padding = '10px';
    recipeButton.style.color = '#fff';
    recipeButton.style.opacity = available ? '1' : '0.6';

    const outputLine = document.createElement('div');
    outputLine.style.fontWeight = '700';
    outputLine.style.marginBottom = '4px';
    outputLine.textContent = `${itemLabel(recipe.output.block)} ×${recipe.output.count}`;

    const inputLine = document.createElement('div');
    inputLine.style.fontSize = '12px';
    inputLine.style.opacity = '0.9';
    inputLine.textContent = recipe.inputs
      .map((input) => `${itemLabel(input.block)} ×${input.count} (have ${getInventoryCount(input.block)})`)
      .join('  •  ');

    const metaLine = document.createElement('div');
    metaLine.style.fontSize = '11px';
    metaLine.style.marginTop = '4px';
    metaLine.style.opacity = '0.8';
    metaLine.textContent = `Category: ${recipe.category}`;

    recipeButton.append(outputLine, inputLine, metaLine);

    let longPressTimer = 0;
    let longPressTriggered = false;
    const clearLongPress = () => {
      if (longPressTimer) {
        window.clearTimeout(longPressTimer);
        longPressTimer = 0;
      }
    };

    recipeButton.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      if (!canCraftRecipe(recipe)) return;
      longPressTriggered = false;
      clearLongPress();
      longPressTimer = window.setTimeout(() => {
        longPressTimer = 0;
        longPressTriggered = true;
        const maxAmount = maxCraftableCount(recipe);
        if (maxAmount > 0) {
          craftRecipe(recipe, maxAmount);
        }
      }, 420);
    });

    recipeButton.addEventListener('pointerup', (event) => {
      event.preventDefault();
      if (!canCraftRecipe(recipe)) {
        clearLongPress();
        return;
      }

      clearLongPress();
      if (!longPressTriggered) {
        craftRecipe(recipe, 1);
      }
    });

    recipeButton.addEventListener('pointerleave', clearLongPress);
    recipeButton.addEventListener('pointercancel', clearLongPress);

    craftingList.appendChild(recipeButton);
  }
}

function renderCraftCategories(): void {
  while (craftingCategoryRow.firstChild) {
    craftingCategoryRow.removeChild(craftingCategoryRow.firstChild);
  }

  const categories: CraftCategory[] = ['All', 'Tools', 'Building', 'Materials'];
  for (const category of categories) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.textContent = category;
    tab.style.borderRadius = '999px';
    tab.style.border = category === activeCraftCategory ? '1px solid rgba(250,204,21,0.7)' : '1px solid rgba(255,255,255,0.25)';
    tab.style.background = category === activeCraftCategory ? 'rgba(250,204,21,0.2)' : 'rgba(255,255,255,0.06)';
    tab.style.color = '#fff';
    tab.style.padding = '4px 10px';
    tab.style.fontSize = '12px';
    tab.addEventListener('click', () => {
      activeCraftCategory = category;
      renderCraftCategories();
      renderCraftingRecipes();
    });
    craftingCategoryRow.appendChild(tab);
  }
}

craftButton.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  inventoryOverlay.style.display = 'none';
  selectedInventoryIndex = null;
  craftingOverlay.style.display = 'flex';
  renderCraftCategories();
  renderCraftingRecipes();
  refreshPlacementHud();
});

craftingCloseButton.addEventListener('click', (event) => {
  event.preventDefault();
  craftingOverlay.style.display = 'none';
  refreshPlacementHud();
});

craftingOverlay.addEventListener('click', () => {
  craftingOverlay.style.display = 'none';
  refreshPlacementHud();
});

refreshPlacementHud();

let activeMiningTarget: MiningTarget | null = null;
let miningStartMs = 0;
let miningDurationMs = 0;
let miningGhost: THREE.Mesh | null = null;
type DroppedItemMesh = THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial> & {
  userData: {
    spawnMs: number;
    baseY: number;
    block: BlockId;
  };
};
const droppedItems: DroppedItemMesh[] = [];
const droppedItemPool = new Map<BlockId, DroppedItemMesh[]>();
const PICKUP_RADIUS = 1.5;

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

function getMiningTargetFromTap(clientX: number, clientY: number): MiningTarget | null {
  if (terrainMeshes.length === 0) {
    return null;
  }

  screenToNdc(clientX, clientY);
  raycaster.setFromCamera(pointerNdc, camera);

  const terrainHits = raycaster.intersectObjects(terrainMeshes, false);
  if (terrainHits.length === 0) {
    return null;
  }

  const hit = terrainHits[0];
  const terrainPoint = new THREE.Vector3(sceneToTerrainX(hit.point.x), hit.point.y, sceneToTerrainZ(hit.point.z));
  const inwardNormal = hit.face?.normal.clone().negate() ?? new THREE.Vector3(0, 1, 0);
  const blockPos = terrainPoint.addScaledVector(inwardNormal, 0.01);

  const worldX = Math.floor(blockPos.x);
  const worldY = Math.floor(blockPos.y);
  const worldZ = Math.floor(blockPos.z);

  const xSplit = splitChunkAndLocal(worldX);
  const zSplit = splitChunkAndLocal(worldZ);
  const record = worldChunkByKey.get(worldChunkKey(xSplit.chunk, zSplit.chunk));
  if (!record) {
    return null;
  }

  const block = record.chunk.get(xSplit.local, worldY, zSplit.local);
  if (block === BlockId.Air || block === BlockId.Water) {
    return null;
  }

  return {
    chunkX: xSplit.chunk,
    chunkZ: zSplit.chunk,
    localX: xSplit.local,
    localY: worldY,
    localZ: zSplit.local,
    worldX,
    worldY,
    worldZ,
    block
  };
}

function startMining(target: MiningTarget): void {
  activeMiningTarget = target;
  miningStartMs = performance.now();
  miningDurationMs = blockMiningTimeMs[target.block] ?? 800;
  miningOverlay.style.display = 'block';
  miningFill.style.width = '0%';
}

function acquireDroppedItem(block: BlockId): DroppedItemMesh | null {
  const pool = droppedItemPool.get(block);
  const reused = pool?.pop();
  if (reused) {
    reused.visible = true;
    return reused;
  }

  if (!worldAtlasTexture) {
    return null;
  }

  const mesh = createVoxelBlockMesh({
    atlasTexture: worldAtlasTexture,
    tiles: blockTilesById[block],
    atlasColumns: 4,
    atlasRows: 4,
    size: 0.35
  }) as DroppedItemMesh;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}

function releaseDroppedItem(item: DroppedItemMesh): void {
  scene.remove(item);
  item.visible = false;
  const block = item.userData.block;
  const pool = droppedItemPool.get(block) ?? [];
  pool.push(item);
  droppedItemPool.set(block, pool);
}

function addToInventory(block: BlockId, amount = 1): number {
  return addItemToInventory(block, amount);
}

function spawnDroppedItem(block: BlockId, worldX: number, worldY: number, worldZ: number): void {
  const mesh = acquireDroppedItem(block);
  if (!mesh) {
    return;
  }

  mesh.position.set(terrainToSceneX(worldX + 0.5), worldY + 0.45, terrainToSceneZ(worldZ + 0.5));
  mesh.userData.spawnMs = performance.now();
  mesh.userData.baseY = worldY + 0.45;
  mesh.userData.block = block;
  scene.add(mesh);
  droppedItems.push(mesh);
}

function rebuildChunkMeshes(record: WorldChunk, blockTiles: Record<BlockId, FaceTileMap>): void {
  const terrainGeometry = buildChunkGreedyGeometry({
    chunk: record.chunk,
    blockTiles,
    shouldRender: (block) => block !== BlockId.Air && block !== BlockId.Leaves,
    isOpaque: (block) => block !== BlockId.Air && block !== BlockId.Leaves
  });
  record.terrainMesh.geometry.dispose();
  record.terrainMesh.geometry = terrainGeometry;

  const leavesGeometry = buildChunkGreedyGeometry({
    chunk: record.chunk,
    blockTiles,
    shouldRender: (block) => block === BlockId.Leaves,
    isOpaque: (block) => block === BlockId.Leaves
  });
  record.leavesMesh.geometry.dispose();
  record.leavesMesh.geometry = leavesGeometry;
}

function beginBreakAnimation(target: MiningTarget): void {
  if (miningGhost) {
    scene.remove(miningGhost);
    miningGhost = null;
  }

  miningGhost = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45 })
  );
  miningGhost.position.set(terrainToSceneX(target.worldX + 0.5), target.worldY + 0.5, terrainToSceneZ(target.worldZ + 0.5));
  miningGhost.userData.spawnMs = performance.now();
  scene.add(miningGhost);
}

function getBlockAtWorld(worldX: number, worldY: number, worldZ: number): { record: WorldChunk; localX: number; localZ: number; chunkX: number; chunkZ: number } | null {
  if (worldY < 0 || worldY >= CHUNK_HEIGHT) {
    return null;
  }

  const xSplit = splitChunkAndLocal(worldX);
  const zSplit = splitChunkAndLocal(worldZ);
  const record = worldChunkByKey.get(worldChunkKey(xSplit.chunk, zSplit.chunk));
  if (!record) {
    return null;
  }

  return { record, localX: xSplit.local, localZ: zSplit.local, chunkX: xSplit.chunk, chunkZ: zSplit.chunk };
}

function getPlacementTargetFromPointer(clientX: number, clientY: number): PlacementTarget | null {
  if (terrainMeshes.length === 0) {
    return null;
  }

  screenToNdc(clientX, clientY);
  raycaster.setFromCamera(pointerNdc, camera);

  const hits = raycaster.intersectObjects([...terrainMeshes, ...leavesMeshes], false);
  if (hits.length === 0) {
    return null;
  }

  const hit = hits[0];
  const normal = hit.face?.normal.clone() ?? new THREE.Vector3(0, 1, 0);
  const terrainPoint = new THREE.Vector3(sceneToTerrainX(hit.point.x), hit.point.y, sceneToTerrainZ(hit.point.z));
  const placePoint = terrainPoint.addScaledVector(normal, 0.01);

  const worldX = Math.floor(placePoint.x);
  const worldY = Math.floor(placePoint.y);
  const worldZ = Math.floor(placePoint.z);

  const blockEntry = getBlockAtWorld(worldX, worldY, worldZ);
  if (!blockEntry) {
    return null;
  }

  if (blockEntry.record.chunk.get(blockEntry.localX, worldY, blockEntry.localZ) !== BlockId.Air) {
    return null;
  }

  const supportPoint = terrainPoint.addScaledVector(normal, -0.01);
  const supportX = Math.floor(supportPoint.x);
  const supportY = Math.floor(supportPoint.y);
  const supportZ = Math.floor(supportPoint.z);
  const supportEntry = getBlockAtWorld(supportX, supportY, supportZ);
  if (!supportEntry) {
    return null;
  }

  const supportBlock = supportEntry.record.chunk.get(supportEntry.localX, supportY, supportEntry.localZ);
  if (supportBlock === BlockId.Air || supportBlock === BlockId.Water) {
    return null;
  }

  return {
    chunkX: supportEntry.chunkX,
    chunkZ: supportEntry.chunkZ,
    localX: blockEntry.localX,
    localY: worldY,
    localZ: blockEntry.localZ,
    worldX,
    worldY,
    worldZ
  };
}

function isPlacementInsidePlayer(target: PlacementTarget): boolean {
  const px = playerTerrainPos.x;
  const py = playerTerrainPos.y;
  const pz = playerTerrainPos.z;
  const playerMinX = px - 0.35;
  const playerMaxX = px + 0.35;
  const playerMinZ = pz - 0.35;
  const playerMaxZ = pz + 0.35;
  const playerMinY = py - 1;
  const playerMaxY = py + 1;

  const blockMinX = target.worldX;
  const blockMaxX = target.worldX + 1;
  const blockMinY = target.worldY;
  const blockMaxY = target.worldY + 1;
  const blockMinZ = target.worldZ;
  const blockMaxZ = target.worldZ + 1;

  return !(
    blockMaxX <= playerMinX ||
    blockMinX >= playerMaxX ||
    blockMaxY <= playerMinY ||
    blockMinY >= playerMaxY ||
    blockMaxZ <= playerMinZ ||
    blockMinZ >= playerMaxZ
  );
}

function updatePlacementPreview(clientX: number, clientY: number): void {
  const candidate = getPlacementTargetFromPointer(clientX, clientY);
  const selectedStack = getSelectedHotbarStack();
  if (!candidate || !selectedStack || selectedStack.count <= 0 || isPlacementInsidePlayer(candidate)) {
    activePlacementTarget = null;
    placementPreview.visible = false;
    return;
  }

  activePlacementTarget = candidate;
  placementPreview.visible = true;
  placementPreview.position.set(terrainToSceneX(candidate.worldX + 0.5), candidate.worldY + 0.5, terrainToSceneZ(candidate.worldZ + 0.5));
}

function placeBlockAtTarget(target: PlacementTarget): boolean {
  if (isPlacementInsidePlayer(target)) {
    return false;
  }

  const selectedStack = getSelectedHotbarStack();
  if (!selectedStack || selectedStack.count <= 0) {
    return false;
  }

  const targetEntry = getBlockAtWorld(target.worldX, target.worldY, target.worldZ);
  if (!targetEntry) {
    return false;
  }

  if (targetEntry.record.chunk.get(targetEntry.localX, target.worldY, targetEntry.localZ) !== BlockId.Air) {
    return false;
  }

  targetEntry.record.chunk.set(targetEntry.localX, target.worldY, targetEntry.localZ, selectedStack.block);
  selectedStack.count -= 1;
  if (selectedStack.count <= 0) {
    inventorySlots[selectedHotbarIndex] = null;
  }
  refreshPlacementHud();

  const targetChunkX = Math.floor(target.worldX / CHUNK_SIZE);
  const targetChunkZ = Math.floor(target.worldZ / CHUNK_SIZE);
  const candidateChunks = [
    [targetChunkX, targetChunkZ],
    [targetChunkX - 1, targetChunkZ],
    [targetChunkX + 1, targetChunkZ],
    [targetChunkX, targetChunkZ - 1],
    [targetChunkX, targetChunkZ + 1]
  ];

  const updated = new Set<string>();
  for (const [cx, cz] of candidateChunks) {
    const key = worldChunkKey(cx, cz);
    if (updated.has(key)) continue;
    const record = worldChunkByKey.get(key);
    if (!record) continue;
    rebuildChunkMeshes(record, blockTilesById);
    updated.add(key);
  }

  updateTopYForColumn(targetChunkX, targetChunkZ, ((target.worldX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE, ((target.worldZ % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE);

  const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'square';
  osc.frequency.value = 520;
  gain.gain.value = 0.02;
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + 0.035);

  return true;
}

function handlePlace(clientX: number, clientY: number): void {
  updatePlacementPreview(clientX, clientY);
  if (activePlacementTarget) {
    placeBlockAtTarget(activePlacementTarget);
    updatePlacementPreview(clientX, clientY);
  }
}

function handleTap(clientX: number, clientY: number): void {
  if (recenterIfPlayerTapped(clientX, clientY)) {
    return;
  }

  const target = getMiningTargetFromTap(clientX, clientY);
  if (target) {
    clearActivePath();
    startMining(target);
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

  if (key >= '1' && key <= '5') {
    const slotIndex = Number.parseInt(key, 10) - 1;
    if (slotIndex >= 0 && slotIndex < HOTBAR_SLOT_COUNT) {
      selectedHotbarIndex = slotIndex;
      refreshPlacementHud();
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
  updatePlacementPreview(event.clientX, event.clientY);
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

renderer.domElement.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  handlePlace(event.clientX, event.clientY);
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
  pressStartMs?: number;
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
    activeTouch.pressStartMs = performance.now();
  },
  { passive: true }
);

renderer.domElement.addEventListener(
  'touchmove',
  (event) => {
    if (event.touches.length === 1) {
      const center = touchCenter(event.touches);
      updatePlacementPreview(center.x, center.y);
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
      updatePlacementPreview(center.x, center.y);
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
      const pressDuration = performance.now() - (activeTouch.pressStartMs ?? performance.now());
      if (pressDuration > 380) {
        handlePlace(touch.clientX, touch.clientY);
      } else {
        handleTap(touch.clientX, touch.clientY);
      }
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

  if (activeMiningTarget) {
    const elapsedMs = timeMs - miningStartMs;
    const progress = THREE.MathUtils.clamp(elapsedMs / Math.max(1, miningDurationMs), 0, 1);
    miningFill.style.width = `${Math.round(progress * 100)}%`;

    if (progress >= 1) {
      const target = activeMiningTarget;
      activeMiningTarget = null;
      miningOverlay.style.display = 'none';

      const record = worldChunkByKey.get(worldChunkKey(target.chunkX, target.chunkZ));
      if (record && record.chunk.get(target.localX, target.localY, target.localZ) === target.block) {
        record.chunk.set(target.localX, target.localY, target.localZ, BlockId.Air);
        updateTopYForColumn(target.chunkX, target.chunkZ, target.localX, target.localZ);
        rebuildChunkMeshes(record, blockTilesById);
        beginBreakAnimation(target);

        const stored = addToInventory(target.block, 1);
        if (stored < 1) {
          spawnDroppedItem(target.block, target.worldX, target.worldY, target.worldZ);
        }
      }
    }
  }

  if (miningGhost) {
    const ghostAge = timeMs - (miningGhost.userData.spawnMs as number);
    const ghostT = THREE.MathUtils.clamp(ghostAge / 180, 0, 1);
    const scale = THREE.MathUtils.lerp(1, 0.35, ghostT);
    miningGhost.scale.set(scale, scale, scale);
    const mat = miningGhost.material as THREE.MeshBasicMaterial;
    mat.opacity = THREE.MathUtils.lerp(0.45, 0, ghostT);
    if (ghostT >= 1) {
      scene.remove(miningGhost);
      miningGhost.geometry.dispose();
      mat.dispose();
      miningGhost = null;
    }
  }

  for (let i = droppedItems.length - 1; i >= 0; i--) {
    const item = droppedItems[i];
    const ageMs = timeMs - item.userData.spawnMs;
    const bob = Math.sin(ageMs * 0.005) * 0.08;
    item.rotation.y += deltaSeconds * 1.2;
    item.position.y = item.userData.baseY + bob;

    const terrainX = sceneToTerrainX(item.position.x);
    const terrainZ = sceneToTerrainZ(item.position.z);
    const dx = terrainX - playerTerrainPos.x;
    const dz = terrainZ - playerTerrainPos.z;
    const dy = item.position.y - playerTerrainPos.y;
    const distSq = dx * dx + dz * dz + dy * dy;

    if (distSq <= PICKUP_RADIUS * PICKUP_RADIUS) {
      const stored = addToInventory(item.userData.block, 1);
      if (stored > 0) {
        droppedItems.splice(i, 1);
        releaseDroppedItem(item);
      }
      continue;
    }

    if (ageMs > 5 * 60 * 1000) {
      droppedItems.splice(i, 1);
      releaseDroppedItem(item);
    }
  }

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
