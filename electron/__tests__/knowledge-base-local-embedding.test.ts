import { prepareCanonicalStorageFixture } from '../../test/helpers/canonical-project-fixture'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

beforeAll(() => { fs.mkdirSync(path.join(process.cwd(), '.runtime', '.cache'), { recursive: true }) })

const { generateEmbeddingsMock } = vi.hoisted(() => ({
  generateEmbeddingsMock: vi.fn(),
}))

vi.mock('../embedding', () => ({
  chunkText: (text: string) => [text],
  generateEmbeddings: generateEmbeddingsMock,
}))

import {
  backfillVectors,
  captureWritingKnowledgeSnapshot,
  importText,
  searchKnowledge,
} from '../knowledge-base'
import { closeConnection } from '../vector-store'
import { removeDirectoryWithWindowsRetry } from '../utils/remove-directory'

/**
 * 本机检索模型（Ollama、llama.cpp、LM Studio）不需要 API Key。
 * 以前这些路径用 `model.apiKey` 的真值判断要不要生成向量，空 Key 会静默降级全文检索，
 * 「本机模型能用」在界面上成立、实际却从不走向量。
 */
describe('本机检索模型免 API Key', { timeout: 30_000 }, () => {
  const projects: string[] = []
  const localModel = { provider: 'custom', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', modelName: 'nomic-embed-text' }
  const cloudModel = { provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: '   ', modelName: 'text-embedding-3-small' }

  const project = () => {
    const projectPath = fs.mkdtempSync(path.join(path.resolve('.runtime/.cache'), 'ai-novel-kb-keyless-'))
    projects.push(projectPath)
    prepareCanonicalStorageFixture(projectPath)
    return projectPath
  }

  afterEach(async () => {
    generateEmbeddingsMock.mockReset()
    for (const projectPath of projects.splice(0)) {
      closeConnection(projectPath)
      await removeDirectoryWithWindowsRetry(projectPath)
    }
  })

  it('imports vectors for a loopback endpoint without a key', async () => {
    generateEmbeddingsMock.mockResolvedValue([[0.1, 0.2, 0.3]])
    const projectPath = project()

    await expect(importText('夜航的灯塔。', 'Chapter 1.txt', projectPath, 'openai', localModel)).resolves.toMatchObject({ success: true })
    expect(generateEmbeddingsMock).toHaveBeenCalled()
  })

  it('still keeps a key-required cloud endpoint on the FTS-only path', async () => {
    generateEmbeddingsMock.mockResolvedValue([[0.1, 0.2, 0.3]])
    const projectPath = project()

    await expect(importText('夜航的灯塔。', 'Chapter 1.txt', projectPath, 'openai', cloudModel)).resolves.toMatchObject({ success: true })
    expect(generateEmbeddingsMock).not.toHaveBeenCalled()
  })

  it('embeds the retrieval query for a keyless local endpoint', async () => {
    generateEmbeddingsMock.mockResolvedValue([[0.1, 0.2, 0.3]])
    const projectPath = project()

    await captureWritingKnowledgeSnapshot('灯塔', projectPath, { protocol: 'openai', model: localModel })
    expect(generateEmbeddingsMock).toHaveBeenCalledWith(
      ['灯塔'], 'openai', expect.objectContaining({ baseUrl: localModel.baseUrl }), undefined,
    )

    generateEmbeddingsMock.mockClear()
    await searchKnowledge('灯塔', projectPath, 'openai', localModel)
    expect(generateEmbeddingsMock).toHaveBeenCalled()
  })

  it('rebuilds an index for a keyless local endpoint instead of refusing as unconfigured', async () => {
    generateEmbeddingsMock.mockResolvedValue([[0.1, 0.2, 0.3]])
    const projectPath = project()
    await importText('夜航的灯塔。', 'Chapter 1.txt', projectPath, 'openai', { ...localModel, apiKey: '' })

    await expect(backfillVectors(projectPath, 'openai', localModel)).resolves.toMatchObject({ success: true })
    expect(generateEmbeddingsMock).toHaveBeenCalled()
  })
})