/**
 * AudioManager（程序化音效）
 * ------------------------------------------------------------------
 * 不引入任何外部音频文件，全部用 WebAudio 实时合成，方便打包进小程序：
 *   - 风噪：白噪声 + 低通滤波，音量 / 截止频率随速度变化
 *   - 撞击：低频闷响 + 噪声爆裂，冲击越大越响
 *   - UI  ：按钮点击的短促提示音
 *
 * 浏览器要求音频必须在用户手势之后才能真正发声，
 * 因此这里在首次 pointerdown / keydown 时才创建 AudioContext。
 * 静音状态写入 localStorage，下次进入游戏自动沿用。
 */

const STORAGE_KEY = 'snowrush:muted'
// 风噪达到最大音量对应的速度（km/h）
const WIND_MAX_KMH = 85

export class AudioManager {
  constructor() {
    this.ctx = null
    this.master = null
    this.windGain = null
    this.windFilter = null
    this.noiseBuffer = null
    this.speedKmh = 0
    // 上一次真正写入音频参数的缩放值，用于跳过无意义的每帧更新
    this._appliedKmh = 0

    // 读取上次的静音设置；隐私模式下 localStorage 可能抛错，忽略即可
    this.muted = false
    try {
      this.muted = localStorage.getItem(STORAGE_KEY) === '1'
    } catch {
      this.muted = false
    }

    // 用户手势是创建 / 恢复 AudioContext 的唯一可靠时机。
    // 这里不设 once：iOS 切后台、来电后上下文会变 suspended，
    // 下一次触摸 / 按键时再幂等地恢复即可
    this.handleGesture = this.unlock.bind(this)
    this.handleVisibilityChange = this.handleVisibilityChange.bind(this)
    window.addEventListener('pointerdown', this.handleGesture, { passive: true })
    window.addEventListener('keydown', this.handleGesture)
    document.addEventListener('visibilitychange', this.handleVisibilityChange)
  }

  /** 回到前台时尝试恢复被系统挂起的音频（部分内核仍需一次手势才能恢复） */
  handleVisibilityChange() {
    if (!document.hidden && this.ctx) this.unlock()
  }

  /** 在用户手势中创建 / 恢复 AudioContext */
  unlock() {
    if (!this.ctx) this.init()
    // iOS 上切后台回来会变 suspended，这里顺手恢复
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {})
    }
  }

  init() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext
    if (!AudioContextClass) return

    this.ctx = new AudioContextClass()
    this.master = this.ctx.createGain()
    this.master.gain.value = this.muted ? 0 : 1
    this.master.connect(this.ctx.destination)

    // 2 秒白噪声循环，足够长避免听出重复
    this.noiseBuffer = createNoiseBuffer(this.ctx, 2)

    // ---- 风噪链路：buffer → 低通 → 音量 → 总线 ----
    const windSource = this.ctx.createBufferSource()
    windSource.buffer = this.noiseBuffer
    windSource.loop = true

    this.windFilter = this.ctx.createBiquadFilter()
    this.windFilter.type = 'lowpass'
    this.windFilter.frequency.value = 380
    this.windFilter.Q.value = 0.6

    this.windGain = this.ctx.createGain()
    this.windGain.gain.value = 0

    windSource.connect(this.windFilter)
    this.windFilter.connect(this.windGain)
    this.windGain.connect(this.master)
    windSource.start()

    this.applySpeed()
    this._appliedKmh = this.speedKmh
  }

  /**
   * 每帧更新当前速度：风噪音量与音色随速度平滑变化。
   * 内部做了变化量过滤，速度几乎不变时不会写入音频参数。
   * @param {number} kmh
   */
  setSpeed(kmh) {
    this.speedKmh = kmh
    // 风噪对速度的响应很平缓，差值不足 0.5 km/h 时直接跳过
    if (Math.abs(kmh - this._appliedKmh) < 0.5) return
    this._appliedKmh = kmh
    this.applySpeed()
  }

  applySpeed() {
    if (!this.ctx || !this.windGain) return

    // 0..1 归一化，平方后低速几乎无声、高速明显增强
    const t = Math.min(1, this.speedKmh / WIND_MAX_KMH)
    const now = this.ctx.currentTime
    this.windGain.gain.setTargetAtTime(0.015 + 0.17 * t * t, now, 0.3)
    this.windFilter.frequency.setTargetAtTime(360 + 880 * t, now, 0.3)
  }

  /**
   * 撞击音效。
   * @param {number} impact 碰撞法向速度（m/s），用于决定响度
   */
  crash(impact = 6) {
    if (!this.ctx || !this.master) return

    const now = this.ctx.currentTime
    const amp = Math.min(1, 0.55 + impact / 16)

    // ---- 低频闷响：从 150Hz 快速下滑到 42Hz ----
    const thud = this.ctx.createOscillator()
    thud.type = 'sine'
    thud.frequency.setValueAtTime(150, now)
    thud.frequency.exponentialRampToValueAtTime(42, now + 0.32)

    const thudGain = this.ctx.createGain()
    thudGain.gain.setValueAtTime(0.0001, now)
    thudGain.gain.exponentialRampToValueAtTime(0.5 * amp, now + 0.012)
    thudGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.42)

    thud.connect(thudGain)
    thudGain.connect(this.master)
    thud.start(now)
    thud.stop(now + 0.45)

    // ---- 雪面摩擦噪声：滤波截止频率快速下落，听感更「闷」 ----
    const burst = this.ctx.createBufferSource()
    burst.buffer = this.noiseBuffer

    const burstFilter = this.ctx.createBiquadFilter()
    burstFilter.type = 'lowpass'
    burstFilter.frequency.setValueAtTime(2600, now)
    burstFilter.frequency.exponentialRampToValueAtTime(320, now + 0.3)

    const burstGain = this.ctx.createGain()
    burstGain.gain.setValueAtTime(0.35 * amp, now)
    burstGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35)

    burst.connect(burstFilter)
    burstFilter.connect(burstGain)
    burstGain.connect(this.master)
    burst.start(now)
    burst.stop(now + 0.38)
  }

  /** 按钮点击音：一个小幅上滑的短音 */
  click() {
    if (!this.ctx || !this.master) return

    const now = this.ctx.currentTime
    const osc = this.ctx.createOscillator()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(520, now)
    osc.frequency.exponentialRampToValueAtTime(780, now + 0.07)

    const gain = this.ctx.createGain()
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.09, now + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.1)

    osc.connect(gain)
    gain.connect(this.master)
    osc.start(now)
    osc.stop(now + 0.12)
  }

  /**
   * 切换静音并持久化。
   * @returns {boolean} 切换后的静音状态
   */
  toggleMute() {
    this.muted = !this.muted

    try {
      localStorage.setItem(STORAGE_KEY, this.muted ? '1' : '0')
    } catch {
      // 忽略隐私模式下的写入失败
    }

    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : 1, this.ctx.currentTime, 0.02)
    }
    return this.muted
  }

  dispose() {
    window.removeEventListener('pointerdown', this.handleGesture)
    window.removeEventListener('keydown', this.handleGesture)
    document.removeEventListener('visibilitychange', this.handleVisibilityChange)
    if (this.ctx) {
      this.ctx.close().catch(() => {})
      this.ctx = null
    }
  }
}

/** 生成指定秒数的白噪声缓冲 */
function createNoiseBuffer(ctx, seconds) {
  const length = Math.floor(ctx.sampleRate * seconds)
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
  const data = buffer.getChannelData(0)

  for (let i = 0; i < length; i++) {
    data[i] = Math.random() * 2 - 1
  }
  return buffer
}
