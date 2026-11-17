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

// 相机相对玩家的偏移：+Z 在玩家身后，+X 形成越肩视角。
// 机位比野外雪原更近、更低，强化两侧树墙之间的穿梭感
const OFFSET = new THREE.Vector3(1.5, 2.4, 5.8)
// 注视点相对玩家的偏移：看向前方 8.5m、略高于雪面的位置
const LOOK_OFFSET = new THREE.Vector3(0, 1.0, -8.5)

// 动态视野：低速 56°，满速 72°，与玩家最高速度（约 86 km/h）对应
const BASE_FOV = 56
const MAX_FOV = 72
// 第一人称：基础 90°、极速 104°，边缘流速更强，贴地飞驰的压迫感更明显
const FP_BASE_FOV = 90
const FP_MAX_FOV = 104
// Fever 状态下额外拉大的视野
const FEVER_FOV_BONUS = 9
const MAX_FOV_SPEED_KMH = 86
// FOV 收缩 / 扩张的阻尼系数，越小越「拖」，太大会显得抽搐
const FOV_LAMBDA = 3.5
// 横向跟随明显慢于纵向：转向时角色会偏离画面中心，形成惯性感
const CAMERA_LATERAL_LAMBDA = 4
// 注视点的横向阻尼更慢，进一步放大「甩出去」的离心视觉
const LOOK_LATERAL_LAMBDA = 2.4
// 第一人称贴得极紧，避免相机滞后导致眩晕
const FP_FOLLOW_LAMBDA = 24
// 第一人称注视点的阻尼：比机位略慢一点，保留一点「视线惯性」
const FP_LOOK_LAMBDA = 22
// 视角切换的混合速度：约 0.4s 从越肩推到头部
const VIEW_BLEND_LAMBDA = 7
// 第一人称转向时相机的 Roll 上限（弧度）
const FP_ROLL_MAX = 0.17

export class CameraRig {
  /**
   * @param {THREE.PerspectiveCamera} camera
   */
  constructor(camera) {
    this.camera = camera

    this._desiredPosition = new THREE.Vector3()
    this._desiredLook = new THREE.Vector3()
    this._look = new THREE.Vector3()
    // 第一人称专用的临时向量，避免每帧分配
    this._fpPosition = new THREE.Vector3()
    this._fpLook = new THREE.Vector3()
    this._forward = new THREE.Vector3()

    // 'third' 越肩第三人称 / 'first' 第一人称
    this.mode = 'third'
    // 0 = 完全第三人称，1 = 完全第一人称；切换时平滑过渡
    this._viewBlend = 0
    // 第一人称的相机 Roll（绕镜头 Z 轴），转向时倾斜
    this.roll = 0

    // 撞机震屏强度 0..1，随时间线性衰减；平方后用于算位移，手感更「顿」
    this.shake = 0
    // 过门时的 FOV 冲击量（度），会快速衰减回正常视野
    this.fovPunch = 0
    // 独立累积时间，用于驱动震屏的正弦波形
    this._time = 0
  }
  /**
   * 触发过门时的 FOV 冲击。
   * @param {number} amount 额外视野（度），建议 5~9
   */
  addFovPunch(amount = 7) {
    this.fovPunch = Math.max(this.fovPunch, amount)
  }

  /**
   * 触发一次震屏。
   * @param {number} amount 0..1，撞得越狠给得越大
   */
  addShake(amount = 0.6) {
    this.shake = Math.min(1, this.shake + amount)
  }

  /**
   * 切换第一 / 第三人称。
   * @returns {'first'|'third'} 切换后的模式
   */
  toggleView() {
    this.mode = this.mode === 'third' ? 'first' : 'third'
    // 切换瞬间给一点 FOV 冲击，让「镜头推近 / 拉远」更有动感
    this.fovPunch = Math.max(this.fovPunch, 5)
    return this.mode
  }

  get isFirstPerson() {
    return this.mode === 'first'
  }

