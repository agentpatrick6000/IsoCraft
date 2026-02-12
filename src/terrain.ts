import * as THREE from 'three';
import { fbm2d, fbm3d } from './noise';
import type { BlockFace, FaceTileMap } from './voxel';

export enum BlockId {
  Air = 0,
  Grass = 1,
  Dirt = 2,
  Stone = 3,
  Sand = 4,
  Water = 5,
  WoodLog = 6,
  Leaves = 7,
  CoalOre = 8,
  IronOre = 9,
  GoldOre = 10,
  Planks = 11,
  Sticks = 12,
  CraftingTable = 13,
  WoodenPickaxe = 14,
  WoodenAxe = 15,
  WoodenShovel = 16,
  Furnace = 17,
  StonePickaxe = 18,
  Torch = 19
}

type MaskCell = {
  tile: number;
  backFace: boolean;
};

export class Chunk {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  private readonly blocks: Uint8Array;

  constructor(width = 16, height = 256, depth = 16) {
    this.width = width;
    this.height = height;
    this.depth = depth;
    this.blocks = new Uint8Array(width * height * depth);
  }

  private index(x: number, y: number, z: number): number {
    return x + this.width * (z + this.depth * y);
  }

  get(x: number, y: number, z: number): BlockId {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height || z < 0 || z >= this.depth) {
      return BlockId.Air;
    }
    return this.blocks[this.index(x, y, z)] as BlockId;
  }

  set(x: number, y: number, z: number, block: BlockId): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height || z < 0 || z >= this.depth) {
      return;
    }
    this.blocks[this.index(x, y, z)] = block;
  }

  fillFlatLayers(surfaceY = 3): void {
    this.fillFromHeightSampler(() => surfaceY, Math.max(0, surfaceY - 1));
  }

  fillFromHeightSampler(
    sampleSurfaceY: (x: number, z: number) => number,
    seaLevel: number,
    maxTerrainY: number = this.height - 1
  ): void {
    this.blocks.fill(BlockId.Air);

    for (let x = 0; x < this.width; x++) {
      for (let z = 0; z < this.depth; z++) {
        const rawSurface = sampleSurfaceY(x, z);
        const surfaceY = THREE.MathUtils.clamp(Math.floor(rawSurface), 0, Math.min(this.height - 1, maxTerrainY));
        const dirtStart = Math.max(1, surfaceY - 2);

        for (let y = 0; y <= surfaceY; y++) {
          if (y === surfaceY) {
            const topBlock = surfaceY <= seaLevel ? BlockId.Sand : BlockId.Grass;
            this.set(x, y, z, topBlock);
          } else if (y >= dirtStart) {
            this.set(x, y, z, BlockId.Dirt);
          } else {
            this.set(x, y, z, BlockId.Stone);
          }
        }

        const waterMaxY = Math.min(seaLevel, this.height - 1);
        for (let y = surfaceY + 1; y <= waterMaxY; y++) {
          this.set(x, y, z, BlockId.Water);
        }
      }
    }
  }

  addTrees(options: { worldChunkX: number; worldChunkZ: number; chunkSize: number; seed?: number }): void {
    const { worldChunkX, worldChunkZ, chunkSize, seed = 9571 } = options;

    for (let localX = 2; localX < this.width - 2; localX++) {
      for (let localZ = 2; localZ < this.depth - 2; localZ++) {
        const worldX = worldChunkX * chunkSize + localX;
        const worldZ = worldChunkZ * chunkSize + localZ;

        const treeNoise = fbm2d(worldX * 0.09, worldZ * 0.09, {
          seed,
          octaves: 3,
          lacunarity: 2,
          gain: 0.5
        });
        const placementJitter = hash2d(worldX, worldZ, seed + 101);

        if (treeNoise < 0.64 || placementJitter < 0.72) {
          continue;
        }

        const groundY = this.getTopSolidY(localX, localZ);
        if (this.get(localX, groundY, localZ) !== BlockId.Grass) {
          continue;
        }

        const trunkHeight = 3 + Math.floor(hash2d(worldX, worldZ, seed + 202) * 3);
        if (groundY + trunkHeight + 2 >= this.height) {
          continue;
        }

        let trunkBlocked = false;
        for (let y = 1; y <= trunkHeight + 1; y++) {
          if (this.get(localX, groundY + y, localZ) !== BlockId.Air) {
            trunkBlocked = true;
            break;
          }
        }
        if (trunkBlocked) {
          continue;
        }

        for (let y = 1; y <= trunkHeight; y++) {
          this.set(localX, groundY + y, localZ, BlockId.WoodLog);
        }

        const canopyCenterY = groundY + trunkHeight;
        for (let ox = -2; ox <= 2; ox++) {
          for (let oz = -2; oz <= 2; oz++) {
            for (let oy = -2; oy <= 2; oy++) {
              const distance = Math.abs(ox) + Math.abs(oz) + Math.abs(oy) * 0.85;
              if (distance > 3.55) {
                continue;
              }

              const x = localX + ox;
              const y = canopyCenterY + oy;
              const z = localZ + oz;
              if (x < 0 || x >= this.width || y < 0 || y >= this.height || z < 0 || z >= this.depth) {
                continue;
              }

              if (this.get(x, y, z) !== BlockId.Air) {
                continue;
              }

              if (hash2d(worldX + ox, worldZ + oz, seed + y) < 0.12 && !(ox === 0 && oy >= 0 && oz === 0)) {
                continue;
              }

              this.set(x, y, z, BlockId.Leaves);
            }
          }
        }
      }
    }
  }

  addOreDeposits(options: { worldChunkX: number; worldChunkZ: number; chunkSize: number; seed?: number }): void {
    const { worldChunkX, worldChunkZ, chunkSize, seed = 22091 } = options;

    const oreConfigs: Array<{
      block: BlockId;
      minY: number;
      maxY: number;
      clusterMin: number;
      clusterMax: number;
      frequency: number;
      threshold: number;
      seedOffset: number;
    }> = [
      {
        block: BlockId.GoldOre,
        minY: 0,
        maxY: 15,
        clusterMin: 2,
        clusterMax: 4,
        frequency: 0.18,
        threshold: 0.66,
        seedOffset: 701
      },
      {
        block: BlockId.IronOre,
        minY: 0,
        maxY: 30,
        clusterMin: 3,
        clusterMax: 5,
        frequency: 0.16,
        threshold: 0.62,
        seedOffset: 401
      },
      {
        block: BlockId.CoalOre,
        minY: 0,
        maxY: 40,
        clusterMin: 4,
        clusterMax: 8,
        frequency: 0.14,
        threshold: 0.58,
        seedOffset: 101
      }
    ];

    for (const ore of oreConfigs) {
      const minY = THREE.MathUtils.clamp(ore.minY, 0, this.height - 1);
      const maxY = THREE.MathUtils.clamp(ore.maxY, 0, this.height - 1);
      if (minY > maxY) {
        continue;
      }

      for (let localX = 0; localX < this.width; localX++) {
        for (let localZ = 0; localZ < this.depth; localZ++) {
          const worldX = worldChunkX * chunkSize + localX;
          const worldZ = worldChunkZ * chunkSize + localZ;

          for (let y = minY; y <= maxY; y++) {
            if (this.get(localX, y, localZ) !== BlockId.Stone) {
              continue;
            }

            const veinNoise = fbm3d(worldX * ore.frequency, y * ore.frequency, worldZ * ore.frequency, {
              seed: seed + ore.seedOffset,
              octaves: 3,
              lacunarity: 2,
              gain: 0.5
            });

            if (veinNoise < ore.threshold) {
              continue;
            }

            const rarityGate = hash3d(worldX, y, worldZ, seed + ore.seedOffset * 3);
            if (rarityGate < 0.9) {
              continue;
            }

            const clusterSize = ore.clusterMin + Math.floor(hash3d(worldX, y, worldZ, seed + ore.seedOffset * 5) * (ore.clusterMax - ore.clusterMin + 1));
            this.carveOreVein(localX, y, localZ, ore.block, clusterSize, worldX, worldZ, seed + ore.seedOffset * 7);
          }
        }
      }
    }
  }


  addCaves(options: { worldChunkX: number; worldChunkZ: number; chunkSize: number; seed?: number }): void {
    const { worldChunkX, worldChunkZ, chunkSize, seed = 31841 } = options;

    const surfaceHeights = new Uint8Array(this.width * this.depth);
    for (let x = 0; x < this.width; x++) {
      for (let z = 0; z < this.depth; z++) {
        surfaceHeights[x + z * this.width] = this.getTopSolidY(x, z);
      }
    }

    const caveFrequency = 0.12;
    const warpFrequency = 0.21;

    for (let localX = 0; localX < this.width; localX++) {
      for (let localZ = 0; localZ < this.depth; localZ++) {
        const worldX = worldChunkX * chunkSize + localX;
        const worldZ = worldChunkZ * chunkSize + localZ;
        const surfaceY = surfaceHeights[localX + localZ * this.width];

        const entranceNoise = fbm2d(worldX * 0.08, worldZ * 0.08, {
          seed: seed + 911,
          octaves: 2,
          lacunarity: 2,
          gain: 0.5
        });
        const entranceGate = hash2d(worldX, worldZ, seed + 1223);
        const allowEntrance = entranceNoise > 0.7 && entranceGate > 0.76;

        for (let y = 1; y < this.height - 1; y++) {
          const block = this.get(localX, y, localZ);
          if (block !== BlockId.Stone && block !== BlockId.Dirt) {
            continue;
          }

          const depthFromSurface = surfaceY - y;
          if (depthFromSurface < 1) {
            continue;
          }

          const warpX =
            (fbm3d(worldX * warpFrequency, y * warpFrequency, worldZ * warpFrequency, {
              seed: seed + 37,
              octaves: 2,
              lacunarity: 2,
              gain: 0.5
            }) - 0.5) *
            0.8;
          const warpY =
            (fbm3d(worldX * warpFrequency, y * warpFrequency, worldZ * warpFrequency, {
              seed: seed + 71,
              octaves: 2,
              lacunarity: 2,
              gain: 0.5
            }) - 0.5) *
            0.65;
          const warpZ =
            (fbm3d(worldX * warpFrequency, y * warpFrequency, worldZ * warpFrequency, {
              seed: seed + 109,
              octaves: 2,
              lacunarity: 2,
              gain: 0.5
            }) - 0.5) *
            0.8;

          const caveBody = fbm3d((worldX + warpX) * caveFrequency, (y + warpY) * caveFrequency, (worldZ + warpZ) * caveFrequency, {
            seed,
            octaves: 3,
            lacunarity: 2,
            gain: 0.5
          });

          const caveDetail = fbm3d(worldX * caveFrequency * 1.9, y * caveFrequency * 2.2, worldZ * caveFrequency * 1.9, {
            seed: seed + 157,
            octaves: 2,
            lacunarity: 2,
            gain: 0.45
          });

          const caveValue = caveBody * 0.72 + caveDetail * 0.28;
          const deepThreshold = 0.645;
          const nearSurfaceThreshold = 0.735;
          const threshold = depthFromSurface >= 3 ? deepThreshold : nearSurfaceThreshold;

          if (caveValue < threshold) {
            continue;
          }

          if (depthFromSurface < 3 && !allowEntrance) {
            continue;
          }

          this.set(localX, y, localZ, BlockId.Air);

          const upper = this.get(localX, y + 1, localZ);
          if (upper === BlockId.Stone || upper === BlockId.Dirt || (allowEntrance && upper === BlockId.Grass)) {
            this.set(localX, y + 1, localZ, BlockId.Air);
          }
        }
      }
    }
  }

  private carveOreVein(
    centerX: number,
    centerY: number,
    centerZ: number,
    oreBlock: BlockId,
    targetSize: number,
    worldX: number,
    worldZ: number,
    seed: number
  ): void {
    const offsets: Array<{ x: number; y: number; z: number; score: number }> = [];

    for (let ox = -2; ox <= 2; ox++) {
      for (let oy = -2; oy <= 2; oy++) {
        for (let oz = -2; oz <= 2; oz++) {
          const distance = Math.abs(ox) + Math.abs(oy) + Math.abs(oz);
          if (distance > 4) {
            continue;
          }

          const score = hash3d(worldX + ox, centerY + oy, worldZ + oz, seed) - distance * 0.12;
          offsets.push({ x: ox, y: oy, z: oz, score });
        }
      }
    }

    offsets.sort((a, b) => b.score - a.score);

    let placed = 0;
    for (const offset of offsets) {
      if (placed >= targetSize) {
        break;
      }

      const x = centerX + offset.x;
      const y = centerY + offset.y;
      const z = centerZ + offset.z;

      if (this.get(x, y, z) !== BlockId.Stone) {
        continue;
      }

      this.set(x, y, z, oreBlock);
      placed += 1;
    }
  }

  getTopSolidY(x: number, z: number): number {
    for (let y = this.height - 1; y >= 0; y--) {
      const block = this.get(x, y, z);
      if (block !== BlockId.Air && block !== BlockId.Water && block !== BlockId.Leaves) {
        return y;
      }
    }
    return 0;
  }
}

