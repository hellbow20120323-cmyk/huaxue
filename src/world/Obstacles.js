import * as THREE from 'three'
import * as CANNON from 'cannon-es'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { mulberry32 } from '../utils/Random.js'

/**
 * ObstacleField（障碍物 + 对象池）
 * ------------------------------------------------------------------
 * 树木 / 岩石全部由基础几何体程序化拼出，不使用任何外部模型。
 *
 * 关键点：
 *   1. 对象池：所有视觉网格与物理刚体在启动时一次性创建，之后只做
 *      「显示 / 隐藏 + 加入 / 移出物理世界」，运行期不再 new 对象；
 *   2. 生命周期跟随地形 Chunk：Chunk 生成时布置障碍，Chunk 销毁时全部归还池；
 *   3. 摆放使用「Chunk 下标」做种子，因此同一段雪道每次生成的障碍完全一致；
 *   4. 每个树木由多个几何体合并成一个 Mesh，把 draw call 压到 1 次。
 */

// 对象池容量：按最坏情况（同时存在约 7 个 Chunk、每 Chunk 10~14 个障碍）预留
const TREE_POOL_SIZE = 64
const ROCK_POOL_SIZE = 44
// 障碍物横向分布范围（赛道半宽 80m，收窄一点避免贴边）
const SPAWN_RANGE_X = 48
// 同一 Chunk 内障碍物之间的最小间距，避免堆成一堵墙
const MIN_SPACING = 5
// 出生保护走廊：开局这段区域不放障碍，给玩家反应时间
const SAFE_Z = -40
const SAFE_X = 12

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

/** 低多边形岩石：一大一小两块多面体 */
function createRockGeometry() {
  const big = new THREE.IcosahedronGeometry(1.15, 0)
  big.scale(1.35, 0.85, 1.15)
  big.translate(0, 0.85, 0)
  paint(big, 0x8493a3)

  const small = new THREE.IcosahedronGeometry(0.6, 0)
  small.scale(1.2, 0.8, 1.05)
  small.translate(0.9, 0.42, 0.3)
  paint(small, 0x6f7d8c)

  return mergeGeometries([big, small], false)
}

// 几何体与材质在所有池对象间共享
const treeGeometry = createTreeGeometry()
const rockGeometry = createRockGeometry()
const treeMaterial = new THREE.MeshStandardMaterial({
  vertexColors: true,
  flatShading: true,
  roughness: 0.88,
  metalness: 0,
})
const rockMaterial = new THREE.MeshStandardMaterial({
  vertexColors: true,
  flatShading: true,
  roughness: 0.96,
  metalness: 0,
})

/**
 * 通用对象池：视觉网格常驻场景（默认隐藏），刚体按需加入物理世界。
 */
class ObstaclePool {
  constructor(scene, physics, { size, geometry, material, createBody }) {
    this.scene = scene
    this.physics = physics
    this.free = []
    this.size = size

    for (let i = 0; i < size; i++) {
      const mesh = new THREE.Mesh(geometry, material)
      mesh.visible = false
      mesh.castShadow = true
      mesh.receiveShadow = false
      scene.add(mesh)

      this.free.push({ mesh, body: createBody(), pool: this })
    }
  }

  /** 取一个空闲对象：显示网格并把刚体加入物理世界 */
  acquire() {
    const item = this.free.pop()
    if (!item) return null

    item.mesh.visible = true
    this.physics.addBody(item.body)
    return item
  }

  /** 归还对象：隐藏网格并移出物理世界，等待下次复用 */
  release(item) {
    item.mesh.visible = false
    this.physics.removeBody(item.body)
    this.free.push(item)
  }

  get available() {
    return this.free.length
  }
}

export class ObstacleField {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../core/PhysicsWorld.js').PhysicsWorld} physics
   * @param {import('./Terrain.js').Terrain} terrain
   */
  constructor(scene, physics, terrain) {
    this.terrain = terrain
    // chunkIndex -> 该 Chunk 当前占用的池对象数组
    this.chunks = new Map()

    this.treePool = new ObstaclePool(scene, physics, {
      size: TREE_POOL_SIZE,
      geometry: treeGeometry,
      material: treeMaterial,
      createBody: () => {
        const body = new CANNON.Body({ mass: 0, material: physics.materials.obstacle })
        // 树干 + 树冠整体用一个细长 Box 近似，成本远低于逐部件碰撞
        body.addShape(new CANNON.Box(new CANNON.Vec3(0.75, 2.6, 0.75)), new CANNON.Vec3(0, 2.6, 0))
        return body
      },
    })

    this.rockPool = new ObstaclePool(scene, physics, {
      size: ROCK_POOL_SIZE,
      geometry: rockGeometry,
      material: rockMaterial,
      createBody: () => {
        const body = new CANNON.Body({ mass: 0, material: physics.materials.obstacle })
        body.addShape(new CANNON.Sphere(1.05), new CANNON.Vec3(0, 0.75, 0))
        return body
      },
    })
  }

