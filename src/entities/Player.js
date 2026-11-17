import * as THREE from 'three'
import * as CANNON from 'cannon-es'

/**
 * Player（玩家控制器）
 * ------------------------------------------------------------------
 * 视觉：全部由基础几何体拼出的低多边形滑雪者（雪板 + 身体 + 头盔），
 *       不使用任何外部模型文件，方便直接移植到小程序 WebView。
 * 物理：Cannon.Sphere + fixedRotation，相当于一个「不翻滚的雪橇」。
 *       雪面材质摩擦仅 0.015，玩家会顺坡滑行而不是粘在地上。
 *
 * 坐标约定：玩家朝 -Z 速降，Y 向上，X 为左右方向。
 */

// 物理球体半径：同时决定雪板离雪面的高度与碰撞体积
const RADIUS = 0.55
// 玩家质量（kg），影响重力加速度之外的外力反馈
const MASS = 8
// 持续前向推力（N）：补偿低摩擦下的速度损失，让滑行更快进入状态
const DRIVE_FORCE = 26
// 水平速度上限（m/s）：约 86 km/h，避免越滑越快难以操控
const MAX_SPEED = 24
// 侧向转向加速度（m/s²）：直接作用于速度，横向响应干脆
const STEER_ACCEL = 12
// 横向速度上限（m/s），避免横向移动比前进还快
const MAX_LATERAL_SPEED = 11
// 雪道横向活动边界（半宽 80m 再留 14m 余量）
const MAX_X = 66
// 出生点：雪坡上方，落地过程同时验证重力
const DEFAULT_SPAWN = { x: 0, y: 1.8, z: 0 }

export class Player {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../core/PhysicsWorld.js').PhysicsWorld} physics
   * @param {{ spawn?: { x: number, y: number, z: number } }} options 出生点（地形接入后由外部传入）
   */
  constructor(scene, physics, { spawn = DEFAULT_SPAWN } = {}) {
    this.scene = scene
    this.physics = physics

    // 复用同一个 Vec3，避免每帧产生垃圾对象（移动端 GC 敏感）
    this._driveForce = new CANNON.Vec3(0, 0, -DRIVE_FORCE)
    this._steerImpulse = new CANNON.Vec3()
    // 当前朝向（绕 Y 轴弧度），用于平滑转身
    this.yaw = 0
    // 当前雪板俯仰角（弧度），由地形坡度驱动并做平滑
    this.pitch = 0
    this.targetPitch = 0
    // 压弯角度：转向时身体向内侧倾斜
    this.bank = 0
    this.targetBank = 0

    this.spawn = spawn
    this.visual = this.createVisual()
    this.body = this.createBody()

    // 撞到障碍物时的回调，由 main.js 注入（用于触发失败结算）
    this.onCrash = null
    this.handleCollide = this.handleCollide.bind(this)
    this.body.addEventListener('collide', this.handleCollide)

    scene.add(this.visual)
    this.sync(0) // 先同步一次，避免首帧出现在原点
  }

  /**
   * 物理引擎在发生碰撞时回调。
   * 只有撞到障碍物材质、且法向冲击速度足够大时才判定为「撞车」，
   * 避免刚起步时与雪面的轻微接触被误判。
   */
  handleCollide(event) {
    if (!this.onCrash) return

    const other = event.body
    if (!other || other.material !== this.physics.materials.obstacle) return

    // getImpactVelocityAlongNormal 在 cannon-es 中返回沿接触法线的相对速度
    const impact = Math.abs(event.contact.getImpactVelocityAlongNormal())
    if (impact < 2) return

    this.onCrash(impact)
  }