function hash2d(x: number, z: number, seed: number): number {
  const s = Math.sin(x * 127.1 + z * 311.7 + seed * 17.23) * 43758.5453123;
  return s - Math.floor(s);
}

function hash3d(x: number, y: number, z: number, seed: number): number {
  const s = Math.sin(x * 157.1 + y * 113.3 + z * 271.9 + seed * 19.17) * 43758.5453123;
  return s - Math.floor(s);
}

function tileForFace(block: BlockId, face: BlockFace, tiles: Record<BlockId, FaceTileMap>): number {
  return tiles[block][face];
}

function faceFromAxis(axis: number, backFace: boolean): BlockFace {
  if (axis === 0) return backFace ? 'west' : 'east';
  if (axis === 1) return backFace ? 'bottom' : 'top';
  return backFace ? 'north' : 'south';
}

function pushUv(uvs: number[], tile: number, atlasCols: number, atlasRows: number): void {
  const tileX = tile % atlasCols;
  const tileY = Math.floor(tile / atlasCols);

  const u0 = tileX / atlasCols;
  const v0 = 1 - tileY / atlasRows;
  const u1 = (tileX + 1) / atlasCols;
  const v1 = 1 - (tileY + 1) / atlasRows;

  uvs.push(u1, v0, u0, v0, u1, v1, u0, v1);
}

