import { defineConfig } from 'vite'

export default defineConfig({
  // 使用相对路径打包：产物可直接被小程序 web-view 或静态托管在任意子目录下加载
  base: './',

  server: {
    host: true, // 允许局域网访问，方便手机真机调试
    port: 5173,
  },

  build: {
    // 小程序内嵌 WebView 内核版本参差不齐，语法目标保持相对保守
    target: 'es2018',
    // 产出单个体积更小的资源，减少首屏加载等待
    assetsInlineLimit: 4096,
    sourcemap: false,
  },
})
