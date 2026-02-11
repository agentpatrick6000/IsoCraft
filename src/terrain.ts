import * as THREE from 'three';
import type { BlockFace, FaceTileMap } from './voxel';

export enum BlockId {
  Air = 0,
  Grass = 1,
  Dirt = 2,
  Stone = 3
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
    const dirtStart = Math.max(1, surfaceY - 2);

    for (let x = 0; x < this.width; x++) {
      for (let z = 0; z < this.depth; z++) {
        for (let y = 0; y <= surfaceY; y++) {
          if (y === surfaceY) {
            this.set(x, y, z, BlockId.Grass);
          } else if (y >= dirtStart) {
            this.set(x, y, z, BlockId.Dirt);
          } else {
            this.set(x, y, z, BlockId.Stone);
          }
        }
      }
    }
  }
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

  uvs.push(
    u1, v0,
    u0, v0,
    u1, v1,
    u0, v1
  );
}

export function buildChunkGreedyGeometry(options: {
  chunk: Chunk;
  blockTiles: Record<BlockId, FaceTileMap>;
  atlasColumns?: number;
  atlasRows?: number;
}): THREE.BufferGeometry {
  const { chunk, blockTiles, atlasColumns = 4, atlasRows = 4 } = options;
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

          if ((a !== BlockId.Air) === (b !== BlockId.Air)) {
            mask[n++] = null;
            continue;
          }

          const backFace = a === BlockId.Air;
          const block = backFace ? b : a;
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