  /** 低多边形滑雪者：一个 Group 内组合多块基础几何体 */
  createVisual() {
    const group = new THREE.Group()

    // 内层 Group 负责「贴合坡面」的俯仰，外层负责转向（Yaw），互不干扰
    const tilt = new THREE.Group()
    this.tilt = tilt
    group.add(tilt)

    const boardMat = new THREE.MeshStandardMaterial({
      color: 0xff6b35, // 橙色雪板，在雪地上辨识度最高
      roughness: 0.5,
      metalness: 0.1,
      flatShading: true,
    })
    const jacketMat = new THREE.MeshStandardMaterial({
      color: 0x1f4e79, // 深蓝雪服
      roughness: 0.8,
      flatShading: true,
    })
    const helmetMat = new THREE.MeshStandardMaterial({
      color: 0xf4f7fb, // 白色头盔
      roughness: 0.45,
      flatShading: true,
    })
    const pantsMat = new THREE.MeshStandardMaterial({
      color: 0x263238,
      roughness: 0.9,
      flatShading: true,
    })

    // 雪板：略窄于肩，长度 2m，底面刚好与物理球体底部齐平
    const board = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.08, 2.05), boardMat)
    board.position.y = -RADIUS + 0.04
    tilt.add(board)

    // 小腿 / 雪裤：一块矮方块，让雪板与上身之间有过渡
    const legs = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.34, 0.32), pantsMat)
    legs.position.y = -RADIUS + 0.24
    tilt.add(legs)

    // 上身：长方体，略微前倾，滑行姿态更自然
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.66, 0.34), jacketMat)
    torso.position.set(0, 0.02, 0.03)
    torso.rotation.x = 0.16
    tilt.add(torso)

    // 头盔：二十面体细分 1 次，低多边形但轮廓圆润
    const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.24, 1), helmetMat)
    head.position.set(0, 0.5, 0.02)
    tilt.add(head)

    // 护目镜：贴在头盔前侧（-Z 为前进方向），让角色轮廓更容易辨识
    const goggles = new THREE.Mesh(
      new THREE.BoxGeometry(0.32, 0.09, 0.08),
      new THREE.MeshStandardMaterial({ color: 0x14202b, roughness: 0.3, metalness: 0.2 })
    )
    goggles.position.set(0, 0.52, -0.2)
    tilt.add(goggles)

    // 所有部件统一开启投影 / 接收投影
    group.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true
        child.receiveShadow = true
      }
    })

    return group
  }

  /** 物理刚体：球体 + 禁止旋转，行为接近雪橇 / 滑板 */
  createBody() {
    const body = new CANNON.Body({
      mass: MASS,
      material: this.physics.materials.player,
      shape: new CANNON.Sphere(RADIUS),
      position: new CANNON.Vec3(this.spawn.x, this.spawn.y, this.spawn.z),
      linearDamping: 0.01, // 极低空气阻力
      angularDamping: 1,
      fixedRotation: true, // 球体不翻滚，避免视觉与物理表现割裂
      allowSleep: false, // 无尽滑行，禁止休眠
    })

    this.physics.addBody(body)
    return body
  }

  /**
   * 设置目标俯仰角（由地形坡度计算）。
   * 实际角度在 sync() 中做指数平滑，避免在三角面边界处抖动。
   * @param {number} pitch 弧度，下坡时为负
   */
  setPitch(pitch) {
    this.targetPitch = pitch
  }

  /**
   * 设置转向意图，驱动身体压弯。
   * @param {number} steer -1 左 / 0 不动 / +1 右
   */
  setSteer(steer) {
    // 向右转（steer=+1）时身体向右倾，绕 Z 轴的角度为负
    this.targetBank = -steer * 0.26
  }

  /**
   * 每帧物理推进「之前」调用：
   * 施加前向推力与侧向转向力，并处理横向限速、赛道边界和总速度上限。
   * 放在 step 之前，保证力在本次物理积分中生效。
   * @param {number} delta 秒
   * @param {number} steer -1 左 / 0 不动 / +1 右
   */
  preStep(delta, steer = 0) {
    this.body.applyForce(this._driveForce)

    // ---- 侧向转向 ----
    if (steer !== 0) {
      // 用「冲量 = 加速度 × 质量 × 时间」而不是固定力：
      // 即使渲染帧率不同，横向加速度也保持一致，手感不会忽快忽慢
      this._steerImpulse.set(steer * STEER_ACCEL * MASS * delta, 0, 0)
      this.body.applyImpulse(this._steerImpulse)
    } else {
      // 没有输入时缓慢收敛横向速度，模拟雪板刃的轻微抓地
      this.body.velocity.x *= Math.exp(-1.8 * delta)
    }

    const velocity = this.body.velocity

    // 横向速度上限
    if (Math.abs(velocity.x) > MAX_LATERAL_SPEED) {
      velocity.x = Math.sign(velocity.x) * MAX_LATERAL_SPEED
    }

    // 赛道边界：一旦超出就把位置拉回，并清掉向外的那部分速度
    const { position } = this.body
    if (position.x < -MAX_X) {
      position.x = -MAX_X
      if (velocity.x < 0) velocity.x = 0
    } else if (position.x > MAX_X) {
      position.x = MAX_X
      if (velocity.x > 0) velocity.x = 0
    }

    // 水平限速：只缩放 X/Z，保留重力带来的 Y 轴速度
    const horizontalSpeed = Math.hypot(velocity.x, velocity.z)
    if (horizontalSpeed > MAX_SPEED) {
      const scale = MAX_SPEED / horizontalSpeed
      velocity.x *= scale
      velocity.z *= scale
    }
  }

  /**
   * 每帧物理推进「之后」调用：把刚体状态同步到可视网格。
   * @param {number} delta 秒
   */
  sync(delta) {
    const { position, velocity } = this.body
    this.visual.position.set(position.x, position.y, position.z)

    // 根据水平速度方向平滑转向；速度过低时保持原朝向，避免静止抖动
    if (velocity.x * velocity.x + velocity.z * velocity.z > 0.25) {
      const targetYaw = Math.atan2(-velocity.x, -velocity.z)
      this.yaw = dampAngle(this.yaw, targetYaw, 10, delta)
      this.visual.rotation.y = this.yaw
    }

    // 雪板俯仰：指数平滑跟随地形坡度，防止在三角面交界处突然抬头 / 低头
    this.pitch += (this.targetPitch - this.pitch) * (1 - Math.exp(-8 * delta))
    this.tilt.rotation.x = this.pitch

    // 压弯：转向时身体向内侧倾斜，增强操控反馈
    this.bank += (this.targetBank - this.bank) * (1 - Math.exp(-10 * delta))
    this.tilt.rotation.z = this.bank
  }

  /** 当前水平速度（km/h），用于 HUD */
  get speedKmh() {
    const { x, z } = this.body.velocity
    return Math.hypot(x, z) * 3.6
  }

  /**
   * 回到起点并清空所有运动状态（用于撞击后重开）。
   * @param {{ x: number, y: number, z: number }} spawn
   */
  reset(spawn = this.spawn) {
    this.spawn = spawn

    // 位置与速度复位
    this.body.position.set(spawn.x, spawn.y, spawn.z)
    this.body.velocity.setZero()
    this.body.angularVelocity.setZero()
    // 清空上一帧累计的力 / 力矩，防止重开后残留推力
    this.body.force.setZero()
    this.body.torque.setZero()
    this.body.quaternion.set(0, 0, 0, 1)
    this.body.aabbNeedsUpdate = true
    this.body.wakeUp()

    // 视觉姿态复位
    this.yaw = 0
    this.pitch = 0
    this.targetPitch = 0
    this.bank = 0
    this.targetBank = 0
    this.visual.rotation.y = 0
    this.tilt.rotation.set(0, 0, 0)
    this.sync(0)
  }
}

/**
 * 角度平滑插值（自动处理 ±π 环绕）。
 * 使用指数阻尼，保证不同帧率下的平滑速度一致。
 */
function dampAngle(current, target, lambda, delta) {
  let diff = target - current
  // 取最短转向路径，避免从 179° 转到 -179° 时绕远路
  diff = Math.atan2(Math.sin(diff), Math.cos(diff))
  return current + diff * (1 - Math.exp(-lambda * delta))
}
