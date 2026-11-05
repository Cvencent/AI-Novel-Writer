/**
 * 预检提醒「为「徐汐」建卡」的落库动作（issue #160）。
 *
 * ## 为什么要单独成模块
 *
 * 这个动作必须**只建一张空卡**：姓名 + 定位（supporting）+ 一条备注写明「由写前预检建卡，
 * 内容待补」。判据不能替她编身份、动机、外貌——那些会直接进后续每一章的提示词，
 * 凭空生成的卡比缺卡更糟（#42 当时就是按这条理由只做可见性）。
 *
 * 走的是**唯一一条写通道**：读当前名单快照 → 追加一张卡 → `db:character-roster-commit`
 * （intent=manual_edit，带 expectedRevision 做 CAS）。与「新建角色」按钮、
 * `create_character` 工具同一条 seam，所以并发改名单时会被 CAS 挡住而不是静默覆盖。
 *
 * ## 为什么不复用角色 store 的 addCharacter
 *
 * `addCharacter` 只改内存里的草稿，要作者再点一次「保存」才落库；而预检这一刻作者
 * 正在写作弹层里，离开就意味着丢掉这次写作。所以这里**直接提交**，并把结果回传给
 * 调用方——建成了就把这一层重新读一遍，卡在名册里，正文里她就有落点了。
 */
import type { ProjectSessionContext } from '../shared/ipc-channels'
import type { CharacterRosterSnapshot } from '../shared/character-roster'
import type { CharacterData } from '../../electron/repositories/character-repository'
import { assignCharacterIdForNewCard, characterCardFromRosterEntry, characterRosterEntryFromCard } from './character-roster-client'
import { ipc } from './ipc-client'
import { randomUUID } from '../utils/id'
import { normalizeCharacterRole } from '../shared/character-role'

export interface CreateCharacterCardInput {
  /** 要建卡的角色名（必须非空；调用方负责保证它来自本轮判据）。 */
  name: string
  /** 建卡原因，写进卡片的 notes（供作者回看这张卡是怎么来的）。 */
  note: string
  /** 幂等键（同一轮重复点不应产生两张卡）。 */
  operationId?: string
}

export type CreateCharacterCardOutcome =
  | { status: 'created'; name: string; characterId: string }
  | { status: 'already-exists'; name: string }
  | { status: 'failed'; error: string }

/**
 * 按名字建一张空卡并落库。已存在同名角色时**不重复建**（返回 `already-exists`）。
 *
 * ⚠️ 名字比对用 `trim()` 后的原样比较（与 `create_character` 工具一致），不做大小写/别名归并：
 * 归并需要「这两个名字是不是同一个人」的判断，那是内容问题，不在这一步替作者决定。
 */
export async function createCharacterCardForPreflight(
  session: ProjectSessionContext,
  input: CreateCharacterCardInput,
): Promise<CreateCharacterCardOutcome> {
  const name = String(input.name ?? '').trim()
  if (!name) return { status: 'failed', error: '缺少角色名' }

  const snapshot = await ipc.invokeWithProjectSession(
    session, 'db:character-roster-read', session.projectPath,
  ) as CharacterRosterSnapshot
  const cards = snapshot.entries.map(characterCardFromRosterEntry)
  if (cards.some(card => card.name.trim() === name)) return { status: 'already-exists', name }

  const card: CharacterData = {
    name,
    role: normalizeCharacterRole('supporting'),
    gender: '', age: '', appearance: '', personality: '', background: '',
    abilities: '', motivation: '', relationships: '', arc: '',
    notes: input.note,
  }
  const createdId = `draft:${randomUUID()}`
  const withId = assignCharacterIdForNewCard(card, () => randomUUID())
  const result = await ipc.invokeWithProjectSession(session, 'db:character-roster-commit', {
    operationId: input.operationId ?? `preflight-create-character:${name}:${Date.now()}`,
    expectedRevision: snapshot.revision,
    expectedIdentityRevision: snapshot.identityRevision,
    schemaVersion: snapshot.schemaVersion,
    intent: 'manual_edit' as const,
    entries: [...cards, withId].map(characterRosterEntryFromCard),
  }, session.projectPath)
  if (!result?.success) {
    return { status: 'failed', error: String(result?.error ?? '角色名单提交被拒绝') }
  }
  const granted = (result.receipt?.created ?? []).find(item => item.selectionKey === withId.characterId)
  return { status: 'created', name, characterId: granted?.characterId ?? createdId }
}