import { describe, expect, it } from 'vitest'
import {
  EDITORIAL_ROLE_WEIGHTS,
  estimateUsageCost,
  parseEditorialPanelResponse,
  parseScenePlanResponse,
  parseVoiceProfilesResponse,
  validateChapterCommitInput,
} from '../writing-intelligence'

describe('writing intelligence contracts', () => {
  it('normalizes a scene plan into ordered bounded scene cards', () => {
    const scenes = parseScenePlanResponse(JSON.stringify({ scenes: [
      { title: '开场', goal: '进入库房', conflict: '门被反锁', turn: '发现备用钥匙', outcome: '拿到账册', characters: ['林岚'], targetWords: 800 },
      { title: '对峙', goal: '逼问周砚', conflict: '对方拒绝承认', turn: '录音出现', outcome: '关系破裂', characters: ['林岚', '周砚'] },
    ] }))
    expect(scenes.map(scene => scene.id)).toEqual(['scene-1', 'scene-2'])
    expect(scenes[0]).toMatchObject({ title: '开场', targetWords: 800, characters: ['林岚'] })
    expect(scenes[1].targetWords).toBeNull()
  })

  it('rejects a scene plan with missing action fields or duplicate ids', () => {
    expect(() => parseScenePlanResponse('{"scenes":[{"title":"只有标题"}]}')).toThrow()
    expect(() => parseScenePlanResponse('{"scenes":[{"id":"same","title":"A","goal":"g","conflict":"c","turn":"t","outcome":"o"},{"id":"same","title":"B","goal":"g","conflict":"c","turn":"t","outcome":"o"}]}')).toThrow()
  })

  it('requires all five editorial roles and computes the weighted score', () => {
    const panel = parseEditorialPanelResponse(JSON.stringify({ summary: '需要修一轮', roles: [
      { role: 'plot', score: 80, summary: '主线清楚', findings: [] },
      { role: 'continuity', score: 60, summary: '有一处时间冲突', findings: [{ severity: 'blocking', description: '第3章是白天，本章写成深夜' }] },
      { role: 'character', score: 90, summary: '动机成立', findings: [] },
      { role: 'style', score: 70, summary: '比喻偏多', findings: [{ severity: 'warning', description: '同一比喻重复四次' }] },
      { role: 'pacing', score: 85, summary: '节奏可读', findings: [] },
    ] }))
    const expected = 80 * EDITORIAL_ROLE_WEIGHTS.plot + 60 * EDITORIAL_ROLE_WEIGHTS.continuity
      + 90 * EDITORIAL_ROLE_WEIGHTS.character + 70 * EDITORIAL_ROLE_WEIGHTS.style + 85 * EDITORIAL_ROLE_WEIGHTS.pacing
    expect(panel.weightedScore).toBeCloseTo(expected, 5)
    expect(panel.blockingCount).toBe(1)
    expect(panel.roles).toHaveLength(5)
  })

  it('rejects incomplete or duplicate editorial role output', () => {
    expect(() => parseEditorialPanelResponse('{"roles":[{"role":"plot","score":80,"summary":"ok","findings":[]}]}')).toThrow()
    const duplicate = ['plot', 'plot', 'character', 'style', 'pacing'].map(role => ({ role, score: 80, summary: 'ok', findings: [] }))
    expect(() => parseEditorialPanelResponse(JSON.stringify({ roles: duplicate }))).toThrow()
  })

  /**
   * issue #245 现场：编辑部评审在运行侧页显示的是**裸的**
   * `SyntaxError: Expected ':' after property name in JSON at position 1102`。
   * 真库复现后确认成因是模型漏写键名：把 `"role": "continuity",` 写成了 `"continuity",`。
   * 这条用例把那份真实响应钉住，确保报错是**领域码**而不是 V8 的内部措辞。
   */
  it('reports a malformed model response as a domain error, not a raw SyntaxError', () => {
    // 真库原始响应片段（`源起` 第 1 章 15:29 那次 failed 的运行）。
    const malformed = [
      '```json',
      '{',
      '  "summary": "全章叙事脉络基本承接了大纲建置核心。",',
      '  "roles": [',
      '    { "role": "plot", "score": 88, "summary": "主线清晰", "findings": [] },',
      '    {',
      '      "continuity",',
      '      "score": 75,',
      '      "summary": "世界观底层逻辑基本一致"',
      '    }',
      '  ]',
      '}',
      '```',
    ].join('\n')
    let caught: unknown
    try { parseEditorialPanelResponse(malformed) } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(Error)
    const message = (caught as Error).message
    expect(message).toMatch(/^WRITING_INTELLIGENCE_JSON_INVALID:/u)
    // 渲染层/重试逻辑据此判定，而不是靠英文语法文案。
    expect(message).not.toMatch(/^SyntaxError/u)
  })

  it('still accepts a fenced response whose JSON is valid', () => {
    const valid = '```json\n' + JSON.stringify({ summary: '整体成立', roles: ['plot', 'continuity', 'character', 'style', 'pacing']
      .map(role => ({ role, score: 80, summary: 'ok', findings: [] })) }) + '\n```'
    expect(parseEditorialPanelResponse(valid).roles).toHaveLength(5)
  })

  it('accepts voice evidence only for a known character and unique quotes', () => {
    const profiles = parseVoiceProfilesResponse(JSON.stringify({ profiles: [{
      characterId: 'char-1', characterName: '林岚', summary: '克制但尖锐',
      sentenceStyle: '短句为主', vocabulary: '少用形容词', dialogueHabits: ['反问', '停顿后回答'],
      emotionalTells: '紧张时整理袖口', avoid: ['长篇独白'], evidence: ['林岚说：“不对。”'],
    }] }), [{ characterId: 'char-1', name: '林岚' }], '林岚说：“不对。”\n\n周砚没有回答。')
    expect(profiles).toEqual([expect.objectContaining({ characterId: 'char-1', characterName: '林岚', summary: '克制但尖锐' })])
    expect(() => parseVoiceProfilesResponse(JSON.stringify({ profiles: [{ characterId: 'missing', characterName: '未知', summary: 'x', sentenceStyle: 'x', vocabulary: 'x', dialogueHabits: [], emotionalTells: 'x', avoid: [], evidence: [] }] }), [{ characterId: 'char-1', name: '林岚' }], '正文')).toThrow()
  })

  it('validates chapter commit identity and JSON-safe facts', () => {
    const valid = validateChapterCommitInput({
      chapterNumber: 3, draftId: 12, finalizationId: 'fin-12', contentHash: 'a'.repeat(64),
      facts: [{ kind: 'event', statement: '林岚拿到账册', evidence: '账册在桌上。' }],
      characterStates: [{ characterId: 'char-1', state: { location: '库房' } }],
      foreshadowing: [{ title: '缺页账册', status: 'planted' }],
      quality: { weightedScore: 82, blockingCount: 0 },
    })
    expect(valid.chapterNumber).toBe(3)
    expect(() => validateChapterCommitInput({ ...valid, contentHash: 'bad' })).toThrow()
    expect(() => validateChapterCommitInput({ ...valid, finalizationId: '' })).toThrow()
  })

  it('estimates per-call cost without pretending unknown usage is zero', () => {
    expect(estimateUsageCost({ promptTokens: 1000, completionTokens: 500, inputPerMillion: 2, outputPerMillion: 8 })).toBeCloseTo(0.006, 6)
    expect(estimateUsageCost({ promptTokens: null, completionTokens: 500, inputPerMillion: 2, outputPerMillion: 8 })).toBeNull()
    expect(estimateUsageCost({ promptTokens: 1000, completionTokens: 500, inputPerMillion: null, outputPerMillion: 8 })).toBeNull()
  })
})

