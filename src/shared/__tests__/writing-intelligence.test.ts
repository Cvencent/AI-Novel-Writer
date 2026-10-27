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