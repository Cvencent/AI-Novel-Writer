import { useLocaleStore } from '../../stores/locale-store'
import { navigate } from '../../stores/navigation/navigation-intents'
import { Button } from '../ui/Button'
import { Notice } from '../ui/Notice'

/** 未配置模型时的首次使用引导：说明哪些事要用到模型，并给出去设置添加的入口。 */
export default function ModelMissingNotice({ detail }: { detail: string }) {
  const text = useLocaleStore(s => s.text)
  return (
    <Notice
      tone="info"
      title={text('还没有连接 AI 模型', 'No AI model connected yet')}
      actions={(
        <Button variant="secondary" size="sm" onClick={() => navigate({ kind: 'settings', section: 'llm' })}>
          {text('添加模型', 'Add a model')}
        </Button>
      )}
    >
      {detail}
    </Notice>
  )
}
