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

    this.scene = new THREE.Scene()
    // 背景交给 CSS 渐变：canvas 透明，天空由 #app 的 linear-gradient 绘制。
    // 这样天空渐变不占 WebGL 绘制成本，也便于在真机上直接调色。

    // 指数雾：颜色取天空渐变靠近地平线的那一段粉色，
    // 远处地形与树木会自然融进背景，不会出现硬切边
    // 低饱和度的莫兰迪落日粉紫：与 CSS 天空渐变保持同一色系
    this.fogColor = new THREE.Color(0xd9bccd)
    this.scene.fog = new THREE.FogExp2(this.fogColor, 0.0042)

    this.camera = this.createCamera()
    this.renderer = this.createRenderer()

    // 平行光的位置需要跟随玩家移动（否则走到远处就没有阴影了）。
    // 夕阳放在玩家「正前方偏右」：雪坡朝向镜头的面才会被暖光打亮，
    // 影子被拉长并投向镜头，这是日落逆光最有氛围的角度
    this.sunOffset = new THREE.Vector3(28, 15, -40)
    this.createLights()

    this.handleResize = this.handleResize.bind(this)
    window.addEventListener('resize', this.handleResize)
    window.addEventListener('orientationchange', this.handleResize)
  }

  /** 第三人称越肩视角的透视相机：视野略广，近裁剪面小，便于贴近雪面 */
  createCamera() {
    const aspect = window.innerWidth / window.innerHeight
    // 基础 FOV 56，实际值由 CameraRig 按滑行速度动态拉伸到 72。
    // 比野外雪原更收窄，配合更近的机位强化「在雪道里穿梭」的压迫感
    const camera = new THREE.PerspectiveCamera(56, aspect, 0.1, 420)
    // 初始位置只是「开场机位」，后续会由玩家控制器每帧接管
    camera.position.set(0, 7, 13)
    camera.lookAt(0, 0, -26)
    return camera
  }

  createRenderer() {
    const renderer = new THREE.WebGLRenderer({
      antialias: true, // 低多边形 + 细边缘，抗锯齿对观感提升明显
      powerPreference: 'high-performance', // 移动端优先请求独立 GPU
      alpha: true, // 透明清屏，让 CSS 渐变天空透出来
    })

    // 移动端高 DPR 屏幕最多渲染 2 倍，超过后性能收益极低、发热明显
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(window.innerWidth, window.innerHeight)
    renderer.setClearAlpha(0)

    // 阴影：平行光只覆盖玩家附近的一小块区域，普通 PCF 足够
    // 注意：Three.js r187 已移除 PCFSoftShadowMap，继续使用会产生控制台警告
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFShadowMap

    // 输出为 sRGB，保证颜色与设计稿一致（Three.js 新版本默认值，这里显式声明便于移植）
    renderer.outputColorSpace = THREE.SRGBColorSpace

    // 日落场景动态范围很大（暖光高光 vs 冷色暗部），
    // ACES 会把高光平滑压到近白，避免雪面被橙色直接染成土黄
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.0

    this.container.appendChild(renderer.domElement)
    return renderer
  }

  /** 环境光负责托底亮度，平行光负责方向感与投影 */
  createLights() {
    // 环境光：冷色浅蓝紫，强度较低，只负责让背光面不发黑
    const ambient = new THREE.AmbientLight(0x607d8b, 0.6)
    this.scene.add(ambient)

    // 主光源（模拟夕阳）：强烈的暖橘色，低角度斜射。
    // 强度明显高于 1.5：Three.js 采用物理光照单位，低强度会让雪地整体发灰发棕；
    // 配合 ACES 色调映射，受光面仍是金白色，而不是纯橙色
    const sun = new THREE.DirectionalLight(0xff8c00, 4.2)
    sun.position.copy(this.sunOffset)
    sun.castShadow = true

    // 阴影贴图分辨率：2048 在移动端是画质与性能的折中值
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.bias = -0.0004
    // normalBias 可消除低多边形大平面上的「阴影条纹」瑕疵
    sun.shadow.normalBias = 0.05
    sun.shadow.camera.near = 1
    sun.shadow.camera.far = 240

    // 阴影相机覆盖以玩家为中心的 ±80m：
    // 既要罩住两侧约 ±45m 的树墙，也要容纳低角度夕阳投下的长影子
    const shadowSize = 80
    sun.shadow.camera.left = -shadowSize
    sun.shadow.camera.right = shadowSize
    sun.shadow.camera.top = shadowSize
    sun.shadow.camera.bottom = -shadowSize
    // 修改正交相机边界后必须刷新投影矩阵，否则阴影贴图会按旧范围裁切，
    // 表现为边缘锯齿、阴影断裂
    sun.shadow.camera.updateProjectionMatrix()

    this.scene.add(sun)
    // target 必须加入场景，否则它的世界矩阵不会更新
    this.scene.add(sun.target)

    this.sun = sun

    // 天光补光：一盏高处的冷蓝平行光，模拟天空反射。
    // 它不产生阴影，只把朝上的雪面抬亮，让暗部呈冷蓝色而不是脏灰色
    const skyFill = new THREE.DirectionalLight(0x8aa6d8, 1.7)
    skyFill.position.set(0, 70, 25)
    skyFill.castShadow = false
    this.scene.add(skyFill)
    this.scene.add(skyFill.target)
    this.skyFill = skyFill
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