describe('voice profile evidence limits (issue #67)', () => {
  const roster = [{ characterId: 'char-1', name: '周叙' }, { characterId: 'char-2', name: '温珩' }]
  // 一条正文，含足够多的独有句子供引文核对。
  const prose = [
    '周叙把存根按进水隔下面。',
    '周叙说：“这一班次我不签。”',
    '温珩没答，只把缆绳又绕了一圈。',
    '温珩说：“那你今晚别下船。”',
    '周叙低头看拇指，红还没洗掉。',
    '温珩把灯芯剪短了一截。',
    '周叙把签收联叠进风灯罩。',
    '温珩转身进了舱底。',
  ].join(String.fromCharCode(10) + String.fromCharCode(10))

  const profile = (name: string, id: string, evidence: string[]) => ({
    characterId: id, characterName: name, summary: '克制', sentenceStyle: '短句',
    vocabulary: '少形容词', dialogueHabits: [], emotionalTells: '紧张时整理袖口', avoid: [], evidence,
  })

  it('truncates evidence above the limit instead of discarding the whole reply', () => {
    // 实测模型给「周叙」写了 7 条引文（上限 5），旧实现整批作废、0 条落库。
    const seven = ['周叙把存根按进水隔下面。', '周叙说：“这一班次我不签。”', '周叙低头看拇指，红还没洗掉。',
      '周叙把签收联叠进风灯罩。', '温珩转身进了舱底。', '温珩把灯芯剪短了一截。', '温珩没答，只把缆绳又绕了一圈。']
    const parsed = parseVoiceProfilesResponse(
      JSON.stringify({ profiles: [profile('周叙', 'char-1', seven)] }), roster, prose,
    )
    expect(parsed).toHaveLength(1)
    expect(parsed[0]!.evidence).toHaveLength(5)
    expect(parsed[0]!.evidence[0]).toBe(seven[0])
  })

  it('keeps the other characters when one of them is unusable', () => {
    // 旧实现一个角色不合规就整批 throw：这里第 2 个角色引文全是编造的。
    const parsed = parseVoiceProfilesResponse(JSON.stringify({ profiles: [
      profile('周叙', 'char-1', ['周叙把存根按进水隔下面。']),
      profile('温珩', 'char-2', ['他从来没有说过这句话。']),
    ] }), roster, prose)
    expect(parsed.map(item => item.characterName)).toEqual(['周叙'])
  })

  it('drops only the quotes that are not in the prose, keeping the verifiable ones', () => {
    const parsed = parseVoiceProfilesResponse(JSON.stringify({ profiles: [profile('周叙', 'char-1', [
      '周叙把存根按进水隔下面。', '这句正文里没有。', '周叙说：“这一班次我不签。”',
    ])] }), roster, prose)
    expect(parsed[0]!.evidence).toEqual(['周叙把存根按进水隔下面。', '周叙说：“这一班次我不签。”'])
  })

  it('accepts a quote that the model re-wrapped across lines', () => {
    // 模型常把换行改写为单空格；归一化后仍能对上就算逐字证据（旧实现在此判定失败）。
    const wrapped = '周叙把存根按进水隔下面。 周叙说：“这一班次我不签。”'
    const parsed = parseVoiceProfilesResponse(
      JSON.stringify({ profiles: [profile('周叙', 'char-1', [wrapped])] }), roster, prose,
    )
    expect(parsed[0]!.evidence).toEqual([wrapped])
  })

  it('fails only when no character can be saved, and names the reasons', () => {
    expect(() => parseVoiceProfilesResponse(JSON.stringify({ profiles: [
      profile('未知角色', 'char-9', ['x']),
    ] }), roster, prose)).toThrow(/WRITING_INTELLIGENCE_VOICE_PROFILES_INVALID/)
  })
})
