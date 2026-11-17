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
// 过门奖励：短时间内放宽限速并给一个向前的脉冲
const BOOST_SPEED = 30
const BOOST_IMPULSE = 2.2
const BOOST_DURATION = 0.9
// Fever 模式：连击 5 次后限速进一步放开，约 122 km/h
const FEVER_SPEED = 34
// 起跳冲量对应的初速度（m/s）：重力 -32 下约 0.5s 滞空
const JUMP_VELOCITY = 8.2
// 侧向转向加速度（m/s²）：直接作用于速度，横向响应干脆
const STEER_ACCEL = 12
// 横向速度上限（m/s），避免横向移动比前进还快
const MAX_LATERAL_SPEED = 11
// 兜底边界：雪道本身会随 S 弯左右摆动，真正的边界由分段挡墙负责，
// 这里只是防止异常状态下飞出地图
const MAX_X = 60
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
    this._jumpImpulse = new CANNON.Vec3()
    // 当前朝向（绕 Y 轴弧度），用于平滑转身
    this.yaw = 0
    // 当前雪板俯仰角（弧度），由地形坡度驱动并做平滑
    this.pitch = 0
    this.targetPitch = 0
    // 压弯角度：转向时身体向内侧倾斜
    this.bank = 0
    this.targetBank = 0
    // 过门奖励的剩余时间（秒）；> 0 时水平限速提升到 BOOST_SPEED
    this.boostTimer = 0
    // 是否处于 Fever 连击状态（由 main.js 每帧同步）
    this.fever = false
    // 是否贴地：由主循环按「球心到雪面高度差」每帧写入，跳跃时用它做判定
    this.grounded = true
    // 围巾摆动相位
    this._scarfTime = 0

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

  /**
   * Low-Poly 潮流滑雪者
   * ------------------------------------------------------------------
   * 全部由基础几何体拼装，不加载任何外部模型：
   *   - 球体头部 + 宽扁高反光护目镜 + 毛线帽（半球 + 绒球）
   *   - 上宽下窄的圆柱雪服（Oversize 羽绒服），叠加绗缝横条与手臂
   *   - 前后翘头的雪板（细分长方体后抬升两端顶点）
   *   - 红色围巾：每帧按正弦波改写顶点，速度越快甩得越猛
   */
  createVisual() {
    const group = new THREE.Group()

    // 内层 Group 负责「贴合坡面」的俯仰与压弯，外层负责转向（Yaw），互不干扰
    const tilt = new THREE.Group()
    this.tilt = tilt
    group.add(tilt)

    // ---- 材质 ----
    const jacketMat = new THREE.MeshStandardMaterial({
      color: 0xc6ff3d, // 荧光绿 Oversize 雪服
      roughness: 0.62,
      metalness: 0.04,
      flatShading: true,
    })
    const jacketSeamMat = new THREE.MeshStandardMaterial({
      color: 0x9ed61f, // 绗缝暗条
      roughness: 0.72,
      flatShading: true,
    })
    const pantsMat = new THREE.MeshStandardMaterial({
      color: 0x263238,
      roughness: 0.9,
      flatShading: true,
    })
    const boardMat = new THREE.MeshStandardMaterial({
      color: 0xff6b35, // 亮橙雪板
      roughness: 0.45,
      metalness: 0.15,
      flatShading: true,
    })
    const bindingMat = new THREE.MeshStandardMaterial({
      color: 0x1a1f26,
      roughness: 0.6,
      flatShading: true,
    })
    const gloveMat = new THREE.MeshStandardMaterial({
      color: 0x1a1f26,
      roughness: 0.75,
      flatShading: true,
    })
    const skinMat = new THREE.MeshStandardMaterial({
      color: 0xf2c9a4,
      roughness: 0.8,
      flatShading: true,
    })
    // 护目镜：低粗糙度 + 高金属度，日光下形成锐利高光；
    // 另加一条浅蓝反光条，在没有环境贴图时也能读出「镜面」质感
    const goggleMat = new THREE.MeshStandardMaterial({
      color: 0x0b1218,
      roughness: 0.05,
      metalness: 0.92,
      flatShading: false,
    })
    const beanieMat = new THREE.MeshStandardMaterial({
      color: 0xff7a3d, // 暖橙毛线帽，与雪板呼应
      roughness: 0.92,
      flatShading: true,
    })
    const scarfMat = new THREE.MeshStandardMaterial({
      color: 0xff3b30, // 正红围巾，雪地里最抢眼的点缀
      roughness: 0.85,
      flatShading: true,
    })

    // ---- 雪板：细分长方体 + 抬升两端顶点，做出翘头 ----
    const boardGeometry = new THREE.BoxGeometry(0.34, 0.06, 2.05, 1, 1, 10)
    const boardPositions = boardGeometry.attributes.position
    for (let i = 0; i < boardPositions.count; i++) {
      const z = boardPositions.getZ(i)
      const t = Math.abs(z) / 1.025
      if (t > 0.68) {
        const k = (t - 0.68) / 0.32
        // 两端向上翘起，并把板头略微收窄，轮廓更像真实单板
        boardPositions.setY(i, boardPositions.getY(i) + k * k * 0.16)
        boardPositions.setX(i, boardPositions.getX(i) * (1 - 0.26 * k))
      }
    }
    boardGeometry.computeVertexNormals()

    const board = new THREE.Mesh(boardGeometry, boardMat)
    board.position.y = -RADIUS + 0.05
    tilt.add(board)

    // 固定器：两块黑色横条，让「人站在板上」的关系更明确
    for (const z of [-0.32, 0.32]) {
      const binding = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.07, 0.16), bindingMat)
      binding.position.set(0, -RADIUS + 0.1, z)
      tilt.add(binding)
    }

    // ---- 双腿 ----
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.3, 0.24), pantsMat)
      leg.position.set(side * 0.13, -0.33, 0.02)
      tilt.add(leg)
    }

    // ---- 身体：上宽下窄的圆柱，模拟 Oversize 羽绒雪服 ----
    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.27, 0.66, 8), jacketMat)
    torso.position.y = 0.08
    torso.rotation.y = Math.PI / 8 // 让八边形的平面朝向正前方，正面更宽
    tilt.add(torso)

    // 绗缝横条：三道略大一点的薄圆柱，做出羽绒服的分段膨胀感
    const seams = [
      { y: -0.12, r: 0.3 },
      { y: 0.06, r: 0.32 },
      { y: 0.24, r: 0.338 },
    ]
    for (const seam of seams) {
      const band = new THREE.Mesh(
        new THREE.CylinderGeometry(seam.r, seam.r, 0.055, 8),
        jacketSeamMat
      )
      band.position.y = seam.y
      band.rotation.y = Math.PI / 8
      tilt.add(band)
    }

    // ---- 手臂与手套：自然向外张开，滑行姿态更松弛 ----
    for (const side of [-1, 1]) {
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.075, 0.46, 6), jacketMat)
      arm.position.set(side * 0.33, 0.1, 0.02)
      arm.rotation.z = side * 0.38
      arm.rotation.x = 0.12
      tilt.add(arm)

      const glove = new THREE.Mesh(new THREE.IcosahedronGeometry(0.085, 0), gloveMat)
      glove.position.set(side * 0.42, -0.14, 0.02)
      tilt.add(glove)
    }

    // ---- 头部：球体 + 护目镜 + 毛线帽 ----
    // 单独放在 headGroup 里，第一人称时整体隐藏，避免相机看到头内部
    const headGroup = new THREE.Group()
    headGroup.position.set(0, 0.63, 0.01)
    tilt.add(headGroup)
    this.headGroup = headGroup

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.225, 8, 6), skinMat)
    headGroup.add(head)

    // 护目镜主体：宽扁长方体，贴在脸的前方（-Z）
    const goggles = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.145, 0.12), goggleMat)
    goggles.position.set(0, 0.015, -0.18)
    headGroup.add(goggles)

    // 镜面反光条：一条倾斜的浅蓝亮带
    const glare = new THREE.Mesh(
      new THREE.BoxGeometry(0.26, 0.026, 0.012),
      new THREE.MeshBasicMaterial({
        color: 0xbfe9ff,
        transparent: true,
        opacity: 0.55,
        toneMapped: false,
      })
    )
    glare.position.set(-0.04, 0.05, -0.244)
    glare.rotation.z = -0.12
    headGroup.add(glare)

    // 护目镜头带：绕头一圈的深灰扁盒
    const strap = new THREE.Mesh(
      new THREE.BoxGeometry(0.46, 0.07, 0.36),
      new THREE.MeshStandardMaterial({ color: 0x262b32, roughness: 0.85, flatShading: true })
    )
    strap.position.set(0, 0.03, 0.03)
    headGroup.add(strap)

    // 毛线帽：半球帽体 + 顶部小绒球
    const beanie = new THREE.Mesh(
      new THREE.SphereGeometry(0.245, 8, 4, 0, Math.PI * 2, 0, Math.PI * 0.52),
      beanieMat
    )
    beanie.position.y = 0.015
    headGroup.add(beanie)

    const pom = new THREE.Mesh(new THREE.SphereGeometry(0.062, 6, 4), beanieMat)
    pom.position.y = 0.238
    headGroup.add(pom)

    // 第一人称相机锚点：头部偏前一点，稍微高于头心
    this.headAnchor = new THREE.Object3D()
    this.headAnchor.position.set(0, 0.7, -0.16)
    tilt.add(this.headAnchor)

    // ---- 围巾：领口 + 向后飘的长条 ----
    const collar = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.1, 0.32), scarfMat)
    collar.position.set(0, 0.42, 0.02)
    tilt.add(collar)

    // 长条沿 +Z 延伸（角色背后）。几何体向 +Z 平移，让 z=0 正好在脖子处，
    // 方便在 updateScarf 中按长度比例 t 做正弦波动
    const scarfGeometry = new THREE.BoxGeometry(0.17, 0.055, 0.78, 1, 1, 10)
    scarfGeometry.translate(0, 0, 0.39)
    const scarf = new THREE.Mesh(scarfGeometry, scarfMat)
    scarf.position.set(0.05, 0.41, 0.1)
    scarf.rotation.x = -0.08
    tilt.add(scarf)

    this.scarfGeometry = scarfGeometry
    // 保存未变形的顶点，作为每帧摆动的基准
    this._scarfBase = Float32Array.from(scarfGeometry.attributes.position.array)

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

    this.boostTimer = Math.max(0, this.boostTimer - delta)

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

    // 水平限速：只缩放 X/Z，保留重力带来的 Y 轴速度。
    // Fever 状态优先于普通过门加速：连击越高，允许的极速越快
    const maxSpeed = this.fever ? FEVER_SPEED : this.boostTimer > 0 ? BOOST_SPEED : MAX_SPEED
    const horizontalSpeed = Math.hypot(velocity.x, velocity.z)
    if (horizontalSpeed > maxSpeed) {
      const scale = maxSpeed / horizontalSpeed
      velocity.x *= scale
      velocity.z *= scale
    }
  }

  /**
   * 起跳：仅在贴地时生效，给刚体一个向上的冲量。
   * 冲量 = 质量 × 速度，因此不同质量下的起跳高度保持一致。
   * @returns {boolean} 是否成功起跳
   */
  jump() {
    if (!this.grounded) return false

    this._jumpImpulse.set(0, MASS * JUMP_VELOCITY, 0)
    this.body.applyImpulse(this._jumpImpulse)
    // 立即标记离地，避免同一帧内重复触发
    this.grounded = false
    return true
  }

  /** 切换 Fever 状态（速度上限由 preStep 读取） */
  setFever(active) {
    this.fever = active
  }

  /**
   * 第一人称下隐藏头部组件，避免相机看到头内部；
   * 身体、雪板与围巾仍然保留，低头 / 边缘处依然有代入感。
   */
  setFirstPerson(active) {
    if (this.headGroup) this.headGroup.visible = !active
  }

  /**
   * 头部锚点的世界坐标（第一人称相机使用）。
   * getWorldPosition 会先刷新父级世界矩阵，因此结果始终是最新的。
   * @param {THREE.Vector3} target
   */
  getHeadWorldPosition(target = new THREE.Vector3()) {
    this.headAnchor.getWorldPosition(target)
    return target
  }

  /**
   * 围巾摆动：沿长度方向做两组不同频率的正弦波。
   * 振幅随速度增大，静止时仍保留轻微飘动，避免像一块硬纸板。
   */
  updateScarf(delta) {
    if (!this.scarfGeometry || !this._scarfBase) return

    this._scarfTime += delta
    const speedT = Math.min(1, this.speedKmh / 90)
    const amplitude = 0.03 + speedT * 0.15
    const time = this._scarfTime

    const attribute = this.scarfGeometry.attributes.position
    const array = attribute.array
    const base = this._scarfBase

    for (let i = 0; i < attribute.count; i++) {
      const p = i * 3
      const baseX = base[p]
      const baseY = base[p + 1]
      const baseZ = base[p + 2]

      // t：0 在脖子处，1 在围巾末端；末端摆动幅度最大
      const t = Math.min(1, Math.max(0, baseZ / 0.78))
      const power = t * t
      const waveX = Math.sin(time * (8 + speedT * 10) + t * 7.0)
      const waveY = Math.cos(time * (6 + speedT * 8) + t * 4.5)

      array[p] = baseX + waveX * amplitude * power
      array[p + 1] = baseY - t * 0.14 + waveY * amplitude * 0.4 * power
      array[p + 2] = baseZ
    }

    attribute.needsUpdate = true
  }

  /**
   * 穿过旗门的奖励：短时间提升限速 + 向前的速度脉冲。
   * @param {number} duration 持续时间（秒）
   */
  applyBoost(duration = BOOST_DURATION) {
    this.boostTimer = Math.max(this.boostTimer, duration)

    const velocity = this.body.velocity
    const speed = Math.hypot(velocity.x, velocity.z)

    if (speed > 0.1) {
      velocity.x += (velocity.x / speed) * BOOST_IMPULSE
      velocity.z += (velocity.z / speed) * BOOST_IMPULSE
    } else {
      velocity.z -= BOOST_IMPULSE
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

    // 围巾随速度与时间摆动
    this.updateScarf(delta)
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
    this.boostTimer = 0
    this.fever = false
    this.grounded = true
    this._scarfTime = 0
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