  /**
   * 在指定 Chunk 上随机布置障碍物。
   * @param {number} index Chunk 下标
   * @param {number} startZ 该 Chunk 靠近起点一侧的世界 Z
   */
  spawnChunk(index, startZ) {
    // 以 Chunk 下标为种子：同一段雪道每次生成的障碍完全一致
    const random = mulberry32((Math.imul(index, 2654435761) ^ 0x9e3779b9) >>> 0)

    const count = 10 + Math.floor(random() * 5) // 10 ~ 14 个
    const depth = this.terrain.chunkDepth
    const placed = []
    const items = []

    let attempts = 0
    while (items.length < count && attempts < 80) {
      attempts++

      // 横向分布：35% 的障碍集中在中央 30m，保证玩家一路上真的需要左右闪避；
      // 其余撒在整条雪道上，形成远景层次
      const x = random() < 0.35 ? (random() * 2 - 1) * 15 : (random() * 2 - 1) * SPAWN_RANGE_X
      const z = startZ - random() * depth

      // 出生保护走廊：开局不要直接撞树
      if (z > SAFE_Z && Math.abs(x) < SAFE_X) continue

      // 间距检查，避免多个障碍重叠
      let tooClose = false
      for (const point of placed) {
        const dx = point.x - x
        const dz = point.z - z
        if (dx * dx + dz * dz < MIN_SPACING * MIN_SPACING) {
          tooClose = true
          break
        }
      }
      if (tooClose) continue

      // 跨 Chunk 检查：相邻 Chunk 已布置的障碍也要保持间距，
      // 否则边界两侧会出现几乎重叠的树 / 石头
      if (this.tooCloseToNeighbor(index, x, z)) continue

      const isTree = random() < 0.62
      const pool = isTree ? this.treePool : this.rockPool
      const item = pool.acquire()
      if (!item) continue // 池已耗尽：本 Chunk 少放几个，不影响其余逻辑

      const groundY = this.terrain.getHeightAt(x, z)
      const yaw = random() * Math.PI * 2
      const scale = isTree ? 0.85 + random() * 0.4 : 0.75 + random() * 0.5

      item.mesh.position.set(x, groundY, z)
      item.mesh.rotation.y = yaw
      item.mesh.scale.setScalar(scale)

      // 刚体与视觉保持同一位置 / 朝向；静态刚体移动后必须手动刷新 AABB
      item.body.position.set(x, groundY, z)
      item.body.quaternion.setFromEuler(0, yaw, 0)
      item.body.aabbNeedsUpdate = true
      item.body.updateAABB()

      placed.push({ x, z })
      items.push(item)
    }

    this.chunks.set(index, items)
  }

  /**
   * 检查候选点是否与相邻 Chunk 已放置的障碍物过近。
   * Chunk 按序生成，后生成的 Chunk 会检查先生成的邻居，
   * 因此边界处不会出现两侧都漏判的重叠。
   */
  tooCloseToNeighbor(index, x, z) {
    const minSq = MIN_SPACING * MIN_SPACING

    for (const neighbor of [index - 1, index + 1]) {
      const items = this.chunks.get(neighbor)
      if (!items) continue

      for (const item of items) {
        const dx = item.mesh.position.x - x
        const dz = item.mesh.position.z - z
        if (dx * dx + dz * dz < minSq) return true
      }
    }
    return false
  }

  /**
   * 回收某个 Chunk 上的全部障碍物。
   * @param {number} index Chunk 下标
   */
  recycleChunk(index) {
    const items = this.chunks.get(index)
    if (!items) return

    for (const item of items) {
      item.pool.release(item)
    }
    this.chunks.delete(index)
  }

  /** 当前已激活的障碍物数量（调试用） */
  get activeCount() {
    let total = 0
    for (const items of this.chunks.values()) total += items.length
    return total
  }
}