  /**
   * 瞬间对齐到理想机位：用于开局或重生，避免相机从原点飞过来。
   * @param {THREE.Vector3} playerPosition
   * @param {THREE.Vector3} [headPosition] 第一人称时的头部世界坐标
   */
  snap(playerPosition, headPosition) {
    this.shake = 0
    this.fovPunch = 0
    this.roll = 0
    this._viewBlend = this.mode === 'first' ? 1 : 0

    if (this.mode === 'first' && headPosition) {
      this.camera.position.copy(headPosition)
      this._look.copy(headPosition)
      this._look.y -= 1.6
      this._look.z -= 10
      this.camera.fov = FP_BASE_FOV
    } else {
      // 重开时速度归零，视野也要回到基础值
      this.camera.fov = BASE_FOV
      this._desiredPosition.copy(playerPosition).add(OFFSET)
      this.camera.position.copy(this._desiredPosition)

      this._desiredLook.copy(playerPosition).add(LOOK_OFFSET)
      this._look.copy(this._desiredLook)
    }

    this.camera.updateProjectionMatrix()
    this.camera.lookAt(this._look)
  }

  /**
   * 平滑跟随。
   * @param {number} delta 秒
   * @param {THREE.Vector3} playerPosition 玩家当前世界坐标
   * @param {(x: number, z: number) => number} [groundHeightAt]
   *        地形高度采样函数；传入后相机会被抬到雪面之上，避免钻入山体
   * @param {number} [speedKmh] 当前速度，用于动态 FOV 与高速微震
   * @param {{ headPosition?: THREE.Vector3, yaw?: number, steer?: number, fever?: number }} [options]
   *        headPosition：第一人称头部世界坐标；yaw：角色朝向；steer：转向意图；fever：0..1
   */
  update(delta, playerPosition, groundHeightAt, speedKmh = 0, options = {}) {
    this._time += delta

    const headPosition = options.headPosition
    const yaw = options.yaw || 0
    const steer = options.steer || 0
    const fever = Math.min(1, Math.max(0, options.fever || 0))

    // ---- 视角混合：第三人称 → 第一人称平滑推近 ----
    const targetBlend = this.mode === 'first' && headPosition ? 1 : 0
    this._viewBlend +=
      (targetBlend - this._viewBlend) * (1 - Math.exp(-VIEW_BLEND_LAMBDA * delta))
    if (this._viewBlend < 0.001) this._viewBlend = 0
    else if (this._viewBlend > 0.999) this._viewBlend = 1
    const blend = this._viewBlend

    const speedT = Math.min(1, Math.max(0, speedKmh) / MAX_FOV_SPEED_KMH)

    // ---- 动态视野：速度 + 过门冲击 + Fever 加成 ----
    this.fovPunch = Math.max(0, this.fovPunch - delta * 12)
    const baseFov = BASE_FOV + (FP_BASE_FOV - BASE_FOV) * blend
    const maxFov = MAX_FOV + (FP_MAX_FOV - MAX_FOV) * blend
    const targetFov = Math.min(
      118,
      baseFov + (maxFov - baseFov) * speedT + this.fovPunch + FEVER_FOV_BONUS * fever
    )
    const fovAlpha = 1 - Math.exp(-FOV_LAMBDA * delta)
    const nextFov = this.camera.fov + (targetFov - this.camera.fov) * fovAlpha
    if (Math.abs(nextFov - this.camera.fov) > 0.01) {
      this.camera.fov = nextFov
      this.camera.updateProjectionMatrix()
    }

    // ---- 位置：指数阻尼追踪 ----
    this._desiredPosition.copy(playerPosition).add(OFFSET)
    if (headPosition && blend > 0) {
      // 第一人称：头部锚点再向前 0.16m，避免看到自己的护目镜边缘
      this._forward.set(-Math.sin(yaw), 0, -Math.cos(yaw))
      this._fpPosition.copy(headPosition).addScaledVector(this._forward, 0.16)
      // 高速时极轻微的头部起伏，强化「贴地飞驰」的体感
      this._fpPosition.y += Math.sin(this._time * 18) * 0.012 * speedT
      this._desiredPosition.lerp(this._fpPosition, blend)
    }

    // 越肩时横向故意慢半拍；第一人称则整体贴紧头部
    const followLambda = 9 + (FP_FOLLOW_LAMBDA - 9) * blend
    const lateralLambda =
      CAMERA_LATERAL_LAMBDA + (followLambda - CAMERA_LATERAL_LAMBDA) * blend
    const positionAlpha = 1 - Math.exp(-followLambda * delta)
    const lateralAlpha = 1 - Math.exp(-lateralLambda * delta)

    // 完全进入第一人称后直接贴合头部：高速下任何阻尼都会产生
    // 「相机落在脑后 1 米」的滞后，第一人称必须零延迟
    const fpLocked = blend > 0.985
    if (fpLocked) {
      this.camera.position.copy(this._desiredPosition)
    } else {
      this.camera.position.x +=
        (this._desiredPosition.x - this.camera.position.x) * lateralAlpha
      this.camera.position.y +=
        (this._desiredPosition.y - this.camera.position.y) * positionAlpha
      this.camera.position.z +=
        (this._desiredPosition.z - this.camera.position.z) * positionAlpha
    }

    // ---- 防穿地：越肩视角下相机始终高于雪面 1.5m ----
    // 第一人称相机就在头部，不需要（也不应该）再抬高
    if (groundHeightAt && blend < 0.5) {
      const minY = groundHeightAt(this.camera.position.x, this.camera.position.z) + 1.5
      if (this.camera.position.y < minY) {
        this.camera.position.y = minY
      }
    }

    // ---- 注视点 ----
    this._desiredLook.copy(playerPosition).add(LOOK_OFFSET)
    if (headPosition && blend > 0) {
      // 第一人称看向前方 16m、略微俯向雪坡，而不是平视天空
      this._fpLook.copy(headPosition).addScaledVector(this._forward, 16)
      this._fpLook.y -= 2.4
      this._desiredLook.lerp(this._fpLook, blend)
    }

    const lookLambda = 12 + (FP_LOOK_LAMBDA - 12) * blend
    const lookLateralLambda = LOOK_LATERAL_LAMBDA + (lookLambda - LOOK_LATERAL_LAMBDA) * blend
    const lookAlpha = 1 - Math.exp(-lookLambda * delta)
    const lookLateralAlpha = 1 - Math.exp(-lookLateralLambda * delta)

    this._look.x += (this._desiredLook.x - this._look.x) * lookLateralAlpha
    this._look.y += (this._desiredLook.y - this._look.y) * lookAlpha
    this._look.z += (this._desiredLook.z - this._look.z) * lookAlpha

    // ---- 高速微震：超过半速后叠加细密抖动；第一人称减半避免晕眩 ----
    const shakeScale = 1 - 0.45 * blend
    const rumble = Math.max(0, (speedT - 0.5) / 0.5)
    const rumbleAmp = 0.02 * rumble * rumble * shakeScale
    let offsetX = Math.sin(this._time * 43) * rumbleAmp
    let offsetY = Math.sin(this._time * 57 + 1.3) * rumbleAmp
    let offsetZ = Math.sin(this._time * 49 + 2.6) * rumbleAmp * 0.6

    // ---- 撞机震屏：在平滑结果上叠加高频偏移 ----
    if (this.shake > 0.001) {
      this.shake = Math.max(0, this.shake - delta * 1.6)
      const strength = this.shake * this.shake * shakeScale
      offsetX += Math.sin(this._time * 47) * 0.26 * strength
      offsetY += Math.sin(this._time * 61 + 1.7) * 0.2 * strength
      offsetZ += Math.sin(this._time * 53 + 3.1) * 0.14 * strength
    }

    if (offsetX !== 0 || offsetY !== 0 || offsetZ !== 0) {
      this.camera.position.x += offsetX
      this.camera.position.y += offsetY
      this.camera.position.z += offsetZ
      this._look.x += offsetX * 0.5
      this._look.y += offsetY * 0.5
    }

    this.camera.lookAt(this._look)

    // ---- 第一人称转向 Roll ----
    // 按下 A / D 时镜头随身体轻微侧倾；切回第三人称时平滑归零
    const targetRoll = -steer * FP_ROLL_MAX * blend * (0.35 + 0.65 * speedT)
    this.roll += (targetRoll - this.roll) * (1 - Math.exp(-9 * delta))
    if (Math.abs(this.roll) > 0.0005) {
      this.camera.rotateZ(this.roll)
    }
  }
}
