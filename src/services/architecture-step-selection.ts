/** 架构页五节，含粗纲。 */
export type ArchStepKey = 'premise' | 'characters' | 'worldbuilding' | 'arc' | 'synopsis'

/**
 * 「AI 生成架构」对话框能勾的节。粗纲有自己的分段生成流程（段长、确认模式、
 * 按段生细纲），不走这个一次性生成对话框，因此不在可选集合里。
 */
export type ArchGenerateStepKey = Exclude<ArchStepKey, 'arc'>

const ARCH_STEP_ORDER: ArchGenerateStepKey[] = ['premise', 'characters', 'worldbuilding', 'synopsis']

/** 架构五节的名字（中、英）。架构页、生成对话框、提交提示与单节文档标签共用这一张；名单页的图形视图叫「关系图谱」，不与名单混名。 */
export const ARCH_STEP_NAMES: Record<ArchStepKey, readonly [string, string]> = {
  premise: ['故事前提', 'Premise'],
  characters: ['角色名单', 'Cast'],
  worldbuilding: ['世界观', 'World'],
  arc: ['粗纲', 'Arc outline'],
  synopsis: ['细纲', 'Chapter outline'],
}

export function createDefaultArchitectureSelection(
  archStatus: Record<string, boolean>,
  initialSelectedSteps?: ArchGenerateStepKey[],
): Record<ArchGenerateStepKey, boolean> {
  const selected = new Set<ArchGenerateStepKey>()

  for (const step of ARCH_STEP_ORDER) {
    if (!archStatus[step]) selected.add(step)
  }

  if (initialSelectedSteps) {
    for (const step of initialSelectedSteps) {
      selected.add(step)
    }
  }

  return {
    premise: selected.has('premise'),
    characters: selected.has('characters'),
    worldbuilding: selected.has('worldbuilding'),
    synopsis: selected.has('synopsis'),
  }
}
