import * as THREE from 'three';

export type BlockFace = 'top' | 'bottom' | 'north' | 'south' | 'east' | 'west';

export type FaceTileMap = Record<BlockFace, number>;

export const TILE_SIZE = 16;
const FACE_ORDER: BlockFace[] = ['east', 'west', 'top', 'bottom', 'south', 'north'];

function setFaceUv(
  uvs: Float32Array,
  faceIndex: number,
  tileIndex: number,
  atlasColumns: number,
  atlasRows: number
): void {
  const tileX = tileIndex % atlasColumns;
  const tileY = Math.floor(tileIndex / atlasColumns);

  const u0 = tileX / atlasColumns;
  const v0 = 1 - tileY / atlasRows;
  const u1 = (tileX + 1) / atlasColumns;
  const v1 = 1 - (tileY + 1) / atlasRows;

  const base = faceIndex * 8;
  // BoxGeometry face vertex order: (0,1), (0,0), (1,1), (1,0)
  uvs[base + 0] = u1;
  uvs[base + 1] = v0;
  uvs[base + 2] = u0;
  uvs[base + 3] = v0;
  uvs[base + 4] = u1;
  uvs[base + 5] = v1;
  uvs[base + 6] = u0;
  uvs[base + 7] = v1;
}

export function createVoxelBlockMesh(options: {
  atlasTexture: THREE.Texture;
  tiles: FaceTileMap;
  atlasColumns?: number;
  atlasRows?: number;
  size?: number;
}): THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial> {
  const { atlasTexture, tiles, atlasColumns = 4, atlasRows = 4, size = 1 } = options;

  const geometry = new THREE.BoxGeometry(size, size, size);
  const uvAttribute = geometry.getAttribute('uv') as THREE.BufferAttribute;
  const uvArray = uvAttribute.array as Float32Array;

  FACE_ORDER.forEach((face, faceIndex) => {
    setFaceUv(uvArray, faceIndex, tiles[face], atlasColumns, atlasRows);
  });

  uvAttribute.needsUpdate = true;

  atlasTexture.magFilter = THREE.NearestFilter;
  atlasTexture.minFilter = THREE.NearestFilter;
  atlasTexture.generateMipmaps = false;
  atlasTexture.wrapS = THREE.ClampToEdgeWrapping;
  atlasTexture.wrapT = THREE.ClampToEdgeWrapping;
  atlasTexture.colorSpace = THREE.SRGBColorSpace;

  const material = new THREE.MeshStandardMaterial({ map: atlasTexture });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = false;
  mesh.receiveShadow = false;

  return mesh;
}
