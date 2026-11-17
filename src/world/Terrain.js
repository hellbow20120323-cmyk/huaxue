import * as THREE from 'three'
import * as CANNON from 'cannon-es'
import { createNoise2D } from '../utils/PerlinNoise.js'

/**
 * Terrain（程序化无尽下坡地形）
 * ------------------------------------------------------------------
 * 视觉与物理严格共用同一套高度数据：
 *   - 视觉：每个 Chunk 用非索引 BufferGeometry 拼出低多边形雪面，按三角形着色
 *   - 物理：每个 Chunk 生成一个静态 CANNON.Heightfield，与视觉网格逐点对齐
 *
 * 坐标约定：玩家朝 -Z 下滑，雪道沿 -Z 方向持续下降。
 * Chunk 以「下滑距离」划分：下标 k 的 Chunk 覆盖 z ∈ [-k*D, -(k+1)*D]。
 *
 * 无尽逻辑：玩家每前进一个 Chunk，就在前方补生成，并销毁身后过远的 Chunk。
 * 由于高度完全由世界坐标的噪声函数决定，相邻 Chunk 的接缝天然连续。
 */

// ---- 地形参数（全部为米）----
// 雪道加宽到 240m：镜头两侧的地形边界被推得更远，配合雾效不会看到明显的地平线切边
const CHUNK_WIDTH = 240
const CHUNK_DEPTH = 64 // 单个 Chunk 沿下滑方向的长度
const CELL_SIZE = 8 // 网格边长：8m 的大格子形成低多边形块面感
const SEG_X = CHUNK_WIDTH / CELL_SIZE // 30 段
const SEG_Z = CHUNK_DEPTH / CELL_SIZE // 8 段
const HALF_WIDTH = CHUNK_WIDTH / 2

// 基础坡度：0.19 ≈ 10.8°，比早期版本更陡，配合前向推力能更快进入高速
const GRADE = 0.19

// U 型雪道：底部加宽到 ±22m，玩家有更充裕的走线空间
export const TRACK_HALF = 22
// 树墙内缘距赛道中线的横向距离（谷壁开始抬升后的位置）
export const TRACK_WALL = TRACK_HALF + 5
// 谷壁抛物线的二次项系数：比之前的 0.075 更缓，山壁过渡更自然
const WALL_CURVE = 0.042
// 谷壁最大高度，避免远端网格被抬到不合理的高度
const WALL_MAX_RISE = 48

// S 型弯道：中线随下滑距离左右摆动
// 振幅 18m、波长约 300m，最大横移斜率约 0.38（约 21°），需要持续切弯
const CURVE_AMPLITUDE = 18
const CURVE_FREQUENCY = (Math.PI * 2) / 300

// 面条雪条纹的世界间距（米）：每隔约 1.1m 一条压雪机纹路
const CORDUROY_SPACING = 1.1

// 地形种子：固定后每次运行生成完全相同的雪道，便于调试
const TERRAIN_SEED = 20261117

// 前方预生成 3 个 Chunk（192m），覆盖雾的远端；身后保留 1 个避免镜头穿帮
const CHUNKS_AHEAD = 3
const CHUNKS_BEHIND = 1

