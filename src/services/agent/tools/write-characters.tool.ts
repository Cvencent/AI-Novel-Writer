/**
 * create_character — 新增角色
 * update_character — 修改角色
 * delete_character — 删除角色
 *
 * 三个写入工具共用一条 seam：先读当前名单快照，改动后按
 * `db:character-roster-commit` 提交（intent=manual_edit），
 * 由主进程做闭包校验与事务提交。工作流里的细纲生成本轮由模型自主调用。
 */
import { buildAgentTool } from '../tool-registry'
import { ipc } from '../../ipc-client'
import { requireIpcSuccess } from '../../ipc-result'
import { agentToolText, assertAgentProjectCurrent, requireAgentProject } from './project-context'
import { characterCardFromRosterEntry, characterRosterEntryFromCard } from '../../character-roster-client'
import type { CharacterRosterSnapshot } from '../../../shared/character-roster'
import type { CharacterData } from '../../../../electron/repositories/character-repository'
import { CHARACTER_ROLES, type CharacterRole } from '../../../shared/character-role'

const CHARACTER_FIELDS = [
  'gender', 'age', 'appearance', 'personality', 'background',
  'abilities', 'motivation', 'relationships', 'arc', 'notes',
] as const

function isRole(value: unknown): value is CharacterRole {
  return typeof value === 'string' && (CHARACTER_ROLES as readonly string[]).includes(value)
}

async function readRoster(projectPath: string, session: Parameters<typeof ipc.invokeWithProjectSession>[0]) {
  const snapshot = await ipc.invokeWithProjectSession(session, 'db:character-roster-read', projectPath)
  return snapshot as CharacterRosterSnapshot
}

async function commitRoster(
  projectPath: string,
  session: Parameters<typeof ipc.invokeWithProjectSession>[0],
  snapshot: CharacterRosterSnapshot,
  operationId: string,
  cards: CharacterData[],
) {
  const result = await ipc.invokeWithProjectSession(session, 'db:character-roster-commit', {
    operationId,
    expectedRevision: snapshot.revision,
    expectedIdentityRevision: snapshot.identityRevision,
    schemaVersion: snapshot.schemaVersion,
    intent: 'manual_edit' as const,
    entries: cards.map(characterRosterEntryFromCard),
  }, projectPath)
  return requireIpcSuccess(result as { success: boolean; error?: string }, '提交角色名单')
}

export const createCharacterTool = buildAgentTool({
  name: 'create_character',
  description: '在角色名单里新增一个角色。当剧情需要新人物出场时调用。只需给出名字，其余字段可以后补。',
  descriptionEn: 'Add a new character to the roster. Call this when the plot needs a new character to appear. A name is enough; other fields can be filled later.',
  source: 'builtin',
  requiresConfirmation: false,
  // 写入工具：必须显式 false，否则 buildAgentTool 会按 requiresConfirmation 误标为只读。
  isReadOnly: false,
  inputSchema: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', description: '角色名（必填）', descriptionEn: 'Character name (required)' },
      role: { type: 'string', enum: [...CHARACTER_ROLES], description: '角色定位', descriptionEn: 'Character role' },
      gender: { type: 'string', description: '性别' }, age: { type: 'string', description: '年龄' },
      appearance: { type: 'string', description: '外貌' }, personality: { type: 'string', description: '性格' },
      background: { type: 'string', description: '背景' }, abilities: { type: 'string', description: '能力' },
      motivation: { type: 'string', description: '动机' }, relationships: { type: 'string', description: '人际关系（自由文本，如：与甲是同门）' }, arc: { type: 'string', description: '成长弧光' }, notes: { type: 'string', description: '备注' },
    },
  },
  execute: async (args, context) => {
    const { project, projectSession } = requireAgentProject(context)
    const text = (zhCN: string, enUS: string) => agentToolText(context, zhCN, enUS)
    const name = String(args.name ?? '').trim()
    if (!name) return { success: false, content: text('缺少角色名。', 'A character name is required.') }

    const snapshot = await readRoster(project.path, projectSession)
    assertAgentProjectCurrent(context)
    const cards = snapshot.entries.map(characterCardFromRosterEntry)
    if (cards.some(card => card.name.trim() === name)) {
      return { success: false, content: text(`角色「${name}」已存在，未重复创建。`, `Character "${name}" already exists; nothing was created.`) }
    }
    const card: CharacterData = {
      name,
      role: isRole(args.role) ? args.role : 'supporting',
      gender: '', age: '', appearance: '', personality: '', background: '',
      abilities: '', motivation: '', relationships: '', arc: '', notes: '',
    }
    for (const field of CHARACTER_FIELDS) {
      const value = args[field]
      if (typeof value === 'string' && value.trim()) card[field] = value.trim()
    }
    await commitRoster(project.path, projectSession, snapshot, `agent-create-character:${name}:${Date.now()}`, [...cards, card])
    assertAgentProjectCurrent(context)
    return { success: true, content: text(`已新增角色「${name}」。`, `Character "${name}" was added.`) }
  },
})

