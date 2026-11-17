import './style.css'
import * as THREE from 'three'
import { SceneManager } from './core/SceneManager.js'
import { PhysicsWorld } from './core/PhysicsWorld.js'
import { CameraRig } from './core/CameraRig.js'
import { InputController } from './core/InputController.js'
import { AudioManager } from './core/AudioManager.js'
import { Player } from './entities/Player.js'
import { Terrain } from './world/Terrain.js'
import { ObstacleField } from './world/Obstacles.js'
import { SnowTrail } from './effects/SnowTrail.js'
import { GateBurst } from './effects/GateBurst.js'
import { FloatingText } from './effects/FloatingText.js'

/**
 * 雪境速降 · MVP 主入口
 * ------------------------------------------------------------------
 * 坐标约定（后续所有模块统一遵守）：
 *   - 玩家始终朝 -Z 方向速降（与 Three.js 相机默认朝向一致）
 *   - Y 轴向上，重力为 -Y
 *   - X 轴用于左右转向
 *
 * 当前进度：STEP 01（场景） + STEP 02（物理世界） + STEP 03（玩家与相机）
 *          + STEP 04（程序化无尽地形） + STEP 05（转向控制与障碍物对象池）
 *          + 撞击结算与重开（MVP 完整循环）
 */

function init() {
  const container = document.getElementById('app')

  // ========== STEP 01：场景 ==========
  const sceneManager = new SceneManager(container)
  const { scene, camera } = sceneManager

  // ========== STEP 02：物理世界 ==========
  const physics = new PhysicsWorld()

  // ========== STEP 04：程序化无尽地形 ==========
  const terrain = new Terrain(scene, physics)

  // ========== STEP 05：商业雪道障碍（树墙 + 旗门） ==========
  // 障碍物完全跟随地形 Chunk 的生命周期：Chunk 生成时布置，销毁时归还池
  const obstacles = new ObstacleField(scene, physics, terrain)
  terrain.onChunkCreated = (index, startZ) => obstacles.spawnChunk(index, startZ)
  terrain.onChunkDestroyed = (index) => obstacles.recycleChunk(index)

  // 先铺好出生点周围的地形与障碍，避免玩家第一帧踩空
  terrain.update(0)

  // ========== STEP 03：玩家与越肩相机 ==========
  // 出生点位于雪面正上方，留出 1.4m 的落地距离
  const player = new Player(scene, physics, {
    spawn: { x: 0, y: terrain.getHeightAt(0, 0) + 1.4, z: 0 },
  })
  const cameraRig = new CameraRig(camera)
  // 开局直接对齐理想机位，避免相机从初始位置飞向玩家
  cameraRig.snap(player.visual.position, player.getHeadWorldPosition(new THREE.Vector3()))

  // 相机防穿地用的地形采样回调：缓存一份，避免每帧新建闭包
  const groundHeightAt = (x, z) => terrain.getHeightAt(x, z)

  // 雪板扬雪尾迹：预分配粒子，运行期只更新缓冲
  const snowTrail = new SnowTrail(scene)
  // 过门爆发粒子
  const gateBurst = new GateBurst(scene)
  // 头顶浮动文字（DOM 投影层）
  const floatingText = new FloatingText(document.getElementById('floaters'))

  // 复用的向量，避免主循环每帧分配
  const cameraHead = new THREE.Vector3()
  const headTop = new THREE.Vector3()

  // ---- 连击 / Fever ----
  // 连续穿过 5 扇旗门进入 Fever；错过任意一扇或撞击都会清零
  const FEVER_COMBO = 5
  let combo = 0
  let fever = false
  // 0..1 的平滑强度：用于 FOV、彩虹尾迹等视觉过渡
  let feverFactor = 0
  let score = 0

  // ---- 穿门奖励：粒子爆发 + 短暂加速 + FOV 冲击 + Combo ----
  obstacles.onGatePassed = (gate) => {
    const gatePos = gate.group.position
    gateBurst.burst(gatePos.x, gatePos.y + 1.6, gatePos.z, gate.color, 56)
    player.applyBoost()
    cameraRig.addFovPunch(7)

    combo += 1
    // 连击越高，单门得分越高（最多 10 倍），鼓励连续精准穿门
    score += 100 * Math.min(combo, 10)
    if (scoreEl) scoreEl.textContent = String(score)

    if (combo >= FEVER_COMBO) setFever(true)
    updateComboHud()
  }

  // ---- 错过旗门：Combo 清零，Fever 立即结束 ----
  obstacles.onGateMissed = () => {
    if (combo > 1) {
      player.getHeadWorldPosition(headTop)
      headTop.y += 1.2
      floatingText.show('COMBO LOST', headTop, { color: '#ffd2d2', size: 16, life: 0.9 })
    }
    combo = 0
    setFever(false)
    updateComboHud()
  }

  // 输入统一层：桌面键盘 + 移动端左右半屏触控
  const input = new InputController()

  // 程序化音效：风声 / 撞击 / 按钮音，首次用户手势后自动解锁
  const audio = new AudioManager()

  // 阳光阴影跟随玩家，保证滑到远处依然有清晰投影
  sceneManager.followSun(player.visual.position)

  // ========== 渲染循环 ==========
  // Three.js r187 起 Clock 已废弃，使用 Timer 获取帧间隔
  const timer = new THREE.Timer()
  let rafId = 0
  let firstFrame = true

  // FPS 统计（每 0.5s 刷新一次，避免频繁操作 DOM）
  let frames = 0
  let elapsed = 0
  const fpsEl = document.getElementById('fps')
  const speedEl = document.getElementById('speed')
  const distanceEl = document.getElementById('distance')
  const bestEl = document.getElementById('best')
  const scoreEl = document.getElementById('score')
  const comboEl = document.getElementById('combo')
  const comboValueEl = document.getElementById('combo-value')
  const viewButton = document.getElementById('view')

  // ========== 撞击结算与重开 ==========
  const gameoverEl = document.getElementById('gameover')
  const resultLabelEl = document.getElementById('result-label')
  const finalDistanceEl = document.getElementById('final-distance')
  const finalSpeedEl = document.getElementById('final-speed')
  const finalBestEl = document.getElementById('final-best')
  const finalScoreEl = document.getElementById('final-score')
  const restartButton = document.getElementById('restart')

  // 最佳距离持久化：隐私模式下读写失败时退化为内存记录
  const BEST_KEY = 'snowrush:best'
  let bestDistance = 0
  try {
    bestDistance = Math.max(0, Math.round(Number(localStorage.getItem(BEST_KEY)) || 0))
  } catch {
    bestDistance = 0
  }
  if (bestEl) bestEl.textContent = String(bestDistance)

  // ========== 音效开关 ==========
  const muteButton = document.getElementById('mute')

  function syncMuteButton() {
    if (!muteButton) return
    muteButton.textContent = audio.muted ? '音效 关' : '音效 开'
    muteButton.setAttribute('aria-pressed', String(audio.muted))
  }

  syncMuteButton()

  function handleMuteClick() {
    audio.unlock() // 这次点击本身也是合法手势
    const muted = audio.toggleMute()
    // 只在「打开音效」时给出确认音，关闭时保持安静
    if (!muted) audio.click()
    syncMuteButton()
  }

  muteButton?.addEventListener('click', handleMuteClick)

  // ---- 连击 HUD：Combo 数 + Fever 高亮 ----
  function updateComboHud() {
    if (comboEl) {
      comboEl.hidden = combo < 1
      comboEl.classList.toggle('is-fever', fever)
    }
    if (comboValueEl) comboValueEl.textContent = String(combo)
  }

  /** 进入 / 退出 Fever：同步玩家限速、HUD 与一次性爆发反馈 */
  function setFever(active) {
    if (fever === active) return

    fever = active
    player.setFever(active)
    updateComboHud()

    if (active) {
      // 进入 Fever 的瞬间给一个额外加速与 FOV 冲击，明确告诉玩家「状态变了」
      player.applyBoost(1.2)
      cameraRig.addFovPunch(12)
      player.getHeadWorldPosition(headTop)
      headTop.y += 1.4
      floatingText.show('FEVER MODE!', headTop, {
        color: '#ffe066',
        size: 26,
        life: 1.5,
      })
    }
  }

  // ---- 视角切换：V 键 / 右上角按钮 ----
  function toggleView() {
    const mode = cameraRig.toggleView()
    player.setFirstPerson(mode === 'first')
    if (viewButton) {
      viewButton.textContent = mode === 'first' ? '第一人称' : '第三人称'
      viewButton.setAttribute('aria-pressed', String(mode === 'first'))
    }
    audio.click()
  }

  function handleViewKey(event) {
    if (event.code === 'KeyV') {
      event.preventDefault()
      toggleView()
    }
  }

  viewButton?.addEventListener('click', toggleView)
  window.addEventListener('keydown', handleViewKey)

  // 当前是否处于滑行中；撞击后置为 false，物理世界随之冻结
  let running = true
  // 本局最高速度（km/h）
  let maxSpeedKmh = 0
  // 滞空计时与首次落地标记：出生时的下坠不算腾空奖励
  let airTime = 0
  let hasLanded = false

  /** 撞到障碍：冻结物理、震屏、播放撞击音、更新最佳距离并展示结算面板 */
  function crash(impact = 6) {
    if (!running) return

    running = false
    input.reset() // 清空按键，避免重开瞬间仍带着转向输入
    player.setSteer(0) // 身体姿态回正

    // 连击中断：Fever 立即结束，滞空计时作废
    combo = 0
    setFever(false)
    updateComboHud()
    airTime = 0

    // 动效反馈：撞得越狠震得越明显
    cameraRig.addShake(Math.min(1, 0.45 + impact / 14))
    audio.crash(impact)

    const distance = Math.max(0, Math.round(-player.body.position.z))
    const isRecord = distance > bestDistance
    if (isRecord) {
      bestDistance = distance
      try {
        localStorage.setItem(BEST_KEY, String(bestDistance))
      } catch {
        // 忽略隐私模式下的写入失败
      }
    }

    if (finalDistanceEl) finalDistanceEl.textContent = `${distance} m`
    if (finalSpeedEl) finalSpeedEl.textContent = `${Math.round(maxSpeedKmh)} km/h`
    if (finalBestEl) finalBestEl.textContent = `${bestDistance} m`
    if (finalScoreEl) finalScoreEl.textContent = String(score)
    if (bestEl) bestEl.textContent = String(bestDistance)
    if (resultLabelEl) {
      resultLabelEl.textContent = isRecord ? 'NEW RECORD' : 'RUN OVER'
      resultLabelEl.classList.toggle('is-record', isRecord)
    }
    if (gameoverEl) gameoverEl.hidden = false
  }

  /** 重开一局：玩家回起点，地形窗口重新围绕起点生成 */
  function restart() {
    if (running) return

    audio.unlock()
    audio.click()
    // 清空按键与起跳请求：用 Space 重开时不会顺带触发一次起跳
    input.reset()

    if (gameoverEl) gameoverEl.hidden = true
    if (resultLabelEl) resultLabelEl.classList.remove('is-record')
    maxSpeedKmh = 0

    // 重置连击 / Fever / 滞空 / 得分
    combo = 0
    fever = false
    feverFactor = 0
    score = 0
    airTime = 0
    hasLanded = false
    player.setFever(false)
    updateComboHud()
    floatingText.clear()

    if (speedEl) speedEl.textContent = '0'
    if (distanceEl) distanceEl.textContent = '0'
    if (scoreEl) scoreEl.textContent = '0'

    player.reset({ x: 0, y: terrain.getHeightAt(0, 0) + 1.4, z: 0 })
    // 传回起点后清理远处孤立 Chunk，并补齐起点周围地形 / 障碍
    terrain.update(0)
    // 穿门检测的上一帧位置也要清空，避免重开瞬间误判
    obstacles.reset()

    cameraRig.snap(player.visual.position, player.getHeadWorldPosition(cameraHead))
    sceneManager.followSun(player.visual.position)
    running = true
  }

  // 物理碰撞回调 → 结算
  player.onCrash = crash
  restartButton?.addEventListener('click', restart)

  // 键盘快捷重开（Space / Enter）
  function handleRestartKey(event) {
    if (!running && (event.code === 'Space' || event.code === 'Enter')) {
      event.preventDefault()
      restart()
    }
  }
  window.addEventListener('keydown', handleRestartKey)

  function tick() {
    rafId = requestAnimationFrame(tick)

    // 限制单帧最大 delta：切换后台 / 卡顿回来时不会让物理世界「瞬移」
    timer.update()
    const delta = Math.min(timer.getDelta(), 0.05)

    // 读取转向意图（-1 左 / 0 不动 / +1 右）
    const steer = input.axis

    if (running) {
      // ---- 主动起跳：Space / 移动端快速点按 ----
      // 只有贴地时有效；起跳冲量在本次物理积分中生效
      if (input.consumeJump() && player.jump()) {
        cameraRig.addShake(0.12)
      }

      // 物理推进前施加前向推力与转向力
      player.preStep(delta, steer)
      player.setSteer(steer)
      // 用固定步长推进物理，保证 60Hz 与 120Hz 屏幕手感一致
      physics.step(delta)

      // 按玩家位置维护无尽地形的增删；随后让雪板贴合当前坡度
      terrain.update(player.body.position.z)
      player.setPitch(terrain.getPitchAt(player.body.position.x, player.body.position.z))

      maxSpeedKmh = Math.max(maxSpeedKmh, player.speedKmh)
    }

    // ---- 贴地判定 / 滞空计分 ----
    // 用「球心到雪面的高度差」判断是否贴地：0.9m 约为球半径 + 容差
    const bodyPosition = player.body.position
    const groundGap = bodyPosition.y - terrain.getHeightAt(bodyPosition.x, bodyPosition.z)
    const grounded = groundGap < 0.9
    player.grounded = grounded

    if (running) {
      if (!grounded) {
        // 出生时的第一次下坠不算腾空，必须先完成一次落地
        if (hasLanded) airTime += delta
      } else {
        if (hasLanded && airTime > 0.34) {
          // 基础 500 分，滞留越久奖励越高
          const points = 500 + Math.round((airTime - 0.34) * 800)
          score += points
          if (scoreEl) scoreEl.textContent = String(score)

          player.getHeadWorldPosition(headTop)
          headTop.y += 1.25
          floatingText.show(`+${points} 完美腾空！`, headTop, {
            color: '#fff1a8',
            size: 22,
          })
          cameraRig.addShake(0.18)
        }
        airTime = 0
        hasLanded = true
      }
    }

    // Fever 视觉强度做平滑过渡，避免状态切换时画面突变
    feverFactor +=
      ((fever ? 1 : 0) - feverFactor) * (1 - Math.exp(-3 * delta))

    // 风噪随速度变化。撞击后物理已冻结、刚体速度仍停在撞击瞬间，
    // 因此结算期间显式传 0，让风声自然淡出而不是一直呼啸
    audio.setSpeed(running ? player.speedKmh : 0)

    // 冻结时也同步视觉姿态（只做平滑，不改变物理位置）
    player.sync(delta)

    // ---- 扬雪尾迹 ----
    // 腾空时停止发射；Fever 状态下切换为彩虹色并提高密度
    snowTrail.update(delta, {
      x: bodyPosition.x,
      y: bodyPosition.y,
      z: bodyPosition.z,
      yaw: player.yaw,
      speedKmh: player.speedKmh,
      grounded,
      running,
      fever: feverFactor,
    })

    // 旗门穿越检测与过门粒子推进
    obstacles.update(bodyPosition)
    gateBurst.update(delta)

    // 相机跟随：第三人称 / 第一人称共用同一套阻尼逻辑，
    // 传入头部锚点、朝向、转向与 Fever 强度
    player.getHeadWorldPosition(cameraHead)
    cameraRig.update(
      delta,
      player.visual.position,
      groundHeightAt,
      running ? player.speedKmh : 0,
      {
        headPosition: cameraHead,
        yaw: player.yaw,
        steer: running ? steer : 0,
        fever: feverFactor,
      }
    )
    sceneManager.followSun(player.visual.position)

    sceneManager.render()

    // 浮动文字在渲染之后更新：此时相机矩阵已刷新，投影不会滞后一帧
    floatingText.update(delta, camera)

    // 首帧渲染完成后隐藏启动遮罩
    if (firstFrame) {
      firstFrame = false
      hideBootScreen()
    }

    // ---- HUD 数据刷新 ----
    frames++
    elapsed += delta
    if (elapsed >= 0.5) {
      if (fpsEl) fpsEl.textContent = String(Math.round(frames / elapsed))
      if (speedEl) speedEl.textContent = String(Math.round(player.speedKmh))
      if (distanceEl) {
        distanceEl.textContent = String(Math.max(0, Math.round(-player.body.position.z)))
      }
      if (bestEl) {
        // 本局已超过历史最佳时当场刷新显示，让玩家更有目标感
        const current = Math.max(0, Math.round(-player.body.position.z))
        bestEl.textContent = String(Math.max(bestDistance, current))
      }
      frames = 0
      elapsed = 0
    }
  }

  tick()

  // 仅开发期暴露到全局，方便在控制台检查刚体 / 场景对象；
  // 生产构建会静态剔除这段，避免把调试入口（crash/restart）带到线上
  if (import.meta.env.DEV) {
    window.__SNOW_RUSH__ = {
      sceneManager,
      physics,
      terrain,
      obstacles,
      player,
      cameraRig,
      snowTrail,
      gateBurst,
      floatingText,
      input,
      audio,
      get running() {
        return running
      },
      get combo() {
        return combo
      },
      get fever() {
        return fever
      },
      get score() {
        return score
      },
      crash,
      restart,
    }
  }

  // 页面卸载时释放资源
  window.addEventListener('beforeunload', () => {
    cancelAnimationFrame(rafId)
    window.removeEventListener('keydown', handleRestartKey)
    window.removeEventListener('keydown', handleViewKey)
    viewButton?.removeEventListener('click', toggleView)
    restartButton?.removeEventListener('click', restart)
    muteButton?.removeEventListener('click', handleMuteClick)
    input.dispose()
    audio.dispose()
    snowTrail.dispose()
    gateBurst.dispose()
    floatingText.dispose()
    sceneManager.dispose()
  })
}

/** 隐藏启动遮罩 */
function hideBootScreen() {
  const boot = document.getElementById('boot')
  if (!boot) return
  boot.classList.add('is-hidden')
  // 等淡出动画结束再彻底移除，避免其继续占用合成层
  setTimeout(() => boot.remove(), 600)
}

// 启动；若初始化失败，把错误显示在遮罩上方便真机排查
try {
  init()
} catch (error) {
  console.error('[SnowRush] 初始化失败:', error)
  const boot = document.getElementById('boot')
  if (boot) {
    boot.innerHTML = `<p style="padding: 0 24px; text-align: center; line-height: 1.7;">
      初始化失败：${error.message}<br/>请检查控制台日志
    </p>`
  }
}
