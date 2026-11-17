import * as THREE from 'three'

/**
 * GateBurst（过门粒子爆发）
 * ------------------------------------------------------------------
 * 玩家从两根霓虹旗杆之间穿过时，在门中心炸开一圈彩色粒子。
 * 预分配固定容量的 Points 缓冲，多次爆发复用同一套缓冲，
 * 不产生每次过门的新对象，适合移动端。
 */

const CAPACITY = 260
// 粒子初速度范围与生存时间
const SPEED_MIN = 3
const SPEED_MAX = 9
const LIFE_MIN = 0.45
const LIFE_MAX = 0.8
const GRAVITY = -5
const DRAG = 2.6

export class GateBurst {
  /**
   * @param {THREE.Scene} scene
   */
  constructor(scene) {
    this.scene = scene
    this._cursor = 0

    this.positions = new Float32Array(CAPACITY * 3)
    this.velocities = new Float32Array(CAPACITY * 3)
    this.colors = new Float32Array(CAPACITY * 3)
    this.alphas = new Float32Array(CAPACITY)
    this.sizes = new Float32Array(CAPACITY)
    this.baseSizes = new Float32Array(CAPACITY)
    this.life = new Float32Array(CAPACITY)
    this.maxLife = new Float32Array(CAPACITY)

    for (let i = 0; i < CAPACITY; i++) {
      this.positions[i * 3 + 1] = -9999
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3))
    geometry.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3))
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1))
    geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1))

    const material = new THREE.ShaderMaterial({
      uniforms: {
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
          gl_PointSize = min(
            aSize * uPixelRatio * (300.0 / max(1.0, -mvPosition.z)),
            30.0 * uPixelRatio
          );
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying float vAlpha;

        void main() {
          // 柔边圆点，叠加混合下形成霓虹光点
          vec2 offset = gl_PointCoord - 0.5;
          float dist = length(offset);
          if (dist > 0.5) discard;
          float soft = smoothstep(0.5, 0.02, dist);
          gl_FragColor = vec4(vColor, vAlpha * soft);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })

    this.geometry = geometry
    this.material = material
    this.points = new THREE.Points(geometry, material)
    this.points.frustumCulled = false
    this.points.renderOrder = 3
    scene.add(this.points)
  }

  /** 当前存活粒子数（调试 / 测试用） */
  get aliveCount() {
    let count = 0
    for (let i = 0; i < CAPACITY; i++) {
      if (this.life[i] > 0) count++
    }
    return count
  }

  /**
   * 在指定位置炸开一组粒子。
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} colorHex 旗门颜色
   * @param {number} count 粒子数
   */
  burst(x, y, z, colorHex, count = 52) {
    const color = new THREE.Color(colorHex)

    for (let n = 0; n < count; n++) {
      const i = this._cursor
      this._cursor = (this._cursor + 1) % CAPACITY
      const p = i * 3

      // 球面随机方向，并让向上的分量稍强，形成烟花感
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(2 * Math.random() - 1)
      const sinPhi = Math.sin(phi)
      const speed = SPEED_MIN + Math.random() * (SPEED_MAX - SPEED_MIN)

      this.positions[p] = x + (Math.random() - 0.5) * 0.4
      this.positions[p + 1] = y + (Math.random() - 0.5) * 0.3
      this.positions[p + 2] = z + (Math.random() - 0.5) * 0.4

      this.velocities[p] = Math.cos(theta) * sinPhi * speed
      this.velocities[p + 1] = Math.cos(phi) * speed * 0.7 + 2.2
      this.velocities[p + 2] = Math.sin(theta) * sinPhi * speed

      this.colors[p] = color.r
      this.colors[p + 1] = color.g
      this.colors[p + 2] = color.b

      const life = LIFE_MIN + Math.random() * (LIFE_MAX - LIFE_MIN)
      this.life[i] = life
      this.maxLife[i] = life
      this.baseSizes[i] = 0.09 + Math.random() * 0.07
      this.sizes[i] = this.baseSizes[i]
      this.alphas[i] = 0.9
    }

    this.geometry.attributes.aColor.needsUpdate = true
  }

  /** 推进所有粒子：减速、下坠、放大并淡出 */
  update(delta) {
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

      const t = this.life[i] / this.maxLife[i]
      this.alphas[i] = 0.9 * t
      this.sizes[i] = this.baseSizes[i] * (1 + 1.6 * (1 - t))
    }

    this.geometry.attributes.position.needsUpdate = true
    this.geometry.attributes.aAlpha.needsUpdate = true
    this.geometry.attributes.aSize.needsUpdate = true
  }

  dispose() {
    this.scene.remove(this.points)
    this.geometry.dispose()
    this.material.dispose()
  }
}
