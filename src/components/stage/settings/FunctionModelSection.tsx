import {
  FUNCTION_MODEL_KEYS,
  FUNCTION_MODEL_LABELS,
  preferredFunctionModelId,
} from '../../../shared/function-models'
import { useLLMStore } from '../../../stores/llm-store'
import { useLocaleStore } from '../../../stores/locale-store'

/**
 * 「功能模型分配」设置页：每个功能一行，下拉指定生成模型；
 * 「跟随默认」存 null，运行时回退到全局默认模型。选择即保存。
 */
export default function FunctionModelSection() {
  const text = useLocaleStore(s => s.text)
  const models = useLLMStore(s => s.models)
  const defaultModelId = useLLMStore(s => s.defaultModelId)
  const functionModels = useLLMStore(s => s.functionModels)
  const setFunctionModel = useLLMStore(s => s.setFunctionModel)
  const generationModels = models.filter(model => model.purposes.includes('generation'))

  return (
    <div className="stage-set-card">
      <div className="stage-set-rows">
        {FUNCTION_MODEL_KEYS.map(key => {
          const [zhLabel, enLabel] = FUNCTION_MODEL_LABELS[key]
          const configured = functionModels[key] ?? null
          const effective = preferredFunctionModelId(models, functionModels, key, defaultModelId)
          const effectiveName = effective
            ? models.find(model => model.id === effective)?.name || models.find(model => model.id === effective)?.modelName || effective
            : null
          return (
            <div key={key} className="stage-set-row">
              <div>
                <p className="stage-set-row-title">{text(zhLabel, enLabel)}</p>
                <p className="stage-set-row-desc">
                  {effectiveName
                    ? text(`当前用「${effectiveName}」`, `Currently using “${effectiveName}”`)
                    : text('还没有可用模型', 'No model available yet')}
                </p>
              </div>
              <div className="stage-set-row-ctl">
                <select
                  className="stage-select"
                  value={configured ?? ''}
                  aria-label={text(zhLabel, enLabel)}
                  onChange={event => void setFunctionModel(key, event.target.value || null)}
                >
                  <option value="">{text('跟随默认', 'Follow default')}</option>
                  {generationModels.map(model => (
                    <option key={model.id} value={model.id}>
                      {model.name || model.modelName}{model.id === defaultModelId ? text('（默认）', ' (default)') : ''}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

