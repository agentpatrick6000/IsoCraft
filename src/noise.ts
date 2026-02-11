function hash2d(x: number, z: number, seed: number): number {
  const s = Math.sin(x * 127.1 + z * 311.7 + seed * 17.23) * 43758.5453123;
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
