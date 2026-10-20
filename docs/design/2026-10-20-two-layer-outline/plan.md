# 两层大纲（粗纲 + 细纲）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把单层逐章大纲拆成「粗纲（分段、无人名、模型判断段长）→ 细纲（逐章一段、有人名）」两层，并支持两层修改与对话式重生成。

**Architecture:** 粗纲存于新表 `arc_outlines`，按段记录区间、正文、beat 形态与修订号；章节到段的归属存于 `outline_segment_bindings`。细纲继续使用既有 `project_core.synopsis` 与其 CAS 校验，不换载体。粗纲改动只把受影响章节标记 `stale`，不直接改写细纲。

**Tech Stack:** TypeScript、React 19、Zustand、Electron（主进程 IPC）、better-sqlite3、Vitest。

**Spec:** `docs/design/2026-10-20-two-layer-outline/design.md`

## Global Constraints

- 粗纲正文**禁止出现任何角色名**，以 `characters` 名单做校验。
- 段长由模型判断，系统只给允许区间；默认下限 20 章、上限 200 章。
- beat 标签只能取自固定集合：`setup` | `escalation` | `reversal` | `low` | `climax` | `aftermath` | `transition`。
- 细纲延续既有格式：每章以 `## 第N章：标题` 开头，正文非空。
- 既有细纲 CAS 校验（`synopsis_db_hash`、`synopsis_facts_fingerprint`）与恢复稿机制不得破坏。
- 作者手改细纲即权威：不弹窗、不追问、不阻塞。
- 新增表采用仓库内懒建表模式（对照 `ensureBaselineBlueprintTables`），不新增迁移槽位。
- 中文界面文案与英文文案同时提供，通过 `useLocaleStore` 的 `text(zh, en)`。

## Review Focus

- **段长越界**：模型给出的段跨越范围外，或与上一段不连续 —— 必须拒绝并要求重出，不得静默接受。
- **粗纲出现人名**：模型把「林越」这类名字写进粗纲 —— 必须判不合格并触发重写，不得落库。
- **区间重叠**：同一章被两个粗纲段覆盖 —— 必须拒绝写入，不得产生重复归属。
- **编辑后的陈旧判定**：作者改粗纲第 i 段后，该段章节必须变 `stale`；未受影响的段必须保持 `fresh`，不得误伤。
- **细纲改动不被回退**：作者手改某章细纲后，任何粗纲操作都不得静默覆盖该章。

---

### Task 1: 粗纲数据层（表 + 仓库）

**Files:**
- Create: `electron/repositories/arc-outline-schema.ts`
- Create: `electron/repositories/arc-outline-repository.ts`
- Test: `electron/repositories/__tests__/arc-outline-repository.test.ts`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces:
  - `ensureArcOutlineTables(db: BetterSqlite3.Database): void`
  - `interface ArcOutlineRecord { id: number; arcIndex: number; fromChapter: number; toChapter: number; title: string; summary: string; beat: ArcBeat; status: ArcStatus; revision: number; createdAt: string; updatedAt: string }`
  - `type ArcBeat = 'setup' | 'escalation' | 'reversal' | 'low' | 'climax' | 'aftermath' | 'transition'`
  - `type ArcStatus = 'draft' | 'confirmed' | 'needs_regen'`
  - `class ArcOutlineRepository { static list(db?): ArcOutlineRecord[]; static save(input: { arcIndex: number; fromChapter: number; toChapter: number; title: string; summary: string; beat: ArcBeat }, db?): ArcOutlineRecord; static confirm(arcIndex: number, expectedRevision: number, db?): ArcOutlineRecord; static removeFrom(arcIndex: number, db?): number }`

- [ ] **Step 1: 写失败测试**

在 `electron/repositories/__tests__/arc-outline-repository.test.ts`，对照既有仓库测试的 fixture 风格（见 `electron/repositories/__tests__/blueprint-repository.test.ts` 的建库与 `setProjectDatabase` 用法）断言：