export const updateCharacterTool = buildAgentTool({
  name: 'update_character',
  description: '修改已有角色的资料或当前状态。角色改名也走这里（给 new_name）。',
  descriptionEn: 'Update an existing character\'s profile or current state. Renaming also goes through here (pass new_name).',
  source: 'builtin',
  requiresConfirmation: false,
  // 写入工具：必须显式 false，否则 buildAgentTool 会按 requiresConfirmation 误标为只读。
  isReadOnly: false,
  inputSchema: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', description: '要修改的角色名', descriptionEn: 'Character name to update' },
      new_name: { type: 'string', description: '改名后的新名字', descriptionEn: 'New name when renaming' },
      role: { type: 'string', enum: [...CHARACTER_ROLES], description: '角色定位' },
      gender: { type: 'string', description: '性别' }, age: { type: 'string', description: '年龄' },
      appearance: { type: 'string', description: '外貌' }, personality: { type: 'string', description: '性格' },
      background: { type: 'string', description: '背景' }, abilities: { type: 'string', description: '能力' },
      motivation: { type: 'string', description: '动机' }, relationships: { type: 'string', description: '人际关系（自由文本，如：与甲是同门）' }, arc: { type: 'string', description: '成长弧光' }, notes: { type: 'string', description: '备注' },
    },
  },
  execute: async (args, context) => {
    const { project, projectSession } = requireAgentProject(context)
    const text = (zhCN: string, enUS: string) => agentToolText(context, zhCN, enUS)
    const name = String(args.name ?? '').trim()
    if (!name) return { success: false, content: text('缺少角色名。', 'A character name is required.') }

    const snapshot = await readRoster(project.path, projectSession)
    assertAgentProjectCurrent(context)
    const cards = snapshot.entries.map(characterCardFromRosterEntry)
    const index = cards.findIndex(card => card.name.trim() === name)
    if (index < 0) {
      return { success: false, content: text(`没有找到角色「${name}」。`, `Character "${name}" was not found.`) }
    }
    const next = { ...cards[index]! }
    for (const field of CHARACTER_FIELDS) {
      const value = args[field]
      if (typeof value === 'string' && value.trim()) next[field] = value.trim()
    }
    if (isRole(args.role)) next.role = args.role
    const newName = String(args.new_name ?? '').trim()
    if (newName && newName !== name) next.name = newName
    cards[index] = next
    await commitRoster(project.path, projectSession, snapshot, `agent-update-character:${name}:${Date.now()}`, cards)
    assertAgentProjectCurrent(context)
    return { success: true, content: text(
      newName ? `已更新角色「${name}」并改名为「${newName}」。` : `已更新角色「${name}」。`,
      newName ? `Character "${name}" was updated and renamed to "${newName}".` : `Character "${name}" was updated.`,
    ) }
  },
})

export const deleteCharacterTool = buildAgentTool({
  name: 'delete_character',
  description: '从角色名单里删除一个角色。仅在该角色确认不再出现时调用。',
  descriptionEn: 'Remove a character from the roster. Call this only when the character will not appear again.',
  source: 'builtin',
  requiresConfirmation: false,
  // 写入工具：必须显式 false，否则 buildAgentTool 会按 requiresConfirmation 误标为只读。
  isReadOnly: false,
  inputSchema: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', description: '要删除的角色名', descriptionEn: 'Character name to delete' },
    },
  },
  execute: async (args, context) => {
    const { project, projectSession } = requireAgentProject(context)
    const text = (zhCN: string, enUS: string) => agentToolText(context, zhCN, enUS)
    const name = String(args.name ?? '').trim()
    if (!name) return { success: false, content: text('缺少角色名。', 'A character name is required.') }

    const snapshot = await readRoster(project.path, projectSession)
    assertAgentProjectCurrent(context)
    const cards = snapshot.entries.map(characterCardFromRosterEntry)
    const kept = cards.filter(card => card.name.trim() !== name)
    if (kept.length === cards.length) {
      return { success: false, content: text(`没有找到角色「${name}」。`, `Character "${name}" was not found.`) }
    }
    await commitRoster(project.path, projectSession, snapshot, `agent-delete-character:${name}:${Date.now()}`, kept)
    assertAgentProjectCurrent(context)
    return { success: true, content: text(`已删除角色「${name}」。`, `Character "${name}" was deleted.`) }
  },
})