export function buildChunkGreedyGeometry(options: {
  chunk: Chunk;
  blockTiles: Record<BlockId, FaceTileMap>;
  atlasColumns?: number;
  atlasRows?: number;
  shouldRender?: (block: BlockId) => boolean;
  isOpaque?: (block: BlockId) => boolean;
}): THREE.BufferGeometry {
  const {
    chunk,
    blockTiles,
    atlasColumns = 4,
    atlasRows = 4,
    shouldRender = (block) => block !== BlockId.Air,
    isOpaque = (block) => block !== BlockId.Air
  } = options;
  const dims = [chunk.width, chunk.height, chunk.depth] as const;

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const x = [0, 0, 0];
  const q = [0, 0, 0];

  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;

    q[0] = 0;
    q[1] = 0;
    q[2] = 0;
    q[d] = 1;

    const mask: Array<MaskCell | null> = new Array(dims[u] * dims[v]);

    for (x[d] = -1; x[d] < dims[d]; ) {
      let n = 0;

      for (x[v] = 0; x[v] < dims[v]; x[v]++) {
        for (x[u] = 0; x[u] < dims[u]; x[u]++) {
          const a = chunk.get(x[0], x[1], x[2]);
          const b = chunk.get(x[0] + q[0], x[1] + q[1], x[2] + q[2]);

          const aRender = shouldRender(a);
          const bRender = shouldRender(b);

          if (aRender === bRender) {
            mask[n++] = null;
            continue;
          }

          const backFace = !aRender && bRender;
          const block = backFace ? b : a;
          const neighborBlock = backFace ? a : b;
          if (isOpaque(neighborBlock)) {
            mask[n++] = null;
            continue;
          }
          const face = faceFromAxis(d, backFace);
          const tile = tileForFace(block, face, blockTiles);
          mask[n++] = { tile, backFace };
        }
      }

      x[d]++;
      n = 0;

      for (let j = 0; j < dims[v]; j++) {
        for (let i = 0; i < dims[u]; ) {
          const cell = mask[n];
          if (!cell) {
            i++;
            n++;
            continue;
          }

          // Keep atlas UV density correct (1 tile per 1x1 face).
          // Greedy-merging larger quads with atlas UVs stretches textures,
          // so we intentionally keep each emitted quad to 1x1.
          const w = 1;
          const h = 1;

          x[u] = i;
          x[v] = j;

          const normal = [0, 0, 0];
          normal[d] = cell.backFace ? -1 : 1;

          // Keep faces unit-tiled (1x1 quads) to guarantee no texture stretching.
          for (let hh = 0; hh < h; hh++) {
            for (let ww = 0; ww < w; ww++) {
              const sx = [x[0], x[1], x[2]];
              sx[u] += ww;
              sx[v] += hh;

              const du = [0, 0, 0];
              const dv = [0, 0, 0];
              du[u] = 1;
              dv[v] = 1;

              const p0 = [sx[0], sx[1], sx[2]];
              const p1 = [sx[0] + du[0], sx[1] + du[1], sx[2] + du[2]];
              const p2 = [sx[0] + dv[0], sx[1] + dv[1], sx[2] + dv[2]];
              const p3 = [sx[0] + du[0] + dv[0], sx[1] + du[1] + dv[1], sx[2] + du[2] + dv[2]];

              const baseIndex = positions.length / 3;

              if (cell.backFace) {
                positions.push(...p0, ...p2, ...p1, ...p3);
              } else {
                positions.push(...p0, ...p1, ...p2, ...p3);
              }

              for (let c = 0; c < 4; c++) {
                normals.push(normal[0], normal[1], normal[2]);
              }

              pushUv(uvs, cell.tile, atlasColumns, atlasRows);
              indices.push(baseIndex, baseIndex + 2, baseIndex + 1, baseIndex + 2, baseIndex + 3, baseIndex + 1);
            }
          }

          for (let l = 0; l < h; l++) {
            for (let k = 0; k < w; k++) {
              mask[n + k + l * dims[u]] = null;
            }
          }

          i += w;
          n += w;
        }
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();

  return geometry;
}
