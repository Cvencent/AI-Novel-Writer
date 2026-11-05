import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * issue #184 的**接口**那一半：`reviewMemoryAnchors` 必须把「模型实际看到的候选池」
 * 交给 `parseMemoryAnchorReview`，而不是让解析器自己重算一份。
 *
 * 为什么用源码断言而不是调用：那个函数要注入 LLM store 与 session，跑起来成本高；
 * 而这里要守的是一条**接线约定**（两处是否用同一份数据）。本仓已有同类做法
 * （`acknowledgement-title.test.ts` 直接读源码断言渲染层不再吐内部键）。
 *
 * ⚠️ 这条测试的价值在于「改错会红」：如果以后有人把 `callbacks` 参数去掉、
 * 或改成让解析器重算，它会立刻失败——那正是 #184 想防的漂移。
 */
describe('回指判据的池子接线 (issue #184)', () => {
  const root = join(__dirname, '..', '..', '..')
  const source = readFileSync(join(root, 'src', 'services', 'preflight-repair.ts'), 'utf8')

  it('passes the prompt callbacks into the parser instead of letting it recompute', () => {
    expect(source).toContain('buildMemoryAnchorPrompt(request)')
    // 解析调用必须带上第三参数（callbacks）。
    expect(source).toMatch(/parseMemoryAnchorReview\(response\.content, request, callbacks\)/u)
  })

  it('the parser really accepts a pool argument', () => {
    const shared = readFileSync(join(root, 'src', 'shared', 'memory-anchor-review.ts'), 'utf8')
    expect(shared).toMatch(/callbacks\?:\s*ReadonlyArray<\{ chapterNumber: number, sentence: string \}>/u)
    // 校验必须落在池子上：`inPool(...)` 出现在解析器里并真的被用来 `continue`。
    expect(shared).toMatch(/if \(!inPool\(chapterNumber, quote\)\) continue/u)
  })
})