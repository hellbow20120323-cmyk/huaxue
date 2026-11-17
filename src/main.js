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

  // ========== STEP 05：障碍物与对象池 ==========
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
  cameraRig.snap(player.visual.position)

  // 相机防穿地用的地形采样回调：缓存一份，避免每帧新建闭包
  const groundHeightAt = (x, z) => terrain.getHeightAt(x, z)

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

  // ========== 撞击结算与重开 ==========
  const gameoverEl = document.getElementById('gameover')
  const resultLabelEl = document.getElementById('result-label')
  const finalDistanceEl = document.getElementById('final-distance')
  const finalSpeedEl = document.getElementById('final-speed')
  const finalBestEl = document.getElementById('final-best')
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

  // 当前是否处于滑行中；撞击后置为 false，物理世界随之冻结
  let running = true
  // 本局最高速度（km/h）
  let maxSpeedKmh = 0

  /** 撞到障碍：冻结物理、震屏、播放撞击音、更新最佳距离并展示结算面板 */
  function crash(impact = 6) {
    if (!running) return

    running = false
    input.reset() // 清空按键，避免重开瞬间仍带着转向输入
    player.setSteer(0) // 身体姿态回正

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

    if (gameoverEl) gameoverEl.hidden = true
    if (resultLabelEl) resultLabelEl.classList.remove('is-record')
    maxSpeedKmh = 0
    if (speedEl) speedEl.textContent = '0'
    if (distanceEl) distanceEl.textContent = '0'

    player.reset({ x: 0, y: terrain.getHeightAt(0, 0) + 1.4, z: 0 })
    // 传回起点后清理远处孤立 Chunk，并补齐起点周围地形 / 障碍
    terrain.update(0)

    cameraRig.snap(player.visual.position)
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

    if (running) {
      // 读取转向意图（-1 左 / 0 不动 / +1 右）
      const steer = input.axis

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

    // 风噪随速度变化。撞击后物理已冻结、刚体速度仍停在撞击瞬间，
    // 因此结算期间显式传 0，让风声自然淡出而不是一直呼啸
    audio.setSpeed(running ? player.speedKmh : 0)

    // 冻结时也同步视觉姿态（只做平滑，不改变物理位置）
    player.sync(delta)

    // 越肩相机平滑跟随（传入地形高度采样，防止相机钻进雪坡），
    // 并让阳光阴影范围始终覆盖玩家
    cameraRig.update(delta, player.visual.position, groundHeightAt)
    sceneManager.followSun(player.visual.position)

    sceneManager.render()

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
      input,
      audio,
      get running() {
        return running
      },
      crash,
      restart,
    }
  }

  // 页面卸载时释放资源
  window.addEventListener('beforeunload', () => {
    cancelAnimationFrame(rafId)
    window.removeEventListener('keydown', handleRestartKey)
    restartButton?.removeEventListener('click', restart)
    muteButton?.removeEventListener('click', handleMuteClick)
    input.dispose()
    audio.dispose()
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
