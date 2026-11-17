/**
 * InputController（输入统一层）
 * ------------------------------------------------------------------
 * 把桌面键盘与移动端触控统一成 -1 / 0 / +1 的横向轴：
 *   - 桌面：A / D 或 ← / →
 *   - 移动端：屏幕左右两半的隐形触控区，支持多指同时按住
 *
 * 不直接操作玩家，只负责「读取意图」，方便后续替换成手柄、重力感应等输入源。
 */

// 键盘按键到方向的映射
const LEFT_KEYS = new Set(['KeyA', 'ArrowLeft'])
const RIGHT_KEYS = new Set(['KeyD', 'ArrowRight'])

export class InputController {
  constructor() {
    // 当前按住的键（用 Set 记录，避免 A 和 ← 同时按下时释放顺序出错）
    this.keys = new Set()
    // 移动端触点：touchIdentifier -> -1(左) / +1(右)
    this.touches = new Map()

    // 绑定事件处理函数，便于 dispose 时精确移除
    this.onKeyDown = this.handleKeyDown.bind(this)
    this.onKeyUp = this.handleKeyUp.bind(this)
    this.onTouchStart = this.handleTouchStart.bind(this)
    this.onTouchMove = this.handleTouchMove.bind(this)
    this.onTouchEnd = this.handleTouchEnd.bind(this)
    this.onBlur = this.reset.bind(this)

    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('touchstart', this.onTouchStart, { passive: false })
    window.addEventListener('touchmove', this.onTouchMove, { passive: false })
    window.addEventListener('touchend', this.onTouchEnd)
    window.addEventListener('touchcancel', this.onTouchEnd)
    window.addEventListener('blur', this.onBlur)
  }

  handleKeyDown(event) {
    if (LEFT_KEYS.has(event.code) || RIGHT_KEYS.has(event.code)) {
      // 阻止方向键滚动页面
      event.preventDefault()
      this.keys.add(event.code)
    }
  }

  handleKeyUp(event) {
    this.keys.delete(event.code)
  }

  /** 记录每个触点落在左半屏还是右半屏 */
  handleTouchStart(event) {
    // 触点在可交互 UI（例如「再来一次」按钮）上时不拦截，
    // 否则 preventDefault 会阻止浏览器派发 click 事件
    if (event.target instanceof Element && event.target.closest('button, a, [data-ui]')) {
      return
    }

    event.preventDefault()
    for (const touch of event.changedTouches) {
      this.touches.set(touch.identifier, touch.clientX < window.innerWidth / 2 ? -1 : 1)
    }
  }

  /** 手指滑到另一半屏幕时，实时切换方向 */
  handleTouchMove(event) {
    let handled = false
    for (const touch of event.changedTouches) {
      if (this.touches.has(touch.identifier)) {
        this.touches.set(touch.identifier, touch.clientX < window.innerWidth / 2 ? -1 : 1)
        handled = true
      }
    }
    // 只拦截正在用于操控的触点，避免影响 UI 上的手势
    if (handled) event.preventDefault()
  }

  handleTouchEnd(event) {
    for (const touch of event.changedTouches) {
      this.touches.delete(touch.identifier)
    }
  }

  /** 切到后台 / 失焦时清空输入，防止「一直按住」的卡键 */
  reset() {
    this.keys.clear()
    this.touches.clear()
  }

  /**
   * 横向输入轴
   * @returns {number} -1 左 / 0 不动 / +1 右
   */
  get axis() {
    let axis = 0

    for (const code of this.keys) {
      if (LEFT_KEYS.has(code)) axis -= 1
      if (RIGHT_KEYS.has(code)) axis += 1
    }

    for (const side of this.touches.values()) {
      axis += side
    }

    // 同时按住左右时互相抵消，并限制在 [-1, 1]
    return Math.max(-1, Math.min(1, axis))
  }

  dispose() {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('touchstart', this.onTouchStart)
    window.removeEventListener('touchmove', this.onTouchMove)
    window.removeEventListener('touchend', this.onTouchEnd)
    window.removeEventListener('touchcancel', this.onTouchEnd)
    window.removeEventListener('blur', this.onBlur)
  }
}
