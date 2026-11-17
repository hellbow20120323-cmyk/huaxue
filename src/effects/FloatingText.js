import * as THREE from 'three'

/**
 * FloatingText（3D 世界坐标 → DOM 浮动文字）
 * ------------------------------------------------------------------
 * 用 DOM 而不是 Sprite 的原因：
 *   - 文字始终以设备像素清晰渲染，不需要动态生成 Canvas 贴图；
 *   - 字体、描边、发光全部交给 CSS，改动成本低；
 *   - 数量极少（一次腾空 / Fever 只弹一条），DOM 开销可以忽略。
 *
 * 每条文字记录一个世界坐标，每帧投影到屏幕并持续上浮、淡出。
 */
export class FloatingText {
  /**
   * @param {HTMLElement} [container] 文字挂载层，需为 pointer-events: none
   */
  constructor(container) {
    this.container = container || document.body
    this.items = []
    // 复用向量，避免每帧分配
    this._projected = new THREE.Vector3()
  }

  /**
   * 弹出一条浮动文字。
   * @param {string} text
   * @param {THREE.Vector3} worldPosition 文字起点（通常取角色头顶）
   * @param {{ color?: string, life?: number, size?: number }} [options]
   */
  show(text, worldPosition, { color = '#fff4c2', life = 1.3, size = 22 } = {}) {
    const el = document.createElement('div')
    el.className = 'floater'
    el.textContent = text
    el.style.color = color
    el.style.fontSize = `${size}px`
    this.container.appendChild(el)

    this.items.push({
      el,
      age: 0,
      life,
      position: worldPosition.clone(),
    })
  }

  /**
   * 每帧更新：投影 → 定位 → 淡出。
   * @param {number} delta 秒
   * @param {THREE.PerspectiveCamera} camera
   */
  update(delta, camera) {
    if (this.items.length === 0) return

    const width = window.innerWidth
    const height = window.innerHeight

    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i]
      item.age += delta
      const t = item.age / item.life

      if (t >= 1) {
        item.el.remove()
        this.items.splice(i, 1)
        continue
      }

      // 世界空间持续上浮，配合屏幕淡出形成「飘走」的感觉
      this._projected.copy(item.position)
      this._projected.y += 0.9 + t * 1.1
      this._projected.project(camera)

      // z > 1 表示落在相机背后，直接隐藏
      if (this._projected.z > 1) {
        item.el.style.opacity = '0'
        continue
      }

      const x = (this._projected.x * 0.5 + 0.5) * width
      const y = (-this._projected.y * 0.5 + 0.5) * height
      // 弹出时从小放大，随后保持
      const pop = Math.min(1, 0.65 + t * 4)
      const opacity = Math.min(1, (1 - t) * 1.8)

      item.el.style.opacity = String(opacity)
      item.el.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px) scale(${pop})`
    }
  }

  /** 清空所有未消失的文字（重开时使用） */
  clear() {
    for (const item of this.items) item.el.remove()
    this.items.length = 0
  }

  dispose() {
    this.clear()
  }
}
