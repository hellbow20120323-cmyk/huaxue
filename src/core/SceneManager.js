import * as THREE from 'three'

/**
 * SceneManager
 * ------------------------------------------------------------------
 * 只负责「看得见的东西」：场景、透视相机、WebGL 渲染器、光照、雾、窗口自适应。
 * 物理世界（Cannon-es）由 PhysicsWorld 单独管理，两者通过 main.js 中的
 * 渲染循环保持同步 —— 这样后续替换 / 调试任意一侧都不会影响另一侧。
 */
export class SceneManager {
  /**
   * @param {HTMLElement} container canvas 挂载容器
   */
  constructor(container) {
    if (!container) throw new Error('SceneManager: 找不到挂载容器')

    this.container = container

    // 天空与雾使用同一色系，远处的雪坡会自然溶进天空，掩盖地形 Chunk 的边界
    this.skyColor = new THREE.Color(0x8ecdf7)

    this.scene = new THREE.Scene()
    this.scene.background = this.skyColor
    // 雾的远端略小于相机远裁剪面，让「无尽地形」的生成/销毁不容易被玩家察觉
    this.scene.fog = new THREE.Fog(this.skyColor, 55, 190)

    this.camera = this.createCamera()
    this.renderer = this.createRenderer()

    // 平行光的位置需要跟随玩家移动（否则走到远处就没有阴影了），这里缓存初始偏移
    this.sunOffset = new THREE.Vector3(32, 56, 24)
    this.createLights()

    this.handleResize = this.handleResize.bind(this)
    window.addEventListener('resize', this.handleResize)
    window.addEventListener('orientationchange', this.handleResize)
  }

  /** 第三人称越肩视角的透视相机：视野略广，近裁剪面小，便于贴近雪面 */
  createCamera() {
    const aspect = window.innerWidth / window.innerHeight
    const camera = new THREE.PerspectiveCamera(58, aspect, 0.1, 420)
    // 初始位置只是「开场机位」，后续会由玩家控制器每帧接管
    camera.position.set(0, 7, 13)
    camera.lookAt(0, 0, -26)
    return camera
  }

  createRenderer() {
    const renderer = new THREE.WebGLRenderer({
      antialias: true, // 低多边形 + 细边缘，抗锯齿对观感提升明显
      powerPreference: 'high-performance', // 移动端优先请求独立 GPU
      alpha: false,
    })

    // 移动端高 DPR 屏幕最多渲染 2 倍，超过后性能收益极低、发热明显
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(window.innerWidth, window.innerHeight)

    // 阴影：平行光只覆盖玩家附近的一小块区域，普通 PCF 足够
    // 注意：Three.js r187 已移除 PCFSoftShadowMap，继续使用会产生控制台警告
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFShadowMap

    // 输出为 sRGB，保证颜色与设计稿一致（Three.js 新版本默认值，这里显式声明便于移植）
    renderer.outputColorSpace = THREE.SRGBColorSpace

    this.container.appendChild(renderer.domElement)
    return renderer
  }

  /** 环境光负责托底亮度，平行光负责方向感与投影 */
  createLights() {
    // 环境光：雪地会强烈反射光，环境光稍高可避免背光面死黑
    const ambient = new THREE.AmbientLight(0xdff1ff, 0.85)
    this.scene.add(ambient)

    // 主光源（模拟太阳）：偏暖色，与冷色雪地形成对比。
    // Three.js 新版本采用物理光照单位，强度需明显高于旧版才能得到「雪白」的观感
    const sun = new THREE.DirectionalLight(0xfff2dc, 3.0)
    sun.position.copy(this.sunOffset)
    sun.castShadow = true

    // 阴影贴图分辨率：2048 在移动端是画质与性能的折中值
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.bias = -0.0004
    // normalBias 可消除低多边形大平面上的「阴影条纹」瑕疵
    sun.shadow.normalBias = 0.04
    sun.shadow.camera.near = 1
    sun.shadow.camera.far = 220

    // 阴影相机只覆盖焦点附近 ±45 的区域：范围越小，阴影越清晰
    const shadowSize = 45
    sun.shadow.camera.left = -shadowSize
    sun.shadow.camera.right = shadowSize
    sun.shadow.camera.top = shadowSize
    sun.shadow.camera.bottom = -shadowSize

    this.scene.add(sun)
    // target 必须加入场景，否则它的世界矩阵不会更新
    this.scene.add(sun.target)

    this.sun = sun
  }

  /**
   * 让阳光的阴影范围跟随焦点（后续传入玩家位置）。
   * 不移动光源方向，只平移「光 + 目标」，所以阴影方向始终一致。
   * @param {THREE.Vector3} focus 需要保证阴影质量的世界坐标
   */
  followSun(focus) {
    this.sun.position.copy(focus).add(this.sunOffset)
    this.sun.target.position.copy(focus)
  }

  handleResize() {
    const width = window.innerWidth
    const height = window.innerHeight

    // 竖屏时保持足够大的纵向视野，避免雪坡占满屏幕、看不到前方障碍
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(width, height)
  }

  render() {
    this.renderer.render(this.scene, this.camera)
  }

  /** 页面销毁 / 热更新时释放 GPU 资源 */
  dispose() {
    window.removeEventListener('resize', this.handleResize)
    window.removeEventListener('orientationchange', this.handleResize)
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