export class Terrain {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../core/PhysicsWorld.js').PhysicsWorld} physics
   */
  constructor(scene, physics) {
    this.scene = scene
    this.physics = physics

    this.noise = createNoise2D(TERRAIN_SEED)
    // 索引：chunkIndex -> { mesh, body }
    this.chunks = new Map()

    // 供障碍物系统读取的尺寸参数，避免两边各自硬编码
    this.chunkWidth = CHUNK_WIDTH
    this.chunkDepth = CHUNK_DEPTH

    // Chunk 生命周期回调：由障碍物系统注册，实现树墙 / 旗门随地形同步生成与回收
    this.onChunkCreated = null
    this.onChunkDestroyed = null

    // 让出生点 (0, 0) 的高度恰好为 0，方便玩家在固定高度出生
    this.originOffset = this.rawHeight(0, 0)

    // 所有 Chunk 共用一份材质，避免重复创建与显存浪费。
    // 面条雪效果：用程序化条纹同时作为 roughnessMap 与 bumpMap，
    // 沟槽处更光滑、有轻微凹凸，逆光时能看到细密的压雪纹路
    this.corduroyTexture = this.createCorduroyTexture()
    this.material = new THREE.MeshStandardMaterial({
      color: 0xffffff, // 雪地基础色保持纯白，颜色交给光照塑造
      vertexColors: true, // 每个三角面有轻微明暗 / 冷色差异，白色雪面才有层次
      roughness: 0.94,
      metalness: 0,
      flatShading: true,
      roughnessMap: this.corduroyTexture,
      bumpMap: this.corduroyTexture,
      bumpScale: 0.012,
    })
  }

  /**
   * 生成「面条雪」条纹贴图。
   * 宽度方向画一条暗带，配合 RepeatWrapping 沿 X 轴平铺，
   * 世界坐标下每 1.1m 就压出一道雪槽。
   */
  createCorduroyTexture() {
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 8

    const context = canvas.getContext('2d')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, 64, 8)
    // 主沟槽 + 柔和的过渡带，避免条纹边缘过于生硬
    context.fillStyle = '#8f9dab'
    context.fillRect(0, 0, 4, 8)
    context.fillStyle = '#c3ccd6'
    context.fillRect(4, 0, 2, 8)

