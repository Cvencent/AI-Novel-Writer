import { installMainGenerationTransport } from './services/generation/generation-runtime'
import { mainGenerationTransport } from './services/generation/main-generation-transport'
import { installGlobalRejectionLogging } from './startup-observability'
import React from 'react'
import ReactDOM from 'react-dom/client'
import RendererStartup from './components/startup/RendererStartup'
// 纸墨样式只在入口引入：原语组件不带样式副作用，Node 侧打包（如真实供应商资格脚本）才能引用它们。
import './styles/paper-ink/index.css'
import './index.css'
// 外壳样式同样只在入口引入，排在全局样式之后，颜色桥接才能覆盖 index.css 里的 --color-*。
import './components/stage/stage.css'


installMainGenerationTransport(mainGenerationTransport)
// issue #236 ②：unhandledrejection / uncaught error 转发进 console.error（诊断收集可见），
// 「吞异常」不再静默。组件内错误出口仍各自负责（同轮 start() 已补 catch）。
installGlobalRejectionLogging()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RendererStartup />
  </React.StrictMode>,
)
