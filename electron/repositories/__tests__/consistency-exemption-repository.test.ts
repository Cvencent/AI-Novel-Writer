import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase } from '../../database'
import { openCanonicalProjectFixture as initProjectDatabase } from '../../../test/helpers/canonical-project-fixture'
import { ConsistencyAcknowledgementRepository, ConsistencyExemptionRepository } from '../consistency-exemption-repository'

let projectRoot = ''

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-consistency-exemption-'))
  initProjectDatabase(projectRoot)
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

describe('ConsistencyExemptionRepository', () => {
  it('persists only the stable fact key, reason, and revocation state', () => {
    ConsistencyExemptionRepository.save('open-thread:1:key', '刻意延后到第三章')
    expect(ConsistencyExemptionRepository.list()).toEqual([{
      stableFactKey: 'open-thread:1:key',
      reason: '刻意延后到第三章',
      revoked: false,
    }])

    ConsistencyExemptionRepository.revoke('open-thread:1:key')
    expect(ConsistencyExemptionRepository.list()[0]).toEqual({
      stableFactKey: 'open-thread:1:key',
      reason: '刻意延后到第三章',
      revoked: true,
    })
  })

  it('rejects an empty reason and can reactivate an existing stable key', () => {
    expect(() => ConsistencyExemptionRepository.save('open-thread:1:key', '  ')).toThrow()
    ConsistencyExemptionRepository.save('open-thread:1:key', '第一次原因')
    ConsistencyExemptionRepository.revoke('open-thread:1:key')
    ConsistencyExemptionRepository.save('open-thread:1:key', '新的原因')
    expect(ConsistencyExemptionRepository.list()).toEqual([{
      stableFactKey: 'open-thread:1:key', reason: '新的原因', revoked: false,
    }])
  })
})

describe('ConsistencyAcknowledgementRepository (issue #79)', () => {
  it('acknowledges a reminder once and is idempotent for the same cross-chapter stable key', () => {
    ConsistencyAcknowledgementRepository.acknowledge('prop:revival:票根')
    // 同一件事在后续章节重算出来仍是同一个 key：再 ack 不产生第二行。
    ConsistencyAcknowledgementRepository.acknowledge('prop:revival:票根')
    const rows = ConsistencyAcknowledgementRepository.list()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.stableFactKey).toBe('prop:revival:票根')
    expect(typeof rows[0]!.acknowledgedAt).toBe('string')
  })

  it('keeps acknowledgements separate from intentional arrangements', () => {
    // 这是本轮的核心区分：ack 表示「知道是真问题」，豁免表示「刻意为之」。
    // 混在一起会让「已保存安排」把缺点记成好事（#79 的第三段）。
    ConsistencyAcknowledgementRepository.acknowledge('a')
    expect(ConsistencyExemptionRepository.list()).toEqual([])
    ConsistencyExemptionRepository.save('b', '刻意这么写的')
    expect(ConsistencyAcknowledgementRepository.list().map(item => item.stableFactKey)).toEqual(['a'])
  })

  it('can unacknowledge so the reminder shows again', () => {
    ConsistencyAcknowledgementRepository.acknowledge('a')
    ConsistencyAcknowledgementRepository.unacknowledge('a')
    expect(ConsistencyAcknowledgementRepository.list()).toEqual([])
    // 撤销一个不存在的 key 不报错（幂等）。
    expect(() => ConsistencyAcknowledgementRepository.unacknowledge('missing')).not.toThrow()
  })

  it('rejects an empty stable key', () => {
    expect(() => ConsistencyAcknowledgementRepository.acknowledge('   ')).toThrow()
  })
})
