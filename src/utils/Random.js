/**
 * 32 位种子随机数（mulberry32）
 * 地形噪声和障碍物摆放都需要「可复现的随机」，因此抽成公共工具。
 * @param {number} seed
 * @returns {() => number} 返回 [0, 1) 的伪随机数
 */
export function mulberry32(seed) {
  let state = seed >>> 0
  return function random() {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
