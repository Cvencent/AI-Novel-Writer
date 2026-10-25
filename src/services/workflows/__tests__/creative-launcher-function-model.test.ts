import { describe, expect, it } from 'vitest'
import { FUNCTION_MODEL_KEYS } from '../../../shared/function-models'
import {
  functionModelKeyForWorkflow,
  resolveLaunchGenerationModelId,
  type CreativeWorkflowName,
} from '../creative-workflow-launcher'

const WORKFLOWS: readonly CreativeWorkflowName[] = [
  'generate_draft', 'review', 'refine', 'finalize', 'generate_blueprint',
  'generate_architecture', 'generate_arc_outline', 'review_arc_outline',
  'review_outline', 'review_blueprints',
]

describe('workflow to function-model mapping', () => {
  it('maps every creative workflow to a designed function key', () => {
    for (const workflow of WORKFLOWS) {
      expect(FUNCTION_MODEL_KEYS).toContain(functionModelKeyForWorkflow(workflow))
    }
  })

  it('uses the designed keys', () => {
    expect(functionModelKeyForWorkflow('generate_arc_outline')).toBe('outline_generation')
    expect(functionModelKeyForWorkflow('generate_architecture')).toBe('synopsis_generation')
    expect(functionModelKeyForWorkflow('generate_blueprint')).toBe('blueprint_generation')
    expect(functionModelKeyForWorkflow('generate_draft')).toBe('draft_generation')
    expect(functionModelKeyForWorkflow('review_arc_outline')).toBe('outline_review')
    expect(functionModelKeyForWorkflow('review_outline')).toBe('synopsis_review')
    expect(functionModelKeyForWorkflow('review_blueprints')).toBe('blueprint_review')
    expect(functionModelKeyForWorkflow('review')).toBe('draft_review')
    expect(functionModelKeyForWorkflow('refine')).toBe('draft_generation')
    expect(functionModelKeyForWorkflow('finalize')).toBe('draft_generation')
  })
})

describe('resolveLaunchGenerationModelId', () => {
  const intent = { workflow: 'review_outline' as const, range: { from: 1, to: 2 } }
  const resolver = (key: string) => (key === 'synopsis_review' ? 'fn-model' : null)

  it('keeps an explicit caller-provided model', () => {
    expect(resolveLaunchGenerationModelId(intent, { generationModelId: ' explicit ' }, resolver)).toBe('explicit')
  })

  it('resolves the function model for UI launches without an explicit model', () => {
    expect(resolveLaunchGenerationModelId(intent, {}, resolver)).toBe('fn-model')
  })

  it('suppresses injection for agent-registered launches', () => {
    expect(resolveLaunchGenerationModelId(intent, { agentToolAction: { workflow: 'review_outline' } as never }, resolver)).toBeUndefined()
  })

  it('yields undefined when nothing resolves', () => {
    expect(resolveLaunchGenerationModelId(intent, {}, () => null)).toBeUndefined()
  })
})
