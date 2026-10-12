import { useId, type ReactNode } from 'react'
import { Minus, Moon, Plus, Sun } from 'lucide-react'
import type { Locale } from '../../../i18n/types'
import { useAppearanceStore } from '../../../stores/appearance-bootstrap'
import { useLocaleStore } from '../../../stores/locale-store'
import { FONT_OPTIONS, useThemeStore, type FontId } from '../../../stores/theme-store'
import { useAutoOpenNextChapter } from '../../settings/use-auto-open-next-chapter'
import { Button } from '../../ui/Button'
import { Check } from '../../ui/Check'
import { SegmentedControl } from '../../ui/SegmentedControl'
import { inkTheme } from '../ink-theme'
import { commandLabel } from '../shortcut-keys'

function Row({ title, desc, control, children, htmlFor }: { title: string; desc?: ReactNode; control: ReactNode; children?: ReactNode; htmlFor?: string }) {
  return (
    <div className="stage-set-row">
      <div>
        {htmlFor ? <label className="stage-set-row-title" htmlFor={htmlFor}>{title}</label> : <p className="stage-set-row-title">{title}</p>}
        {desc && <p className="stage-set-row-desc">{desc}</p>}
        {children}
      </div>
      <div className="stage-set-row-ctl">{control}</div>
    </div>
  )
}

function FontSelect({ id, value, onChange }: { id: string; value: FontId; onChange: (font: FontId) => void }) {
  const text = useLocaleStore(s => s.text)
  return (
    <select id={id} className="stage-select" value={value} onChange={event => onChange(event.target.value as FontId)}>
      {FONT_OPTIONS.map(option => <option key={option.id} value={option.id}>{text(option.label, option.labelEn)}</option>)}
    </select>
  )
}

/** 外观：界面布局、主题、语言、字体、缩放与定稿后打开下一章。改动立即生效。 */
export default function AppearanceSection() {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const setLocale = useLocaleStore(s => s.setLocale)
  const { theme, setTheme, zoom, zoomIn, zoomOut, zoomReset, uiFont, setUiFont, writingFont, setWritingFont } = useThemeStore()
  const resolvedShell = useAppearanceStore(s => s.resolvedShell)
  const autoOpenNext = useAutoOpenNextChapter()
  const ink = inkTheme(theme)
  const languageId = useId()
  const uiFontId = useId()
  const writingFontId = useId()
  const writingFontFamily = FONT_OPTIONS.find(option => option.id === writingFont)?.family
  const themes = [
    { id: 'light', icon: <Sun size={18} aria-hidden="true" />, name: text('浅色', 'Light'), desc: text('纸面与墨色', 'Paper and ink') },
    { id: 'dark', icon: <Moon size={18} aria-hidden="true" />, name: text('深色', 'Dark'), desc: text('夜里写作', 'For the night') },
  ] as const

  return (
    <div className="stage-set-rows">
      <Row
        title={text('主题', 'Theme')}
        control={(
          <div className="stage-set-themes" role="radiogroup" aria-label={text('主题', 'Theme')}>
            {themes.map(option => (
              <button key={option.id} type="button" role="radio" aria-checked={ink === option.id} className="stage-set-theme"
                data-theme-option={option.id} onClick={() => { if (ink !== option.id) setTheme(option.id) }}>
                {option.icon}
                <span className="stage-set-theme-name">{option.name}</span>
                <span className="stage-set-theme-desc">{option.desc}</span>
              </button>
            ))}
          </div>
        )}
      />
      <Row htmlFor={languageId} title={text('界面语言', 'Interface language')}
        desc={text('菜单、按钮与提示的语言。AI 写作用的语言在作品设定里单独设置。', 'Menus, buttons and messages. The language AI writes in is set per book, in setup.')}
        control={(
          <select id={languageId} className="stage-select" value={locale} onChange={event => void setLocale(event.target.value as Locale)}>
            <option value="zh-CN">{text('简体中文', 'Simplified Chinese')}</option>
            <option value="en-US">English</option>
          </select>
        )} />
      <Row htmlFor={uiFontId} title={text('界面字体', 'Interface font')} desc={text('菜单、表单和列表使用的字体。', 'Used for menus, forms and lists.')}
        control={<FontSelect id={uiFontId} value={uiFont} onChange={setUiFont} />} />
      <Row htmlFor={writingFontId} title={text('写作字体', 'Writing font')} desc={text('正文编辑区使用的字体。', 'Used in the manuscript editor.')}
        control={<FontSelect id={writingFontId} value={writingFont} onChange={setWritingFont} />}>
        <p className="stage-set-font-sample" style={{ fontFamily: writingFontFamily }}>
          {text('雨从傍晚开始就没有停过。林岚站在空荡的站台上。', 'The rain had not stopped since dusk. Lin Lan stood on the empty platform.')}
        </p>
      </Row>
      <Row
        title={text('界面缩放', 'Zoom')}
        desc={text(`也可以用 ${commandLabel('=')} 放大、${commandLabel('-')} 缩小、${commandLabel('0')} 还原。`, `Or press ${commandLabel('=')} to zoom in, ${commandLabel('-')} to zoom out, ${commandLabel('0')} to reset.`)}
        control={(
          <div className="stage-set-zoom" role="group" aria-label={text('界面缩放', 'Zoom')}>
            <Button variant="icon" size="sm" aria-label={text('缩小', 'Zoom out')} disabled={zoom <= 0.7} onClick={zoomOut}><Minus size={14} aria-hidden="true" /></Button>
            <output className="stage-set-zoom-value" aria-live="polite">{Math.round(zoom * 100)}%</output>
            <Button variant="icon" size="sm" aria-label={text('放大', 'Zoom in')} disabled={zoom >= 1.5} onClick={zoomIn}><Plus size={14} aria-hidden="true" /></Button>
            <Button variant="text" size="sm" disabled={zoom === 1} onClick={zoomReset}>{text('还原', 'Reset')}</Button>
          </div>
        )}
      />
      <Row
        title={text('定稿后打开下一章', 'Open the next chapter after finalizing')}
        desc={text('一章定稿与后处理都完成后，自动打开下一章的写作页。不会自动生成正文，也不会覆盖已有草稿。', 'When a chapter is finalized and processed, open the next planned chapter. It never starts writing or overwrites a draft.')}
        control={<Check kind="switch" checked={autoOpenNext.enabled} disabled={autoOpenNext.saving} onChange={checked => void autoOpenNext.set(checked)}
          label={<span className="stage-visually-hidden">{text('定稿后打开下一章', 'Open the next chapter after finalizing')}</span>} />}
      >
        {autoOpenNext.error && <p className="stage-set-error" role="alert">{autoOpenNext.error}</p>}
      </Row>
      <Row
        title={text('界面布局', 'Layout')}
        desc={text('创作流程按设定、架构、蓝图、正文组织一部作品，仍在完善中，随时可以切回工作台。', 'Creative flow organizes a book into setup, architecture, blueprint and manuscript. It is in preview; you can switch back to the workbench at any time.')}
        control={(
          <SegmentedControl
            label={text('界面布局', 'Layout')}
            value={resolvedShell === 'stage' ? 'stage' : 'workbench'}
            options={[{ value: 'workbench', label: text('工作台', 'Workbench') }, { value: 'stage', label: text('创作流程（预览）', 'Creative flow (preview)') }]}
            onChange={value => useAppearanceStore.getState().update({ shellPreference: value === 'stage' ? 'stage' : 'unset' })}
          />
        )}
      />
    </div>
  )
}
