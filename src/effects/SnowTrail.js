import * as THREE from 'three'

/**
 * SnowTrail（雪板扬雪尾迹）
 * ------------------------------------------------------------------
 * 用一个预分配的 THREE.Points 模拟雪板后方的扬雪：
 *   - 全部粒子常驻显存，运行期只改写 BufferAttribute，不新建对象；
 *   - 贴地且速度足够时才发射，腾空 / 撞击结算期间自动停止；
 *   - 片段着色器把方点裁成柔和的圆点，因此不需要任何贴图资源。
 *
 * 发射频率与速度挂钩：滑得越快，扬起的雪越多。
 */

const CAPACITY = 520
// 速度太低时雪板带不起雪
const MIN_SPEED_KMH = 12
// 与 Player 的最高速度对应，用来归一化发射频率
const MAX_SPEED_KMH = 86
// 单个粒子的存活时间范围（秒）
const LIFE_MIN = 0.55
const LIFE_MAX = 1.0
// 轻微下坠与空气阻力：雪粒飞出后很快减速并落回地面
const GRAVITY = -2.4
const DRAG = 2.2

export class SnowTrail {
  /**
   * @param {THREE.Scene} scene
   */
  constructor(scene) {
    this.scene = scene
    this._cursor = 0
    this._emitAccumulator = 0
    // 用于 Fever 彩虹色的相位推进
    this._time = 0
    this._color = new THREE.Color()

    this.positions = new Float32Array(CAPACITY * 3)
    this.velocities = new Float32Array(CAPACITY * 3)
    this.colors = new Float32Array(CAPACITY * 3)
    this.alphas = new Float32Array(CAPACITY)
    this.baseAlphas = new Float32Array(CAPACITY)
    this.sizes = new Float32Array(CAPACITY)
    this.baseSizes = new Float32Array(CAPACITY)
    this.life = new Float32Array(CAPACITY)
    this.maxLife = new Float32Array(CAPACITY)

    // 未使用的粒子藏到地下深处，避免首帧堆在原点闪一下
    for (let i = 0; i < CAPACITY; i++) {
      this.positions[i * 3 + 1] = -9999
      // 默认雪雾色：接近纯白，略带一点暖粉
      this.colors[i * 3] = 1
      this.colors[i * 3 + 1] = 0.97
      this.colors[i * 3 + 2] = 0.98
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3))
    geometry.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3))
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1))
    geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1))

    const material = new THREE.ShaderMaterial({
      uniforms: {
        // 高分屏上粒子要同步放大，否则会显得过小
        uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
      },
      vertexShader: `
        attribute vec3 aColor;
        attribute float aAlpha;
        attribute float aSize;
        uniform float uPixelRatio;
        varying vec3 vColor;
        varying float vAlpha;

        void main() {
          vColor = aColor;
          vAlpha = aAlpha;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          // 按距离透视缩放，并限制最大像素尺寸，
          // 避免贴近相机时粒子变成巨大的白色圆斑
          gl_PointSize = min(
            aSize * uPixelRatio * (300.0 / max(1.0, -mvPosition.z)),
            26.0 * uPixelRatio
          );
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying float vAlpha;

        void main() {
          // 把方形点裁成带柔边的圆，省掉贴图
          vec2 offset = gl_PointCoord - 0.5;
          float dist = length(offset);
          if (dist > 0.5) discard;
          float soft = smoothstep(0.5, 0.02, dist);
          gl_FragColor = vec4(vColor, vAlpha * soft);
        }
      `,
      transparent: true,
      depthWrite: false, // 半透明雪粒不写深度，避免互相遮挡出现硬边
    })

    this.geometry = geometry
    this.material = material
    this.points = new THREE.Points(geometry, material)
    // 粒子始终在相机附近，关闭视锥剔除避免整团被误判为不可见
    this.points.frustumCulled = false
    this.points.renderOrder = 2
    scene.add(this.points)
  }

  /** 当前存活的粒子数（调试 / HUD 用） */
  get aliveCount() {
    let count = 0
    for (let i = 0; i < CAPACITY; i++) {
      if (this.life[i] > 0) count++
    }
    return count
  }

  /**
   * 每帧更新：先推进已有粒子，再按速度补充新粒子。
   * @param {number} delta 秒
   * @param {{ x: number, y: number, z: number, yaw: number, speedKmh: number, grounded: boolean, running: boolean, fever?: number }} player
   */
  update(delta, player) {
    this._time += delta
    this.stepParticles(delta)

    const fever = Math.min(1, Math.max(0, player.fever || 0))
    const canEmit =
      player.running && player.grounded && player.speedKmh > MIN_SPEED_KMH

    if (canEmit) {
      const speedT = Math.min(1, player.speedKmh / MAX_SPEED_KMH)
      // 每秒发射 220 ~ 540 个细颗粒，高密度叠加后形成连续雪雾而不是点串；
      // Fever 状态再提升 50% 密度，让彩虹雪雾更浓
      const rate = (220 + 320 * speedT) * (1 + 0.5 * fever)
      this._emitAccumulator += rate * delta

      // 雪板尾部：玩家朝 -Z，yaw=0 时板尾在 +Z 方向约 0.95m 处
      const tailX = player.x + Math.sin(player.yaw) * 0.95
      const tailY = player.y - 0.42
      const tailZ = player.z + Math.cos(player.yaw) * 0.95

      while (this._emitAccumulator >= 1) {
        this._emitAccumulator -= 1
        this.spawn(tailX, tailY, tailZ, player.yaw, fever)
      }
    } else {
      // 腾空 / 静止时清空累积，落地后不会突然爆出一大团
      this._emitAccumulator = 0
    }

    this.geometry.attributes.position.needsUpdate = true
    this.geometry.attributes.aColor.needsUpdate = true
    this.geometry.attributes.aAlpha.needsUpdate = true
    this.geometry.attributes.aSize.needsUpdate = true
  }

  /** 从环形缓冲里取一个槽位发射粒子 */
  spawn(x, y, z, yaw, fever = 0) {
    const i = this._cursor
    this._cursor = (this._cursor + 1) % CAPACITY
    const p = i * 3

    // 沿雪板左右两侧随机取点（板宽约 0.95m），让雪雾从板刃两侧翻起
    const lateral = (Math.random() - 0.5) * 1.0
    const rightX = Math.cos(yaw)
    const rightZ = -Math.sin(yaw)

    this.positions[p] = x + rightX * lateral + (Math.random() - 0.5) * 0.22
    this.positions[p + 1] = y + Math.random() * 0.12
    this.positions[p + 2] = z + rightZ * lateral + (Math.random() - 0.5) * 0.22

    // 速度方向：向板尾后方 + 向上 + 横向散射
    const back = 0.8 + Math.random() * 2.6
    const side = (Math.random() - 0.5) * 2.6
    this.velocities[p] = Math.sin(yaw) * back + Math.cos(yaw) * side
    this.velocities[p + 1] = 0.6 + Math.random() * 2.2
    this.velocities[p + 2] = Math.cos(yaw) * back - Math.sin(yaw) * side

    // ---- 颜色 ----
    // 普通状态是接近纯白的雪雾；Fever 状态把色相沿时间轴循环，
    // 形成一条不断流动的彩虹尾迹
    const feverMix = Math.min(1, Math.max(0, fever))
    if (feverMix > 0.01) {
      const hue = (this._time * 0.45 + Math.random() * 0.1) % 1
      this._color.setHSL(hue, 1, 0.62)
      this.colors[p] = 1 + (this._color.r - 1) * feverMix
      this.colors[p + 1] = 1 + (this._color.g - 1) * feverMix
      this.colors[p + 2] = 1 + (this._color.b - 1) * feverMix
    } else {
      this.colors[p] = 1
      this.colors[p + 1] = 0.97
      this.colors[p + 2] = 0.98
    }

    const life = LIFE_MIN + Math.random() * (LIFE_MAX - LIFE_MIN)
    this.life[i] = life
    this.maxLife[i] = life
    this.baseSizes[i] = (0.07 + Math.random() * 0.05) * (1 + 0.35 * feverMix)
    this.sizes[i] = this.baseSizes[i]
    this.baseAlphas[i] = 0.5 + 0.2 * feverMix
    this.alphas[i] = this.baseAlphas[i]
  }

  /** 推进粒子：阻力减速、轻微下坠、逐渐膨胀并淡出 */
  stepParticles(delta) {
    const damping = Math.exp(-DRAG * delta)

    for (let i = 0; i < CAPACITY; i++) {
      if (this.life[i] <= 0) continue

      this.life[i] -= delta
      const p = i * 3

      if (this.life[i] <= 0) {
        this.alphas[i] = 0
        this.positions[p + 1] = -9999
        continue
      }

      this.velocities[p] *= damping
      this.velocities[p + 1] = this.velocities[p + 1] * damping + GRAVITY * delta
      this.velocities[p + 2] *= damping

      this.positions[p] += this.velocities[p] * delta
      this.positions[p + 1] += this.velocities[p + 1] * delta
      this.positions[p + 2] += this.velocities[p + 2] * delta

      // t 从 1 衰减到 0：生存期内不断放大并淡出，形成扩散的雪雾
      const t = this.life[i] / this.maxLife[i]
      this.alphas[i] = this.baseAlphas[i] * Math.pow(t, 1.5)
      this.sizes[i] = this.baseSizes[i] * (1 + 2.0 * (1 - t))
    }
  }

  dispose() {
    this.scene.remove(this.points)
    this.geometry.dispose()
    this.material.dispose()
  }
}
