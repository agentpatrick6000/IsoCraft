import * as THREE from 'three';
import { fbm2d } from './noise';
import type { BlockFace, FaceTileMap } from './voxel';

export enum BlockId {
  Air = 0,
  Grass = 1,
  Dirt = 2,
  Stone = 3,
  Sand = 4,
  Water = 5,
  WoodLog = 6,
  Leaves = 7
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

  constructor(width = 16, height = 8, depth = 16) {
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

  fillFromHeightSampler(sampleSurfaceY: (x: number, z: number) => number, seaLevel: number): void {
    this.blocks.fill(BlockId.Air);

    for (let x = 0; x < this.width; x++) {
      for (let z = 0; z < this.depth; z++) {
        const rawSurface = sampleSurfaceY(x, z);
        const surfaceY = THREE.MathUtils.clamp(Math.floor(rawSurface), 0, this.height - 1);
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

          let w = 1;
          while (i + w < dims[u]) {
            const next = mask[n + w];
            if (!next || next.tile !== cell.tile || next.backFace !== cell.backFace) break;
            w++;
          }

          let h = 1;
          let done = false;
          while (j + h < dims[v] && !done) {
            for (let k = 0; k < w; k++) {
              const next = mask[n + k + h * dims[u]];
              if (!next || next.tile !== cell.tile || next.backFace !== cell.backFace) {
                done = true;
                break;
              }
            }
            if (!done) h++;
          }

          x[u] = i;
          x[v] = j;

          const du = [0, 0, 0];
          const dv = [0, 0, 0];
          du[u] = w;
          dv[v] = h;

          const p0 = [x[0], x[1], x[2]];
          const p1 = [x[0] + du[0], x[1] + du[1], x[2] + du[2]];
          const p2 = [x[0] + dv[0], x[1] + dv[1], x[2] + dv[2]];
          const p3 = [x[0] + du[0] + dv[0], x[1] + du[1] + dv[1], x[2] + du[2] + dv[2]];

          const normal = [0, 0, 0];
          normal[d] = cell.backFace ? -1 : 1;

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
