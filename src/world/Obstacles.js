import * as THREE from 'three'
import * as CANNON from 'cannon-es'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { mulberry32 } from '../utils/Random.js'
import { TRACK_WALL } from './Terrain.js'

/**
 * CourseField（商业雪道障碍物：树墙 + 霓虹旗门）
 * ------------------------------------------------------------------
 * 1. 树墙：沿蜿蜒赛道的两侧谷壁生成，始终垂直于地面向上生长；
 *    两侧各有一条分段物理挡墙，随 S 弯方向旋转，保证玩家无法冲出雪道。
 * 2. 赛道净空：中线两侧 TRACK_HALF 内不生成任何树，玩家有充足的走线空间。
 * 3. 旗门：每 Chunk 一扇，左右 / 红蓝交替；穿过时触发粒子爆发与速度奖励。
 *
 * 性能：树木用 InstancedMesh（每个 Chunk 一次 draw call）；
 *      物理上只保留分段挡墙 + 每扇旗门两根旗杆。
 */

// 挡墙内表面距赛道中线的距离 = 树墙内缘
const WALL_INNER = TRACK_WALL
const WALL_BODY_X = WALL_INNER + 1.5 // 挡墙中心（半宽 1.5 → 内表面正好在树墙内缘）
const WALL_BODY_HALF_X = 1.5
const WALL_BODY_HALF_Y = 14
const WALL_BODY_Y_OFFSET = 4
// 每条挡墙沿 Z 切成 8 段，逐段贴合 S 弯并旋转
const WALL_SEGMENTS = 8

// 树墙三排：内排最密（视觉边界），越往外越稀疏、树越大
const TREE_ROWS = [
  { inset: TRACK_WALL, spread: 3.0, step: 4.0, scale: [0.85, 1.15] },
  { inset: TRACK_WALL + 6, spread: 6.0, step: 6.5, scale: [1.0, 1.35] },
  { inset: TRACK_WALL + 15, spread: 12.0, step: 9.0, scale: [1.1, 1.6] },
]

// 旗门参数
const GATE_CENTER_X = 5 // 门中心相对赛道中线的横向偏移
const GATE_POLE_OFFSET = 3.2 // 旗杆到门中心的距离
const GATE_HEIGHT = 3.6
// 激光带贴在高处：相机高度约 3m，带子放在其上沿，穿门时不会糊住镜头
const GATE_BANNER_Y = 3.25
const GATE_BANNER_WIDTH = GATE_POLE_OFFSET * 2
// 判定「穿过旗门」的有效半宽：略小于两杆间距
const GATE_PASS_HALF = GATE_POLE_OFFSET - 0.35

/**
 * 给几何体刷上单一顶点色。
 * 合并后所有部件共用一个 vertexColors 材质，减少材质与 draw call。
 */
