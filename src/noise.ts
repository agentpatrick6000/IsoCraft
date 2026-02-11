function hash2d(x: number, z: number, seed: number): number {
  const s = Math.sin(x * 127.1 + z * 311.7 + seed * 17.23) * 43758.5453123;
  return s - Math.floor(s);
}

function hash3d(x: number, y: number, z: number, seed: number): number {
  const s = Math.sin(x * 157.1 + y * 113.3 + z * 271.9 + seed * 19.17) * 43758.5453123;
  return s - Math.floor(s);
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function valueNoise2d(x: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const x1 = x0 + 1;
  const z1 = z0 + 1;

  const tx = smoothstep(x - x0);
  const tz = smoothstep(z - z0);

  const n00 = hash2d(x0, z0, seed);
  const n10 = hash2d(x1, z0, seed);
  const n01 = hash2d(x0, z1, seed);
  const n11 = hash2d(x1, z1, seed);

  const nx0 = n00 + (n10 - n00) * tx;
  const nx1 = n01 + (n11 - n01) * tx;

  return nx0 + (nx1 - nx0) * tz;
}

function valueNoise3d(x: number, y: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const z1 = z0 + 1;

  const tx = smoothstep(x - x0);
  const ty = smoothstep(y - y0);
  const tz = smoothstep(z - z0);

  const n000 = hash3d(x0, y0, z0, seed);
  const n100 = hash3d(x1, y0, z0, seed);
  const n010 = hash3d(x0, y1, z0, seed);
  const n110 = hash3d(x1, y1, z0, seed);
  const n001 = hash3d(x0, y0, z1, seed);
  const n101 = hash3d(x1, y0, z1, seed);
  const n011 = hash3d(x0, y1, z1, seed);
  const n111 = hash3d(x1, y1, z1, seed);

  const nx00 = n000 + (n100 - n000) * tx;
  const nx10 = n010 + (n110 - n010) * tx;
  const nx01 = n001 + (n101 - n001) * tx;
  const nx11 = n011 + (n111 - n011) * tx;

  const nxy0 = nx00 + (nx10 - nx00) * ty;
  const nxy1 = nx01 + (nx11 - nx01) * ty;

  return nxy0 + (nxy1 - nxy0) * tz;
}

export function fbm2d(x: number, z: number, options?: { seed?: number; octaves?: number; lacunarity?: number; gain?: number }): number {
  const seed = options?.seed ?? 1337;
  const octaves = options?.octaves ?? 4;
  const lacunarity = options?.lacunarity ?? 2;
  const gain = options?.gain ?? 0.5;

  let amplitude = 1;
  let frequency = 1;
  let sum = 0;
  let maxSum = 0;

  for (let i = 0; i < octaves; i++) {
    sum += valueNoise2d(x * frequency, z * frequency, seed + i * 37) * amplitude;
    maxSum += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }

  return maxSum > 0 ? sum / maxSum : 0;
}

export function fbm3d(
  x: number,
  y: number,
  z: number,
  options?: { seed?: number; octaves?: number; lacunarity?: number; gain?: number }
): number {
  const seed = options?.seed ?? 1337;
  const octaves = options?.octaves ?? 4;
  const lacunarity = options?.lacunarity ?? 2;
  const gain = options?.gain ?? 0.5;

  let amplitude = 1;
  let frequency = 1;
  let sum = 0;
  let maxSum = 0;

  for (let i = 0; i < octaves; i++) {
    sum += valueNoise3d(x * frequency, y * frequency, z * frequency, seed + i * 53) * amplitude;
    maxSum += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }

  return maxSum > 0 ? sum / maxSum : 0;
}