    const texture = new THREE.CanvasTexture(canvas)
    texture.wrapS = THREE.RepeatWrapping
    texture.wrapT = THREE.RepeatWrapping
    // 掠射角下条纹容易闪烁，开一点各向异性过滤
    texture.anisotropy = 4
    return texture
  }

  /**
   * 未归一化的高度函数（视觉与物理都调用它，保证逐点一致）
   * @param {number} x 世界 X
   * @param {number} z 世界 Z
   */
  /**
   * 赛道中线的世界 X 坐标。
   * 用下滑距离驱动正弦，形成连续的 S 型弯；起点（z=0）处正好为 0。
   * 地形、树墙、旗门与面条雪纹理都基于它对齐。
   * @param {number} z 世界 Z
   */
  getCenterX(z) {
    return Math.sin(-z * CURVE_FREQUENCY) * CURVE_AMPLITUDE
  }

  rawHeight(x, z) {
    // d = 距离起点的下滑距离，随着前进不断增大
    const d = -z
    // 当前纵深处的赛道中线；谷壁与路面都相对于它计算
    const lateral = x - this.getCenterX(z)
    const absLateral = Math.abs(lateral)

    // 1. 基础坡面：z 越负（越靠前），高度越低，形成向 -Z 的下坡
    let height = -d * GRADE

    // 2. U 型谷壁：中线两侧 ±TRACK_HALF 内保持平缓，之外按抛物线向上翘起
    const wall = Math.max(0, absLateral - TRACK_HALF)
    height += Math.min(wall * wall * WALL_CURVE, WALL_MAX_RISE)

    // 3. 山体起伏只叠加在谷壁上，离赛道越远越强
    const wallBlend = Math.min(1, wall / 20)
    height += this.noise.fbm(x * 0.03, d * 0.03, 3) * 8 * wallBlend

    // 4. 赛道路面只保留非常轻微的起伏（压雪机压过的顺滑感）
    height += this.noise.fbm(x * 0.12 + 7.3, d * 0.1 + 2.7, 2) * 0.45

    return height
  }

  /** 归一化后的世界高度（出生点高度为 0） */
  getHeightAt(x, z) {
    return this.rawHeight(x, z) - this.originOffset
  }

  /**
   * 采样某处的坡度（绕 X 轴的俯仰角），用于让雪板贴合雪面。
   * 使用 ±2m 的中央差分，避免单点噪声抖动。
   * @returns {number} 弧度；向 -Z 下坡时为负值
   */
  getPitchAt(x, z) {
    const sample = 2
    const front = this.getHeightAt(x, z - sample)
    const back = this.getHeightAt(x, z + sample)
    return Math.atan2(front - back, sample * 2)
  }

  /**
   * 根据玩家当前位置维护 Chunk 集合：前方补齐、后方销毁。
   * 每帧调用一次即可，内部只做一次 Map 查找，开销可忽略。
   * @param {number} playerZ 玩家世界 Z
   */
  update(playerZ) {
    // 当前所在 Chunk 下标（z 为负，因此取 -z）
    const current = Math.floor(-playerZ / CHUNK_DEPTH)
    const first = current - CHUNKS_BEHIND
    const last = current + CHUNKS_AHEAD

    // 前方（含出生点后方一个）补齐
    for (let index = first; index <= last; index++) {
      if (!this.chunks.has(index)) {
        this.createChunk(index)
      }
    }

    // 销毁窗口之外的 Chunk：
    // - 身后过远的立即释放；
    // - 身前面板之外的（例如重开后被传送回起点时）也一并释放，避免留下孤立 Chunk
    for (const index of this.chunks.keys()) {
      if (index < first - 1 || index > last + 1) {
        this.destroyChunk(index)
      }
    }
  }

  /**
   * 创建一个 Chunk：先拼视觉网格，再生成对齐的 Heightfield 刚体。
   * @param {number} index Chunk 下标
   */
  createChunk(index) {
    // 该 Chunk 靠近起点一侧的世界 Z（向 -Z 延伸 CHUNK_DEPTH）
    const startZ = -index * CHUNK_DEPTH

    const mesh = this.createChunkMesh(startZ)
    const body = this.createChunkBody(startZ)

    this.scene.add(mesh)
    this.physics.addBody(body)
    this.chunks.set(index, { mesh, body })

    // 通知外部（障碍物池）在该 Chunk 上布置障碍
    if (this.onChunkCreated) this.onChunkCreated(index, startZ)
  }

  /**
   * 生成低多边形雪面网格。
   * 使用「非索引」顶点：每个三角形独立 3 个顶点，天然得到平直的法线与面片色。
   */
  createChunkMesh(startZ) {
    const positions = []
    // 面条雪需要 UV：U 用世界 X 坐标，保证条纹跨 Chunk 连续；
    // V 只沿坡度方向平铺即可（纹理本身是纵向均匀的条纹）
    const uvs = []

    for (let j = 0; j < SEG_Z; j++) {
      // 局部 Z：0 → -CHUNK_DEPTH（Three.js 中网格会整体平移到 startZ）
      const zNear = -j * CELL_SIZE
      const zFar = -(j + 1) * CELL_SIZE

      for (let i = 0; i < SEG_X; i++) {
        const xLeft = -HALF_WIDTH + i * CELL_SIZE
        const xRight = xLeft + CELL_SIZE

        // 采样四个角的高度；世界 Z = startZ + 局部 Z
        const yLeftNear = this.getHeightAt(xLeft, startZ + zNear)
        const yRightNear = this.getHeightAt(xRight, startZ + zNear)
        const yLeftFar = this.getHeightAt(xLeft, startZ + zFar)
        const yRightFar = this.getHeightAt(xRight, startZ + zFar)

        // 两个三角形共用同一条对角线，与 Cannon Heightfield 的切分方式一致
        positions.push(
          xLeft, yLeftNear, zNear,
          xRight, yRightNear, zNear,
          xLeft, yLeftFar, zFar,

          xRight, yRightNear, zNear,
          xRight, yRightFar, zFar,
          xLeft, yLeftFar, zFar
        )

        // 条纹沿赛道中线对齐：U 轴用「相对中线的横向距离」，
        // 这样弯道里的面条雪纹路会跟着雪道一起弯，而不是始终沿世界 X 轴
        const uLeft = (xLeft - this.getCenterX(startZ + zNear)) / CORDUROY_SPACING
        const uRight = (xRight - this.getCenterX(startZ + zNear)) / CORDUROY_SPACING
        const vNear = (startZ + zNear) / 8
        const vFar = (startZ + zFar) / 8
        uvs.push(
          uLeft, vNear,
          uRight, vNear,
          uLeft, vFar,

          uRight, vNear,
          uRight, vFar,
          uLeft, vFar
        )
      }
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
    // 非索引几何体调用 computeVertexNormals 会得到逐三角形的平面法线
    geometry.computeVertexNormals()

    // ---- 按三角面写入顶点色：制造低多边形的块面层次 ----
    const normals = geometry.attributes.normal.array
    const colors = new Float32Array(positions.length)

    for (let v = 0; v < positions.length; v += 9) {
      // 三个顶点的平均法线 Y 分量：越接近 1 越平缓、越亮
      const normalY = (normals[v + 1] + normals[v + 4] + normals[v + 7]) / 3
      // 用三角面位置做伪随机，保证每次生成的颜色一致
      const seed = Math.sin(positions[v] * 12.9898 + positions[v + 2] * 78.233) * 43758.5453
      const tint = seed - Math.floor(seed)

      // 保持接近纯白的底色，只留少量明暗差，避免雪面被染成土色
      const brightness = 0.86 + 0.11 * Math.max(0, normalY) + 0.03 * tint
      for (let k = 0; k < 9; k += 3) {
        // 略微偏蓝，阴影面更像雪地反射的天空光
        colors[v + k] = brightness * 0.92
        colors[v + k + 1] = brightness * 0.96
        colors[v + k + 2] = brightness
      }
    }

    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geometry.computeBoundingSphere()

    const mesh = new THREE.Mesh(geometry, this.material)
    mesh.position.z = startZ
    mesh.receiveShadow = true // 接收玩家 / 障碍物投影
    mesh.castShadow = false // 地形自身不投影，节省移动端阴影开销
    return mesh
  }

  /**
   * 生成与视觉网格逐点对齐的静态 Heightfield 刚体。
   * Cannon 的 Heightfield 位于局部 XY 平面、高度沿局部 Z，
   * 因此需要绕 X 轴旋转 -90°，把高度轴翻到世界 Y。
   */
  createChunkBody(startZ) {
    const data = []

    for (let i = 0; i <= SEG_X; i++) {
      const column = []
      const worldX = -HALF_WIDTH + i * CELL_SIZE
      for (let j = 0; j <= SEG_Z; j++) {
        // 局部 Y 增加 → 世界 Z 减小，与视觉网格的方向一致
        column.push(this.getHeightAt(worldX, startZ - j * CELL_SIZE))
      }
      data.push(column)
    }

    const shape = new CANNON.Heightfield(data, { elementSize: CELL_SIZE })
    const body = new CANNON.Body({
      mass: 0, // 静态地形
      material: this.physics.materials.ground,
      shape,
    })

    body.position.set(-HALF_WIDTH, 0, startZ)
    body.quaternion.setFromEuler(-Math.PI / 2, 0, 0)
    return body
  }

  /** 销毁 Chunk：移出场景、释放几何体、移除刚体 */
  destroyChunk(index) {
    const chunk = this.chunks.get(index)
    if (!chunk) return

    this.scene.remove(chunk.mesh)
    chunk.mesh.geometry.dispose()
    this.physics.removeBody(chunk.body)
    this.chunks.delete(index)

    // 通知外部回收该 Chunk 上的障碍物
    if (this.onChunkDestroyed) this.onChunkDestroyed(index)
  }

  /** 当前存活的 Chunk 数量（HUD / 调试用） */
  get chunkCount() {
    return this.chunks.size
  }
}
