import { useEffect, useRef, type ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'
import { useLayoutStore } from '../../../stores/layout-store'
import { useLocaleStore } from '../../../stores/locale-store'
import ProjectBackupPanel from '../../backups/ProjectBackupPanel'
import PromptSettings from '../../settings/PromptSettings'
import SkillSettings from '../../settings/SkillSettings'
import { Button } from '../../ui/Button'
import { ErrorBoundary } from '../../ErrorBoundary'
import { isComposing, isModalOpen } from '../shortcut-keys'
import AboutSection from './AboutSection'
import AppearanceSection from './AppearanceSection'
import ModelsSection from './ModelsSection'
import ProxySection from './ProxySection'
import '../styles/stage-forms.css'
import '../styles/stage-settings.css'
import { SETTINGS_GROUPS, SETTINGS_PAGES, settingsPageOf, type SettingsPage } from './settings-pages'

function PageHeader({ page, action }: { page: SettingsPage; action?: ReactNode }) {
  const text = useLocaleStore(s => s.text)
  const spec = SETTINGS_PAGES.find(candidate => candidate.id === page)!
  return (
    <header className="stage-set-head">
      <div>
        <h1 className="stage-set-title">{text(...spec.name)}</h1>
        <p className="stage-set-lede">{text(...spec.lede)}</p>
      </div>
      {action}
    </header>
  )
}

/** 旧组件（提示词模板、写作 Skills、项目备份）放进纸墨页面时仍读旧的颜色变量，由配色桥接到纸墨令牌。 */
function Legacy({ children }: { children: ReactNode }) {
  return <div className="stage-set-legacy">{children}</div>
}

function PageBody({ page }: { page: SettingsPage }) {
  switch (page) {
    case 'llm':
      return <ModelsSection purposes={['generation', 'refinement', 'summary']} header={action => <PageHeader page="llm" action={action} />} />
    case 'embedding':
      return <ModelsSection purposes={['embedding']} header={action => <PageHeader page="embedding" action={action} />} />
    case 'appearance':
      return <><PageHeader page={page} /><AppearanceSection /></>
    case 'proxy':
      return <><PageHeader page={page} /><ProxySection /></>
    case 'prompts':
      return <><PageHeader page={page} /><Legacy><PromptSettings /></Legacy></>
    case 'skills':
      return <><PageHeader page={page} /><Legacy><SkillSettings /></Legacy></>
    case 'backup':
      return <><PageHeader page={page} /><Legacy><ProjectBackupPanel /></Legacy></>
    case 'about':
      return <><PageHeader page={page} /><AboutSection /></>
  }
}

/**
 * 设置页：左侧按常用、高级、其他分组，右侧是当前一页。占满内容面板，书房与作品里都能打开；
 * 「返回」或 Esc 回到打开前的页面。当前分区记在 layout-store，切换外壳重挂后仍停在原处。
 */
export default function StageSettings({ library }: { library: boolean }) {
  const text = useLocaleStore(s => s.text)
  const page = settingsPageOf(useLayoutStore(s => s.settingsSection))
  const bodyRef = useRef<HTMLDivElement>(null)
  const close = () => useLayoutStore.getState().closeSettings()

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isComposing(event) || isModalOpen()) return
      event.preventDefault()
      useLayoutStore.getState().closeSettings()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 })
  }, [page])

  return (
    <div className="stage-settings">
      <nav className="stage-set-nav" aria-label={text('设置分组', 'Settings sections')}>
        <Button variant="text" size="sm" className="stage-set-back" onClick={close}>
          <ArrowLeft size={14} aria-hidden="true" />
          {library ? text('返回书房', 'Back to library') : text('返回作品', 'Back to the book')}
        </Button>
        <p className="stage-set-nav-title">{text('设置', 'Settings')}</p>
        {SETTINGS_GROUPS.map(group => (
          <div key={group.id} className="stage-set-group" role="group" aria-label={text(...group.name)}>
            <p className="stage-set-group-label" aria-hidden="true">{text(...group.name)}</p>
            {group.pages.map(spec => (
              <button
                key={spec.id}
                type="button"
                className="stage-set-link"
                aria-current={spec.id === page ? 'page' : undefined}
                onClick={() => useLayoutStore.setState({ settingsSection: spec.id })}
              >
                {text(...spec.name)}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="stage-set-body" ref={bodyRef}>
        <div className="stage-set-inner">
          <ErrorBoundary key={page} fallbackLabel={text('设置页渲染失败', 'Settings failed to render')}>
            <PageBody page={page} />
          </ErrorBoundary>
        </div>
      </div>
    </div>
  )
}
