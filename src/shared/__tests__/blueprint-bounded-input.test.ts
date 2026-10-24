import { describe, expect, it } from 'vitest'
import { outlineBatchSliceForBlueprint, blueprintBoundedInput } from '../blueprint-input'

const NL = String.fromCharCode(10)
const CH = (n: number) => '## 第' + n + '章：标题' + n
const synopsis = ['# 细纲', '', CH(1), '第一章正文。', '', CH(2), '第二章正文。', '', CH(3), '第三章正文。', '', CH(4), '第四章正文。'].join(NL)

describe('WP2b bounded blueprint input', () => {
  it('slices only the chapters in the target batch', () => {
    const sliced = outlineBatchSliceForBlueprint(synopsis, 2, 3)
    expect(sliced).toContain(CH(2))
    expect(sliced).toContain(CH(3))
    expect(sliced).not.toContain(CH(1))
    expect(sliced).not.toContain(CH(4))
  })
  it('returns empty when the range is outside the outline', () => {
    expect(outlineBatchSliceForBlueprint(synopsis, 50, 60)).toBe('')
  })
  it('composes bounded input from core facts plus the batch outline and arc', () => {
    const input = blueprintBoundedInput({ coreOutline: '全书方向', premise: '前提', charactersArch: '角色', worldbuilding: '世界观', batchOutline: CH(2), arcDirective: '【当前章所属粗纲段】段落方向。', language: 'zh-CN' })
    expect(input).toContain('全书方向')
    expect(input).toContain('前提')
    expect(input).toContain('角色')
    expect(input).toContain('世界观')
    expect(input).toContain(CH(2))
    expect(input).toContain('段落方向')
    expect(input).not.toContain(CH(1))
  })
})
