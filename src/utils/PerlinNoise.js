/**
 * 2D Perlin 噪声 + fBm（分形叠加）
 * ------------------------------------------------------------------
 * 为什么自己实现而不是引第三方库：
 *   1. 地形需要「可复现」——同一个种子必须生成完全相同的地形，方便调试；
 *   2. 代码量很小（不到 100 行），可以进一步压缩小程序的包体；
 *   3. 后续要把它跑在小程序 Worker 里时没有额外依赖负担。
 *
 * 噪声输出范围约为 [-1, 1]，fBm 会在多个倍频上叠加，得到自然的山体起伏。
 */

import { mulberry32 } from './Random.js'

/** Perlin 的缓和曲线：让网格边界处的一阶、二阶导数为 0，避免出现方格感 */
function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10)
}

function lerp(a, b, t) {
  return a + (b - a) * t
}

/**
 * 8 个方向的梯度点积。使用 8 方向而不是标准 12 方向，
 * 在 2D 下足够均匀，且没有查表开销。
 */
function grad(hash, x, y) {
  switch (hash & 7) {
    case 0:
      return x + y
    case 1:
      return x - y
    case 2:
      return -x + y
    case 3:
      return -x - y
    case 4:
      return x
    case 5:
      return -x
    case 6:
      return y
    default:
      return -y
  }
}

/**
 * @param {number} seed 地形种子
 * @returns {{ noise2D: (x: number, y: number) => number, fbm: (x: number, y: number, octaves?: number) => number }}
 */
export function createNoise2D(seed = 20261117) {
  // 置换表：经典 Perlin 做法，长度 512 避免索引越界
  const permutation = new Uint8Array(512)
  const base = new Uint8Array(256)
  for (let i = 0; i < 256; i++) base[i] = i

  const random = mulberry32(seed)
  // Fisher–Yates 洗牌，保证不同种子得到不同地形
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const tmp = base[i]
    base[i] = base[j]
    base[j] = tmp
  }
  for (let i = 0; i < 512; i++) permutation[i] = base[i & 255]

  /**
   * 单层 Perlin 噪声
   * @param {number} x
   * @param {number} y
   */
  function noise2D(x, y) {
    const xi = Math.floor(x) & 255
    const yi = Math.floor(y) & 255
    const xf = x - Math.floor(x)
    const yf = y - Math.floor(y)

    const u = fade(xf)
    const v = fade(yf)

    // 四个格点的哈希值
    const aa = permutation[permutation[xi] + yi]
    const ab = permutation[permutation[xi] + yi + 1]
    const ba = permutation[permutation[xi + 1] + yi]
    const bb = permutation[permutation[xi + 1] + yi + 1]

    // 先沿 X 插值，再沿 Y 插值
    const x1 = lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u)
    const x2 = lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u)
    // 乘 0.75 把范围大致收敛到 [-1, 1]
    return lerp(x1, x2, v) * 0.75
  }

  /**
   * 分形布朗运动：叠加多个倍频噪声，得到「大起伏 + 小细节」的自然地形
   * @param {number} x
   * @param {number} y
   * @param {number} octaves 倍频层数，2~4 比较适合低多边形地形
   */
  function fbm(x, y, octaves = 3) {
    let amplitude = 1
    let frequency = 1
    let sum = 0
    let normalization = 0

    for (let i = 0; i < octaves; i++) {
      sum += noise2D(x * frequency, y * frequency) * amplitude
      normalization += amplitude
      amplitude *= 0.5 // 每层振幅减半
      frequency *= 2 // 每层频率翻倍
    }

    return sum / normalization
  }

  return { noise2D, fbm }
}
