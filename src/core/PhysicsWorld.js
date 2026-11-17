import * as CANNON from 'cannon-es'

/**
 * PhysicsWorld
 * ------------------------------------------------------------------
 * 对 Cannon-es 的物理世界做一层薄封装：
 * 1. 统一重力、求解器精度、宽相（broadphase）策略；
 * 2. 预置「雪面 / 玩家 / 障碍物」三种物理材质及它们之间的摩擦组合；
 * 3. 提供固定步长（fixed time step）推进，保证不同帧率下手感一致。
 *
 * 注意：物理世界里的单位约定为「米 / 秒」，与 Three.js 场景 1:1 对应。
 */
export class PhysicsWorld {
  constructor() {
    // 重力略大于现实值（9.8），用来强化「速降下坠」的爽快感
    this.world = new CANNON.World({
      gravity: new CANNON.Vec3(0, -32, 0),
    })

    // 无尽地形会在前方不断新增 Chunk，SAPBroadphase 对「大量静态物体」更友好
    this.world.broadphase = new CANNON.SAPBroadphase(this.world)

    // 静止后自动休眠，减少地形上大量树木 / 岩石的无效计算
    this.world.allowSleep = true

    // 迭代次数越高越稳定，10 次是移动端性能与堆叠稳定性的平衡点
    this.world.solver.iterations = 10
    this.world.solver.tolerance = 0.001

    this.materials = this.createMaterials()
    this.createContactMaterials()

    // 固定物理步长：60Hz。主循环会用累积时间的方式推进，避免掉帧时物理「变慢」
    this.fixedTimeStep = 1 / 60
    // 单帧最多补算 3 步，防止切后台回来时一次性卡死
    this.maxSubSteps = 3
  }

  /** 三种物理材质，后续所有刚体都从这里取，避免各处魔法字符串 */
  createMaterials() {
    return {
      // 雪面：极低摩擦，让玩家和障碍物都能顺滑滑行
      ground: new CANNON.Material('ground'),
      player: new CANNON.Material('player'),
      obstacle: new CANNON.Material('obstacle'),
    }
  }

  /** 材质两两组合时的接触参数（摩擦、弹性） */
  createContactMaterials() {
    const { ground, player, obstacle } = this.materials

    // 雪面 × 玩家：极低摩擦，玩家会「滑」而不是「粘」。
    // 注意 Cannon 的摩擦力上限没有乘以时间步，0.015 在 60Hz 下的等效摩擦会接近 0.9，
    // 表现为人物被雪面粘住，因此这里取 0.001 才能得到真正的冰面手感。
    this.world.addContactMaterial(
      new CANNON.ContactMaterial(ground, player, {
        friction: 0.001,
        restitution: 0.02,
        contactEquationStiffness: 1e8,
      })
    )

    // 雪面 × 障碍物：树木岩石需要稳稳立住，摩擦给大一些
    this.world.addContactMaterial(
      new CANNON.ContactMaterial(ground, obstacle, {
        friction: 0.4,
        restitution: 0.05,
      })
    )

    // 玩家 × 障碍物：碰撞时有一点弹性与阻力，反馈更「有肉感」
    this.world.addContactMaterial(
      new CANNON.ContactMaterial(player, obstacle, {
        friction: 0.1,
        restitution: 0.25,
      })
    )

    // 兜底参数：用于将来临时添加、未显式配对的刚体
    this.world.defaultContactMaterial.friction = 0.05
    this.world.defaultContactMaterial.restitution = 0.05
  }

  /**
   * 推进物理世界。
   * 使用 Cannon 内置的累积器重载：step(fixedTimeStep, deltaTime, maxSubSteps)
   * 即使渲染帧率波动，物理表现也保持稳定。
   * @param {number} delta 上一帧到这一帧的秒数
   */
  step(delta) {
    this.world.step(this.fixedTimeStep, delta, this.maxSubSteps)
  }

  addBody(body) {
    this.world.addBody(body)
    return body
  }

  removeBody(body) {
    this.world.removeBody(body)
    return body
  }

  /** HUD 调试用：当前世界中的刚体数量 */
  get bodyCount() {
    return this.world.bodies.length
  }
}