```ts
it('保存并按 arcIndex 列出粗纲段', () => { /* save 两段，list 返回 2 条且顺序正确 */ })
it('拒绝与已有段重叠的区间', () => { /* 已有 1-30，存 20-50 抛 ARC_OUTLINE_RANGE_OVERLAP */ })
it('拒绝不连续的区间', () => { /* 已有 1-30，存 40-60 抛 ARC_OUTLINE_RANGE_GAP */ })
it('confirm 使 revision+1 且 status=confirmed', () => { /* 断言 revision 与 status */ })
it('confirm 时 expectedRevision 不匹配抛 ARC_OUTLINE_REVISION_STALE', () => {})
it('removeFrom 删除该段及之后的所有段', () => {})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run electron/repositories/__tests__/arc-outline-repository.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 schema 与仓库**

`arc-outline-schema.ts` 导出一个函数，用 `db.exec` 执行建表（对照 `baseline-blueprint-schema.ts` 的写法）：

```sql
CREATE TABLE IF NOT EXISTS arc_outlines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  arc_index INTEGER NOT NULL UNIQUE CHECK(arc_index > 0),
  from_chapter INTEGER NOT NULL CHECK(from_chapter > 0),
  to_chapter INTEGER NOT NULL CHECK(to_chapter >= from_chapter),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  beat TEXT NOT NULL CHECK(beat IN ('setup','escalation','reversal','low','climax','aftermath','transition')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','confirmed','needs_regen')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_arc_outlines_index ON arc_outlines(arc_index);
```

`arc-outline-repository.ts` 用静态类，`save` 前在**同一事务内**读全部已有段做重叠与连续性校验：新区间必须紧接已有最大 `to_chapter`（或作为第一段从第 1 章开始）。错误码用固定大写字符串。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run electron/repositories/__tests__/arc-outline-repository.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add electron/repositories/arc-outline-schema.ts electron/repositories/arc-outline-repository.ts electron/repositories/__tests__/arc-outline-repository.test.ts
git commit -m "feat(arc): arc outline table and repository with range invariants"
```

---

### Task 2: 粗纲校验纯函数

**Files:**
- Create: `src/shared/arc-outline-contract.ts`
- Test: `src/shared/__tests__/arc-outline-contract.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ArcBeat`
- Produces:
  - `export const ARC_BEATS: readonly ArcBeat[]`
  - `export const ARC_MIN_CHAPTERS = 20`
  - `export const ARC_MAX_CHAPTERS = 200`
  - `export function validateArcSpan(from: number, to: number, totalChapters: number): { ok: true } | { ok: false; code: 'ARC_SPAN_TOO_SMALL' | 'ARC_SPAN_TOO_LARGE' | 'ARC_SPAN_OUT_OF_BOUNDS' }`
  - `export function findCharacterNames(text: string, characterNames: readonly string[]): string[]`
  - `export function validateArcNoProperNames(text: string, characterNames: readonly string[]): { ok: true } | { ok: false; found: string[] }`
  - `export function validateBeatDiversity(beat: ArcBeat, recentBeats: readonly ArcBeat[], window = 3): { ok: true } | { ok: false; code: 'ARC_BEAT_REPEATED' }`

- [ ] **Step 1: 写失败测试**

```ts
it('validateArcSpan 接受区间内跨度', () => { /* (1, 30, 3000) -> ok */ })
it('validateArcSpan 拒绝小于下限', () => { /* (1, 10, 3000) -> ARC_SPAN_TOO_SMALL */ })
it('validateArcSpan 拒绝大于上限', () => { /* (1, 500, 3000) -> ARC_SPAN_TOO_LARGE */ })
it('validateArcSpan 拒绝越界', () => { /* (1, 3001, 3000) -> ARC_SPAN_OUT_OF_BOUNDS */ })
it('findCharacterNames 找出正文中的角色名', () => { /* '林越进入学院' + ['林越'] -> ['林越'] */ })
it('findCharacterNames 不误判非角色子串', () => { /* 角色名不在正文时返回 [] */ })
it('validateArcNoProperNames 在有人名时不通过', () => {})
it('validateBeatDiversity 在最近 3 段同 beat 时不通过', () => {})
it('validateBeatDiversity 在 beat 不同时通过', () => {})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/shared/__tests__/arc-outline-contract.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

纯函数，无副作用。`findCharacterNames` 用 `String.prototype.includes` 逐名匹配并去重，返回命中的名字数组。`validateBeatDiversity` 在 `recentBeats.slice(-window)` 全等于该 beat 时判不合格。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/shared/__tests__/arc-outline-contract.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/shared/arc-outline-contract.ts src/shared/__tests__/arc-outline-contract.test.ts
git commit -m "feat(arc): span, proper-name and beat-diversity validators"
```

---

### Task 3: 段绑定表与陈旧判定

**Files:**
- Modify: `electron/repositories/arc-outline-schema.ts`
- Create: `electron/repositories/outline-segment-binding-repository.ts`
- Test: `electron/repositories/__tests__/outline-segment-binding-repository.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ensureArcOutlineTables`、`ArcOutlineRepository`
- Produces:
  - `type FineState = 'fresh' | 'stale'`
  - `class OutlineSegmentBindingRepository { static bindRange(chapterFrom: number, chapterTo: number, arcId: number, arcRevision: number, db?): number; static listStale(db?): number[]; static bindingFor(chapterNumber: number, db?): { chapterNumber: number; arcId: number; arcRevisionAtBuild: number; fineState: FineState } | null; static markStaleFrom(arcId: number, currentRevision: number, db?): number[] }`

- [ ] **Step 1: 写失败测试**

```ts
it('bindRange 为区间内每章写入归属', () => { /* (1,5,arcId=1,rev=0) -> 5 条 */ })
it('bindingFor 返回单章归属', () => {})
it('markStaleFrom 把 arcRevisionAtBuild 落后的章节标 stale', () => { /* 绑定 rev=0，传 currentRevision=1 -> 返回该批章号且 fineState=stale */ })
it('markStaleFrom 不动 revision 已最新的章节', () => { /* 绑定 rev=1，传 currentRevision=1 -> 返回 [] 且保持 fresh */ })
it('listStale 只返回 stale 章号', () => {})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run electron/repositories/__tests__/outline-segment-binding-repository.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

在 `arc-outline-schema.ts` 追加建表：

```sql
CREATE TABLE IF NOT EXISTS outline_segment_bindings (
  chapter_number INTEGER PRIMARY KEY CHECK(chapter_number > 0),
  arc_id INTEGER NOT NULL REFERENCES arc_outlines(id) ON DELETE CASCADE,
  arc_revision_at_build INTEGER NOT NULL CHECK(arc_revision_at_build >= 0),
  fine_state TEXT NOT NULL DEFAULT 'fresh' CHECK(fine_state IN ('fresh','stale'))
);
CREATE INDEX IF NOT EXISTS idx_outline_binding_arc ON outline_segment_bindings(arc_id);
```

`markStaleFrom` 只更新 `arc_id = :arcId AND arc_revision_at_build < :currentRevision` 且当前为 `fresh` 的行，返回被更新章号。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run electron/repositories/__tests__/outline-segment-binding-repository.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add electron/repositories/arc-outline-schema.ts electron/repositories/outline-segment-binding-repository.ts electron/repositories/__tests__/outline-segment-binding-repository.test.ts
git commit -m "feat(arc): chapter-to-arc bindings and stale derivation"
```

---

### Task 4: 粗纲 IPC 通道

**Files:**
- Modify: `src/shared/ipc-channels.ts`（在 `DatabaseChannels` 内加通道）
- Modify: `electron/controllers/db-controller.ts`（注册 handler）
- Test: `electron/controllers/__tests__/arc-outline-controller.test.ts`

**Interfaces:**
- Consumes: Task 1–3 的仓库
- Produces（通道契约，须与仓库类型一致）:
  - `'db:arc-outline-list': { args: [expectedProjectPath: string]; return: ArcOutlineRecord[] }`
  - `'db:arc-outline-save': { args: [input: ArcOutlineSaveInput, expectedProjectPath: string]; return: { success: boolean; record?: ArcOutlineRecord; error?: string } }`
  - `'db:arc-outline-confirm': { args: [arcIndex: number, expectedRevision: number, expectedProjectPath: string]; return: { success: boolean; record?: ArcOutlineRecord; error?: string } }`
  - `'db:arc-outline-stale-list': { args: [expectedProjectPath: string]; return: number[] }`

- [ ] **Step 1: 写失败测试**

对照 `electron/controllers/__tests__/db-controller-project-context.test.ts` 的注册与调用方式断言：四个通道都要求 `expectedProjectPath` 与会话匹配；save 成功返回 record；save 区间重叠返回 `{ success: false, error }`；stale-list 返回章号数组。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run electron/controllers/__tests__/arc-outline-controller.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

在 `ipc-channels.ts` 的 `DatabaseChannels` 中加四个通道声明（导入 `ArcOutlineRecord` 类型）。在 `db-controller.ts` 用既有的 `registerProjectDatabaseHandler` 注册，先调 `assertRequiredExpectedProjectPath`，再调仓库；把仓库抛出的错误转成 `{ success: false, error: String(error) }`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run electron/controllers/__tests__/arc-outline-controller.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/shared/ipc-channels.ts electron/controllers/db-controller.ts electron/controllers/__tests__/arc-outline-controller.test.ts
git commit -m "feat(arc): project-scoped IPC channels for arc outline"
```

---

### Task 5: 粗纲生成命令

**Files:**
- Create: `src/services/workflows/commands/arc-outline.command.ts`
- Test: `src/services/workflows/commands/__tests__/arc-outline.command.test.ts`

**Interfaces:**
- Consumes: Task 2 的校验函数、Task 4 的 IPC 通道、既有 `BaseWorkflowCommand`（`src/services/workflows/commands/base-command.ts`）
- Produces:
  - `export class GenerateArcOutlineCommand extends BaseWorkflowCommand<string> { constructor(snapshot: ArchitectureProjectSnapshot, options?: { targetArcCount?: number }); execute(params: CommandExecuteParams): Promise<string> }`
  - 输出契约（写在提示词里并要求模型返回纯文本）：每个粗纲段一个块，格式
    ```
    ## 第{from}–{to}章：{标题}
    beat: {beat}
    {正文，不含任何人名}
    ```

- [ ] **Step 1: 写失败测试**

对照 `src/services/workflows/commands/__tests__/plot-outline-batch.command.test.ts` 的 harness 风格（stub `useLLMStore.generateStream`、stub `window.aiNovelAPI.invoke`），断言：

```ts
it('生成的粗纲落在允许区间内且不含人名', () => { /* 模型返回合规文本 -> 返回文本，且调用 db:arc-outline-save */ })
it('粗纲出现角色名时判不合格并要求重出', () => { /* 模型返回含 '林越' -> 抛错，不落库 */ })
it('段长越界时判不合格', () => { /* 返回 1-5 章 -> 抛错 */ })
it('请求失败时把已完成段保留在检查点', () => { /* 模拟网络失败 -> 抛可恢复错误，检查点含已完成段 */ })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/services/workflows/commands/__tests__/arc-outline.command.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

仿照 `GeneratePlotArchitectureCommand` 的结构：解析项目事实（前提、世界观、总章数）、解析角色名单（**仅用于人名校验，不注入提示词**）、取已完成粗纲段作为上下文、要求模型给出下一段、对返回值依次跑 `validateArcSpan` / `validateArcNoProperNames` / `validateBeatDiversity`，全部通过才落库。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/services/workflows/commands/__tests__/arc-outline.command.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/services/workflows/commands/arc-outline.command.ts src/services/workflows/commands/__tests__/arc-outline.command.test.ts
git commit -m "feat(arc): arc outline generation command with validation gates"
```

---

### Task 6: 细纲按粗纲段生成

**Files:**
- Modify: `src/services/workflows/commands/architecture.command.ts`（`GeneratePlotArchitectureCommand`）
- Test: `src/services/workflows/commands/__tests__/plot-outline-batch.command.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 3 的绑定仓库、Task 5 的粗纲
- Produces: `GeneratePlotArchitectureCommand` 新增可选构造参数 `arcContext?: { arcId: number; rev: number; from: number; to: number; summary: string; beat: ArcBeat }`

- [ ] **Step 1: 写失败测试**

在既有测试文件追加：

```ts
it('细纲生成注入所属粗纲段全文', () => { /* 断言 prompt 含粗纲 summary */ })
it('细纲生成完成后写入弧段绑定', () => { /* 断言调用 bindRange(from,to,arcId,rev) */ })
it('无粗纲上下文时保持既有行为', () => { /* 不传 arcContext -> 与既有用例一致，不写绑定 */ })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/services/workflows/commands/__tests__/plot-outline-batch.command.test.ts`
Expected: 新增三条 FAIL，既有用例仍 PASS

- [ ] **Step 3: 实现**

在 `executeWithinGeneration` 装配 `taskPrompt` 处，当传入 `arcContext` 时把粗纲段全文与相邻段摘要加入提示词；批次成功提交后调用 `bindRange`。**不改动**既有 CAS、恢复稿、连续生成逻辑。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/services/workflows/commands/__tests__/plot-outline-batch.command.test.ts`
Expected: PASS（含既有全部用例）

- [ ] **Step 5: 提交**

```bash
git add src/services/workflows/commands/architecture.command.ts src/services/workflows/commands/__tests__/plot-outline-batch.command.test.ts
git commit -m "feat(arc): chapter outline consumes its arc segment and records binding"
```

---

### Task 7: 修改传递规则

**Files:**
- Create: `src/shared/arc-outline-propagation.ts`
- Test: `src/shared/__tests__/arc-outline-propagation.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `FineState`
- Produces:
  - `export interface PropagationPlan { staleChapters: number[]; arcsNeedingRegen: number[] }`
  - `export function planArcEditPropagation(editedArcIndex: number, arcs: readonly { arcIndex: number; revision: number; status: ArcStatus }[], bound: readonly { chapterNumber: number; arcRevisionAtBuild: number }[]): PropagationPlan`
  - `export function planChapterEditPropagation(chapterNumber: number): { touchesArc: false }`

- [ ] **Step 1: 写失败测试**

```ts
it('改粗纲第 i 段只影响归属该段的章节', () => { /* 断言 staleChapters 恰为该段章节 */ })
it('改粗纲不影响其他段的章节', () => {})
it('后续段标记 needs_regen', () => { /* arcIndex > i 的段进 arcsNeedingRegen */ })
it('改细纲章不触发粗纲改动', () => { /* planChapterEditPropagation 返回 touchesArc:false */ })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/shared/__tests__/arc-outline-propagation.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

纯函数：只做区间归属与修订号比较，不访问数据库。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/shared/__tests__/arc-outline-propagation.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/shared/arc-outline-propagation.ts src/shared/__tests__/arc-outline-propagation.test.ts
git commit -m "feat(arc): propagation planning for arc and chapter edits"
```

---

### Task 8: 架构页粗纲面板

**Files:**
- Create: `src/components/stage/architecture/ArcOutlinePanel.tsx`
- Modify: `src/components/stage/architecture/StageArchitecture.tsx`
- Modify: `src/components/stage/architecture/architecture.css`
- Test: `src/components/stage/architecture/__tests__/ArcOutlinePanel.browser.tsx`

**Interfaces:**
- Consumes: Task 4 的 IPC 通道
- Produces: `export default function ArcOutlinePanel({ projectKey }: { projectKey: string })`

- [ ] **Step 1: 写失败测试**

对照 `src/components/stage/knowledge/__tests__/knowledge.browser.tsx` 的 renderer 测试风格（stub `window.aiNovelAPI.invoke`），断言：

```tsx
it('列出已确认粗纲段与章数区间', () => {})
it('显示两个按钮：等我确认 / 跳过确认', () => { /* 断言两个按钮都在 */ })
it('点击等我确认后显示等待确认状态', () => {})
it('存在 stale 章节时显示需要重生成的提示与章号', () => {})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/components/stage/architecture/__tests__/ArcOutlinePanel.browser.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

面板列出粗纲段（区间、标题、beat、状态、正文摘要），顶部两个按钮控制生成模式（`waitConfirm` / `skipConfirm`），存在 `stale` 章节时列出版本差异提示。挂到 `StageArchitecture.tsx` 的 `arch-sections` 上方，与 `ContinuousOutlinePanel` 并列。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/components/stage/architecture/__tests__/ArcOutlinePanel.browser.tsx`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/components/stage/architecture/ArcOutlinePanel.tsx src/components/stage/architecture/StageArchitecture.tsx src/components/stage/architecture/architecture.css src/components/stage/architecture/__tests__/ArcOutlinePanel.browser.tsx
git commit -m "feat(arc): arc outline panel with confirm/skip modes"
```

---

### Task 9: 对话式重生成入口

**Files:**
- Create: `src/components/stage/architecture/ArcReviseDialog.tsx`
- Modify: `src/components/stage/architecture/ArcOutlinePanel.tsx`
- Test: `src/components/stage/architecture/__tests__/ArcReviseDialog.browser.tsx`

**Interfaces:**
- Consumes: Task 7 的 `planArcEditPropagation`、Task 5 的生成命令
- Produces: `export default function ArcReviseDialog({ projectKey, scope, onDone }: { projectKey: string; scope: { kind: 'arc'; arcIndex: number } | { kind: 'from-chapter'; chapterNumber: number }; onDone: () => void })`

- [ ] **Step 1: 写失败测试**

```tsx
it('输入方向后展示受影响章号清单', () => { /* 断言列出章号 */ })
it('确认后触发重生成', () => {})
it('取消时不发起生成', () => {})
it('覆盖前调用处保留可恢复版本', () => { /* 断言调用了恢复稿保存通道 */ })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/components/stage/architecture/__tests__/ArcReviseDialog.browser.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

对话框接收自然语言方向，调 `planArcEditPropagation` 得到影响范围并先展示，确认后才发起重生成；重生成前写入可恢复版本。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/components/stage/architecture/__tests__/ArcReviseDialog.browser.tsx`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/components/stage/architecture/ArcReviseDialog.tsx src/components/stage/architecture/ArcOutlinePanel.tsx src/components/stage/architecture/__tests__/ArcReviseDialog.browser.tsx
git commit -m "feat(arc): dialogue-driven arc revision with impact preview"
```

---

## 验证

全部任务完成后，端到端验证（对应设计文档 12.1／12.2，每项只做一两次）：

1. 新建 30–50 章测试小说，生成粗纲 → 确认无人名、段长在区间内、beat 不重复。
2. 两种确认模式各跑一次。
3. 生成一段细纲 → 确认逐章一段、人名来自名单、绑定已写入。
4. 改粗纲段 → 确认对应章节变 `stale`、其他段不受影响。
5. 改细纲一章 → 确认不弹窗、直接保留。
6. 对话式「从第 X 章之后重来」→ 确认影响范围正确。

## 后续计划（不在本计划范围）

- **计划二**：连贯性接线（章节摘要、线索生命周期、角色状态、知识边界、一致性校验）。
- **计划三**：日志页（设置旁的平级入口、调用列表／单次详情／工具汇总）。
- **计划四**：存量项目回填与漂移报告（延后）。
