import * as THREE from 'three'

/**
 * CameraRig（第三人称越肩相机）
 * ------------------------------------------------------------------
 * 相机不直接「贴」在玩家身上，而是以指数阻尼追踪一个理想机位：
 *   理想机位 = 玩家位置 + 后上方偏移（略偏右，形成越肩构图）
 *   注视点   = 玩家前方一段距离的地面附近
 * 这样高速下滑时相机会有轻微拖拽感，既有速度感又不会抖动。
 *
 * 指数阻尼公式：alpha = 1 - e^(-lambda * dt)
 * 与帧率无关，60Hz / 120Hz 屏幕上的跟随手感一致。
 */

// 相机相对玩家的偏移：+Z 在玩家身后，+X 形成越肩视角
const OFFSET = new THREE.Vector3(1.7, 2.7, 6.6)
// 注视点相对玩家的偏移：看向前方 9m、略高于雪面的位置
const LOOK_OFFSET = new THREE.Vector3(0, 1.1, -9)

export class CameraRig {
  /**
   * @param {THREE.PerspectiveCamera} camera
   */
  constructor(camera) {
    this.camera = camera

    // 位置跟随比注视点更「慢」一点，速度感更明显；
    // 9 的阻尼系数可以保证 24m/s 满速时相机仍不会落后太远
    this.positionLambda = 9
    this.lookLambda = 12

    this._desiredPosition = new THREE.Vector3()
    this._desiredLook = new THREE.Vector3()
    this._look = new THREE.Vector3()

    // 撞机震屏强度 0..1，随时间线性衰减；平方后用于算位移，手感更「顿」
    this.shake = 0
    // 独立累积时间，用于驱动震屏的正弦波形
    this._time = 0
  }

  /**
   * 触发一次震屏。
   * @param {number} amount 0..1，撞得越狠给得越大
   */
  addShake(amount = 0.6) {
    this.shake = Math.min(1, this.shake + amount)
  }

  /**
   * 瞬间对齐到理想机位：用于开局或重生，避免相机从原点飞过来。
   * @param {THREE.Vector3} playerPosition
   */
  snap(playerPosition) {
    this.shake = 0

    this._desiredPosition.copy(playerPosition).add(OFFSET)
    this.camera.position.copy(this._desiredPosition)

    this._desiredLook.copy(playerPosition).add(LOOK_OFFSET)
    this._look.copy(this._desiredLook)
    this.camera.lookAt(this._look)
  }

  /**
   * 平滑跟随。
   * @param {number} delta 秒
   * @param {THREE.Vector3} playerPosition 玩家当前世界坐标
   * @param {(x: number, z: number) => number} [groundHeightAt]
   *        地形高度采样函数；传入后相机会被抬到雪面之上，避免钻入山体
   */
  update(delta, playerPosition, groundHeightAt) {
    // ---- 位置：指数阻尼追踪 ----
    this._desiredPosition.copy(playerPosition).add(OFFSET)
    const positionAlpha = 1 - Math.exp(-this.positionLambda * delta)
    this.camera.position.lerp(this._desiredPosition, positionAlpha)

    // ---- 防穿地：相机始终高于该处雪面 1.5m ----
    // 只抬高不压低，因此不会破坏正常的跟随高度
    if (groundHeightAt) {
      const minY = groundHeightAt(this.camera.position.x, this.camera.position.z) + 1.5
      if (this.camera.position.y < minY) {
        this.camera.position.y = minY
      }
    }

    // ---- 注视点：比位置更灵敏，确保玩家始终位于画面偏下位置 ----
    this._desiredLook.copy(playerPosition).add(LOOK_OFFSET)
    const lookAlpha = 1 - Math.exp(-this.lookLambda * delta)
    this._look.lerp(this._desiredLook, lookAlpha)

    // ---- 撞机震屏：在平滑结果上叠加高频偏移 ----
    // 偏移不写回目标位置，因此震动结束后会自动收敛回正常机位
    this._time += delta
    if (this.shake > 0.001) {
      this.shake = Math.max(0, this.shake - delta * 1.6)
      const strength = this.shake * this.shake
      const offsetX = Math.sin(this._time * 47) * 0.26 * strength
      const offsetY = Math.sin(this._time * 61 + 1.7) * 0.2 * strength
      const offsetZ = Math.sin(this._time * 53 + 3.1) * 0.14 * strength

      this.camera.position.x += offsetX
      this.camera.position.y += offsetY
      this.camera.position.z += offsetZ
      // 注视点同步晃一点，但幅度减半，避免画面整体位移过大
      this._look.x += offsetX * 0.5
      this._look.y += offsetY * 0.5
    }

    this.camera.lookAt(this._look)
  }
}