function paint(geometry, hex) {
  const color = new THREE.Color(hex)
  const count = geometry.attributes.position.count
  const colors = new Float32Array(count * 3)

  for (let i = 0; i < count; i++) {
    colors[i * 3] = color.r
    colors[i * 3 + 1] = color.g
    colors[i * 3 + 2] = color.b
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return geometry
}

/** 低多边形松树：树干 + 两层锥形树冠 */
function createTreeGeometry() {
  const trunk = new THREE.CylinderGeometry(0.22, 0.34, 1.8, 5).toNonIndexed()
  trunk.translate(0, 0.9, 0)
  paint(trunk, 0x6b4b30)

  const lower = new THREE.ConeGeometry(1.85, 3.0, 6).toNonIndexed()
  lower.translate(0, 2.9, 0)
  paint(lower, 0x1f5c3a)

  const upper = new THREE.ConeGeometry(1.3, 2.5, 6).toNonIndexed()
  upper.translate(0, 4.6, 0)
  paint(upper, 0x2a754a)

  return mergeGeometries([trunk, lower, upper], false)
}

// 几何体与材质在所有 Chunk 的实例之间共享
const treeGeometry = createTreeGeometry()
const treeMaterial = new THREE.MeshStandardMaterial({
  vertexColors: true,
  flatShading: true,
  roughness: 0.88,
  metalness: 0,
})

// 旗门：粗壮霓虹柱 + 半透明激光带。
// 全部使用 MeshBasicMaterial（toneMapped: false），逆光下依然鲜亮
const poleGeometry = new THREE.CylinderGeometry(0.16, 0.16, GATE_HEIGHT, 8)
const bannerGeometry = new THREE.PlaneGeometry(GATE_BANNER_WIDTH, 0.38)
const gateStyles = [
  {
    pole: new THREE.MeshBasicMaterial({ color: 0xff2d55, toneMapped: false }),
    banner: new THREE.MeshBasicMaterial({
      color: 0xff2d55,
      transparent: true,
      opacity: 0.45,
      side: THREE.DoubleSide,
      depthWrite: false,
      toneMapped: false,
    }),
  },
  {
    pole: new THREE.MeshBasicMaterial({ color: 0x28a7ff, toneMapped: false }),
    banner: new THREE.MeshBasicMaterial({
      color: 0x28a7ff,
      transparent: true,
      opacity: 0.45,
      side: THREE.DoubleSide,
      depthWrite: false,
      toneMapped: false,
    }),
  },
]

export class ObstacleField {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../core/PhysicsWorld.js').PhysicsWorld} physics
   * @param {import('./Terrain.js').Terrain} terrain
   */
  constructor(scene, physics, terrain) {
    this.scene = scene
    this.physics = physics
    this.terrain = terrain
    /** @type {Map<number, { trees: THREE.InstancedMesh, treeCount: number, walls: CANNON.Body[], gates: Array<any> }>} */
    this.chunks = new Map()

    // 穿门奖励回调：由 main.js 注入（粒子 + 加速 + FOV）
    this.onGatePassed = null
    // 从门外侧掠过 / 完全错过的回调：用于中断 Combo
    this.onGateMissed = null
    // 上一帧玩家位置，用于检测是否跨过旗门平面
    this._lastPlayer = null
  }

  /** 当前生效的障碍物数量（树 + 旗门），调试用 */
  get activeCount() {
    let count = 0
    for (const entry of this.chunks.values()) {
      count += entry.treeCount + entry.gates.length
    }
    return count
  }

  /**
   * Chunk 生成时布置树墙、挡墙与旗门。
   * @param {number} index Chunk 下标
   * @param {number} startZ Chunk 近端的世界 Z
   */
  spawnChunk(index, startZ) {
    const depth = this.terrain.chunkDepth
    // 每个 Chunk 用独立种子：同一段雪道每次生成完全一致
    const random = mulberry32((Math.imul(index + 1, 2654435761) ^ 0x9e3779b9) >>> 0)

    const trees = this.createTreeWall(startZ, depth, random)
    const walls = this.createSideWalls(startZ, depth)
    const gate = this.createGate(index, startZ, depth)

    this.chunks.set(index, {
      trees,
      treeCount: trees.count,
      walls,
      gates: gate ? [gate] : [],
    })
  }

  /**
   * 在两侧谷壁上生成一整片树林。
   * 树木只绕 Y 轴旋转（绝不沿地形法线倾斜），并略微下沉 0.25m 埋进雪面，
   * 这样即使长在斜坡上，树干也始终垂直向上、不会悬空。
   */
  createTreeWall(startZ, depth, random) {
    const placements = []

    for (const side of [-1, 1]) {
      for (const row of TREE_ROWS) {
        let z = startZ - random() * row.step

        while (z > startZ - depth) {
          const center = this.terrain.getCenterX(z)
          const x = center + side * (row.inset + random() * row.spread)
          const y = this.terrain.getHeightAt(x, z)
          const scale = row.scale[0] + random() * (row.scale[1] - row.scale[0])

          placements.push({
            x,
            // 微微下沉，抵消坡面倾斜造成的悬空
            y: y - 0.25 * scale,
            z,
            scale,
            rotation: random() * Math.PI * 2,
          })

          z -= row.step * (0.7 + random() * 0.6)
        }
      }
    }

    const mesh = new THREE.InstancedMesh(treeGeometry, treeMaterial, placements.length)
    const dummy = new THREE.Object3D()

    placements.forEach((tree, i) => {
      dummy.position.set(tree.x, tree.y, tree.z)
      // 仅绕 Y 轴旋转：树干的 Y 轴在世界空间中始终竖直向上
      dummy.rotation.set(0, tree.rotation, 0)
      dummy.scale.setScalar(tree.scale)
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
    })

    mesh.instanceMatrix.needsUpdate = true
    mesh.castShadow = true // 树墙要在雪道上投出斜长影子
    mesh.receiveShadow = true
    mesh.computeBoundingSphere()
    this.scene.add(mesh)

    return mesh
  }

  /**
   * 分段挡墙：每 8m 一段，逐段跟随 S 弯的中线与切线方向。
   * 如果整条 Chunk 只用一根直墙，弯道处会切进赛道。
   */
  createSideWalls(startZ, depth) {
    const bodies = []
    const segLen = depth / WALL_SEGMENTS
    const shape = new CANNON.Box(
      new CANNON.Vec3(WALL_BODY_HALF_X, WALL_BODY_HALF_Y, segLen / 2 + 0.6)
    )
    const axis = new CANNON.Vec3(0, 1, 0)

    for (let seg = 0; seg < WALL_SEGMENTS; seg++) {
      const zc = startZ - (seg + 0.5) * segLen
      const center = this.terrain.getCenterX(zc)
      // 中线对 z 的导数：用来计算切线方向与横向法线
      const slope =
        (this.terrain.getCenterX(zc - 0.5) - this.terrain.getCenterX(zc + 0.5))
      const invLen = 1 / Math.sqrt(1 + slope * slope)
      const normalX = invLen
      const normalZ = -slope * invLen
      const yaw = Math.atan(slope)

      for (const side of [-1, 1]) {
        const wallX = center + side * WALL_BODY_X * normalX
        const wallZ = zc + side * WALL_BODY_X * normalZ
        const groundY = this.terrain.getHeightAt(wallX, wallZ)

        const body = new CANNON.Body({
          mass: 0,
          material: this.physics.materials.obstacle,
          shape,
        })
        body.position.set(wallX, groundY + WALL_BODY_Y_OFFSET, wallZ)
        body.quaternion.setFromAxisAngle(axis, yaw)
        // 静态刚体必须手动刷新 AABB，否则宽相仍使用原点包围盒
        body.updateAABB()
        this.physics.addBody(body)
        bodies.push(body)
      }
    }

    return bodies
  }

  /**
   * 在 Chunk 中段生成一扇旗门：红蓝交替、左右交替，并随赛道切线旋转。
   */
  createGate(index, startZ, depth) {
    // Chunk 下标可能为负，先归一化成 0 / 1
    const variant = ((index % 2) + 2) % 2
    const style = gateStyles[variant]
    const z = startZ - depth * 0.5
    const slope =
      (this.terrain.getCenterX(z - 0.5) - this.terrain.getCenterX(z + 0.5))
    const yaw = Math.atan(slope)
    // 左右交替，逼玩家在树墙与旗门之间走 S 形
    const centerX =
      this.terrain.getCenterX(z) + (variant === 0 ? -GATE_CENTER_X : GATE_CENTER_X)
    const groundY = this.terrain.getHeightAt(centerX, z)
    const cos = Math.cos(yaw)
    const sin = Math.sin(yaw)

    const group = new THREE.Group()
    group.position.set(centerX, groundY, z)
    group.rotation.y = yaw

    for (const side of [-1, 1]) {
      const pole = new THREE.Mesh(poleGeometry, style.pole)
      pole.position.set(side * GATE_POLE_OFFSET, GATE_HEIGHT / 2, 0)
      pole.castShadow = true
      group.add(pole)
    }

    const banner = new THREE.Mesh(bannerGeometry, style.banner)
    banner.position.set(0, GATE_BANNER_Y, 0)
    banner.castShadow = false
    banner.receiveShadow = false
    group.add(banner)

    this.scene.add(group)

    // 两根旗杆的静态碰撞体
    const bodies = []
    const half = new CANNON.Vec3(0.18, GATE_HEIGHT / 2, 0.18)

    for (const side of [-1, 1]) {
      const localX = side * GATE_POLE_OFFSET
      // 把旗杆的局部坐标旋转到世界坐标
      const poleX = centerX + localX * cos
      const poleZ = z - localX * sin
      const poleGround = this.terrain.getHeightAt(poleX, poleZ)

      const body = new CANNON.Body({
        mass: 0,
        material: this.physics.materials.obstacle,
        shape: new CANNON.Box(half),
      })
      body.position.set(poleX, poleGround + GATE_HEIGHT / 2, poleZ)
      body.updateAABB()
      this.physics.addBody(body)
      bodies.push(body)
    }

    return {
      group,
      bodies,
      passed: false,
      // 穿门判定用的局部坐标轴
      cos,
      sin,
      color: style.pole.color.getHex(),
    }
  }

  /**
   * 每帧检测玩家是否穿过旗门。
   * 用「门平面有符号距离」从正变负来判断，弯道里同样准确。
   * @param {{ x: number, z: number }} player
   */
  update(player) {
    const prev = this._lastPlayer
    // 首帧 / 重开 / 传送后不判定，避免直接穿过整段赛道被误判为过门
    if (!prev || Math.abs(player.z - prev.z) > 10) {
      this._lastPlayer = { x: player.x, z: player.z }
      return
    }

    for (const entry of this.chunks.values()) {
      for (const gate of entry.gates) {
        if (gate.passed) continue

        const gx = gate.group.position.x
        const gz = gate.group.position.z
        const prevDist = (prev.x - gx) * gate.sin + (prev.z - gz) * gate.cos
        const currDist = (player.x - gx) * gate.sin + (player.z - gz) * gate.cos

        if (prevDist > 0 && currDist <= 0) {
          gate.passed = true
          // 沿门的横向轴计算偏移，判断是否从两杆之间穿过
          const lateral = Math.abs(
            (player.x - gx) * gate.cos - (player.z - gz) * gate.sin
          )
          if (lateral <= GATE_PASS_HALF) {
            if (this.onGatePassed) this.onGatePassed(gate)
          } else if (this.onGateMissed) {
            // 从两杆之外掠过：判定为失误，Combo 由 main.js 清零
            this.onGateMissed(gate)
          }
        }
      }
    }

    this._lastPlayer = { x: player.x, z: player.z }
  }

  /** 重开时清空穿门检测的上一帧位置 */
  reset() {
    this._lastPlayer = null
  }

  /**
   * 回收某个 Chunk 上的全部障碍物。
   * @param {number} index Chunk 下标
   */
  recycleChunk(index) {
    const entry = this.chunks.get(index)
    if (!entry) return

    this.chunks.delete(index)

    this.scene.remove(entry.trees)
    // 只释放实例矩阵缓冲；几何体与材质在各 Chunk 间共享
    entry.trees.dispose()

    for (const body of entry.walls) {
      this.physics.removeBody(body)
    }

    for (const gate of entry.gates) {
      this.scene.remove(gate.group)
      for (const body of gate.bodies) {
        this.physics.removeBody(body)
      }
    }
  }
}
