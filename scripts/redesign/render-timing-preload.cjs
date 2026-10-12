// 计时会话才注册的页面预加载（offscreen-window.cjs 按 DRIVE_RENDER_TIMING 注册），先于页面脚本运行。
// Playwright 轮询找到控件的时刻带量化误差；这里在页面里用 MutationObserver 记下控件第一次进入 DOM 的时刻
// （performance.now，导航开始为 0），写在 <html> 的 data 属性上，驱动启动后读取。
const shelfBooks = Number(globalThis.process?.env?.DRIVE_RENDER_TIMING) || 20

const mark = (name, value) => document.documentElement?.setAttribute(`data-drive-${name}`, String(Math.round(value)))

const isNewBook = button => (button.getAttribute('aria-label') ?? button.textContent.trim()) === '新建作品'

let interactiveAt = null
const observer = new MutationObserver(() => {
  if (interactiveAt === null && [...document.querySelectorAll('button')].some(isNewBook)) {
    interactiveAt = performance.now()
    mark('interactive', interactiveAt)
  }
  if (interactiveAt !== null && document.querySelectorAll('button[aria-label^="预览《"]').length >= shelfBooks) {
    mark('shelf', performance.now())
    observer.disconnect()
  }
})
observer.observe(document, { childList: true, subtree: true })
