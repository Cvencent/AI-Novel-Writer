# 蓝图重构 + AI 检查 —— 任务拆分与分配

> 本文档由上一个会话整理，供新会话直接执行，**不需要重新探索代码库**。
> 所有「现状」事实均已查证（含文件路径与行为）。

## 0. 背景

### 0.1 当前四层链路

| 层 | 存储 | 现状 |
|---|---|---|
| 粗纲 | `arc_outlines` 表 | 20 段 / 34517 字（每段管 120–200 章）|
| 细纲 | `project_core.synopsis`（单块 Markdown）| 270 章，格式不稳 |
| 蓝图 | `blueprints` 表（每章一行）| **0 条（从未生成）** |
| 正文 | `drafts` + `contents` | — |

细纲格式实测分布（270 章统计）：六小节齐全 145 / 只有部分 47 / 完全自由文本 78；提到「人物关系」仅 22 章。

### 0.2 关键文件（新会话直接读这些）

- 细纲引擎：`src/services/workflows/commands/architecture.command.ts`（`GeneratePlotArchitectureCommand`，**逐章**）
- 细纲契约：`src/shared/plot-outline-contract.ts`
  - 游标 `derivePlotOutlineCursor`、请求合同 `plotOutlineRequestContract`
  - 粗纲注入 `chapterOutlineArcDirective`、结构校验 `validPlotOutlineEntry`
  - 日记体检测 `isLedgerStyleOutline`
- 细纲连续生成：`src/services/workflows/continuous-outline-runner.ts`
- 蓝图命令：`src/services/workflows/commands/directory.command.ts`（`GenerateDirectoryCommand`，**批量+文本解析**）
- 蓝图仓储：`electron/repositories/blueprint-repository.ts`（`commitRange` / `upsert` / `getAll`）
- 蓝图语义契约：`src/shared/blueprint-semantic-contract.ts`（**已含 `relationships` + `newCharacterCandidates`**）
- 工具循环：`src/services/workflows/tool-loop.ts` + `base-command.ts` 的 `callLLMWithTools`
- 守卫：`src/services/workflow-guards.ts`（`guardDirectoryGeneration` / `guardChapterWriting`）
- 审稿建议卡片 UI：`src/components/stage/chapter/ReviewSheet.tsx`
- 审稿 findings 表：`review_findings`（列：`problem_text` / `expected_text` / `span_start` / `span_end` / `status` / `category` / `excerpt_hash`）
- 架构节定义：`src/services/architecture-step-selection.ts`（5 节：premise/characters/worldbuilding/arc/synopsis）

## 2. 任务拆分

共 6 个工作包。WP1-WP3 是一条依赖链，必须按序；WP4-WP6 相互独立，可并行。

| 包 | 名称 | 依赖 | 建议会话 | 预估 |
|---|---|---|---|---|
| WP1 | 细纲格式锁死 | 无 | 会话A（先做） | 中 |
| WP2 | 蓝图派生引擎 | WP1 | 会话A（续） | 大 |
| WP3 | 滚动流程与守卫 | WP2 | 会话A（续） | 中 |
| WP4 | AI检查-细纲 | WP1 | 会话B（并行） | 中 |
| WP5 | AI检查-粗纲 | 无 | 会话B（并行） | 中 |
| WP6 | AI检查-蓝图与正文 | WP2 | 会话C（并行） | 大 |

---

## WP1 — 细纲格式锁死

**目标**：让每章细纲必须带固定小节，派生蓝图才可靠。

**现状问题**：270 章里 145 章六小节齐全 / 47 章部分 / 78 章自由文本。

**要做**：
1. 在 `plot-outline-contract.ts` 的**准入闸门**（`derivePlotOutlineCursor`）强制要求每章含固定小节。
   - 小节目录：`场景与出场人物` / `本章目标` / `阻力与升级` / `转折与代价` / `结尾钩子` / `伏笔`
2. 在 `plotOutlineRequestContract` 里把小节格式写成**硬性输出格式**（现在只是散文描述）。
3. 与 `isLedgerStyleOutline` 不冲突（日记体检测仍只在准入闸门）。

**注意**：
- 结构校验**用于读取历史**，所以对旧数据要宽松：**只对新产出强制**。
- **这就是 1.5.28 修过的那个坑**（新增规则误伤历史数据），别再踩一次。

**验收**：新生成的每章都含 6 个小节；历史数据仍可读（回归测试）。

---

## WP2 — 蓝图派生引擎（核心）

**目标**：蓝图从细纲**派生**（不重新规划），逐章生成，写进 `blueprints` 表，带工具能力。

**要做**：
1. **数据库加列**：`blueprints` 表新增 `costs_and_turns`、`foreshadowing`
   - 迁移放 `electron/migrations/baseline-blueprint-schema.ts`
   - 同步 `BlueprintRow` / `BlueprintData`（驼峰 `costsAndTurns` / `foreshadowing`）
2. **改生成方式**：`GenerateDirectoryCommand` 改为**逐章**（复用细纲引擎模式）
   - 复用：工具循环（`callLLMWithTools`）、粗纲注入（`chapterOutlineArcDirective`）、按章游标、连续生成
   - 暴露工具：`read_characters` / `create_character` / `update_character` / `delete_character` / `search_knowledge` / `read_architecture`
   - **输入改为「本章细纲原文」+「所属粗纲段」+「核心大纲」**，而不是从架构重新推演
3. **输出改为结构化蓝图**（保留现有 `relationships` / `newCharacterCandidates` 能力）
4. **每章一次模型调用**，产出写入 `blueprints` 表

**关键参考（别重写）**：
- `src/shared/blueprint-semantic-contract.ts` **已有** `relationships`（from/to/relation）和 `newCharacterCandidates`（自动建角色卡）——派生时直接复用
- 细纲引擎已经把「游标 / 工具轮次排除 / 合成算法」都修好了，照搬即可

**验收**：
- 给一段细纲（如 1–10 章），能逐章产出蓝图并落库
- 蓝图含 8 个字段，`relationships` 能自动同步角色关系

---

## WP3 — 滚动流程与守卫

**目标**：实现「写 200 章 → 蓝图 200 章 → 写正文 200 章」的滚动，不要全书齐全。

**要做**：
1. 修 `guardDirectoryGeneration`（`workflow-guards.ts`）：现在缺细纲会 push 到 `missing` 并**警告**。改成：**只要求「要生成的这一段」的细纲存在**
2. 修 `guardChapterWriting`：确认只依赖**本章蓝图**（现在已是如此，加测试固化）
3. 架构页 5 节处理：**与用户确认**是否保留细纲入口（细纲作为创作层要保留）
4. 「改蓝图不回溯」规则落地：新角色/关系写入**之后**的蓝图；已定稿正文对应的蓝图**只读**

**验收**：
- 只生成 1–200 章细纲 + 蓝图，就能写 1–200 章正文（无全书完整性警告）
- 201–400 章继续滚动时，前面已定稿的不被修改

---

## WP4 — AI 检查：细纲

**目标**：把生成的细纲（可选章节范围）交给 AI 检查，返回**可执行的建议卡片**，接受后替换原文并高亮。

**现状（重要，可复用）**：
- **正文已经有完整机制**：`review_findings` 表（列含 `problem_text` / `expected_text` / `span_start` / `span_end` / `status` / `category` / `excerpt_hash`）
- UI：`src/components/stage/chapter/ReviewSheet.tsx`（勾选 = 纳入修稿）
- 命令：`src/services/workflows/commands/review-chapter.command.ts` / `refine-from-review.command.ts`
- **这套"检查→建议→接受/不接受→复检"已经跑通，细纲检查应复用同一套数据形状，不要另造一套**

**要做**：
1. 新增细纲检查 Prompt（用户明确要你设计这个 Prompt）
2. 支持**章节范围选择**：`1–200` / `1–10` / 单章 / 任意区间
3. 检查维度（Prompt 里写清）：
   - 情节合理性（因果是否成立、有无逻辑跳跃）
   - 与粗纲方向是否一致（是否跑偏）
   - 与核心大纲/世界观是否冲突
   - 人物一致性（性格、动机、关系）
   - 伏笔与代价（是否兑现、有无断裂）
   - 节奏（是否流水账、连续同类型章节）
4. 产出**建议卡片**：每条含问题描述 + 原文引用 + 建议替换文本
5. 接受 → 替换原文 → **高亮显示改动处**，作者可看改后文案
6. 不接受 → 标记忽略，不写入

**验收**：选 1–10 章 → 得到建议卡片 → 接受一条 → 原文被替换且有高亮。

---

## WP5 — AI 检查：粗纲

**目标**：把 20 段粗纲交给 AI 做全局检查。

**要做**：
1. 新增粗纲检查 Prompt，检查：
   - 全局情节合理性（起承转合是否成立）
   - 三卷节奏锁是否被破坏（源起三层揭秘：悬念→错认→汇合）
   - 前后段是否重复、是否方向冲突
   - 伏笔铺收是否平衡
   - 与核心大纲/世界观是否一致
2. 复用 WP4 的建议卡片机制（同一套 findings 形状）
3. 接受 → 替换**粗纲段**（`arc_outlines.summary`）并高亮

**验收**：点检查 → 得到粗纲层面的建议 → 接受一条 → 该段粗纲被替换。

---

## WP6 — AI 检查：蓝图 + 正文

**目标**：蓝图和正文也各有检查入口（用户要求"每一个环节都要有 AI 检查"）。

**正文**：**已经存在**（`ReviewSheet` / `review-chapter.command.ts`）——只需确认入口齐全、范围可选、高亮可用。可能只需补一轮验收测试。

**蓝图**：需新建检查，复用 WP4/WP5 的机制，检查：
   - 8 个字段是否齐全、是否与细纲一致
   - `relationships` 是否与角色名单冲突
   - `costsAndTurns` / `foreshadowing` 是否与前后章连贯
   - `suspenseHook` 是否雷同

**验收**：蓝图检查能产出建议卡片并应用。

---

## 3. 会话分配建议

### 会话 A —— 架构重构主链（必须按序，不能并行）

执行 WP1 → WP2 → WP3。这条链改动同一批文件（`plot-outline-contract.ts` / `directory.command.ts` / `workflow-guards.ts` / 蓝图仓储），
并行会互相冲突。

**建议工具**：`writing-plans` 先出实施计划，`test-driven-development` 每个 WP 先写失败测试，`systematic-debugging` 遇到报错。

### 会话 B —— AI 检查（可与会话 A 并行）

执行 WP5（粗纲检查，无依赖）+ WP4 的 Prompt 设计部分（Prompt 可以先设计，等 WP1 落地格式后再接）。

WP5 完全不依赖 A，**建议先做 WP5 练手**，把"检查→建议卡片→接受→替换→高亮"这条链路在最小的目标（20 段粗纲）上跑通，
然后 WP4 直接复用。

### 会话 C —— 蓝图/正文检查（等 WP2）

执行 WP6。蓝图检查要等 WP2 的字段落地（`costsAndTurns` / `foreshadowing`），所以**排在 WP2 之后**。
正文检查已存在，可先做验收。

---

## 4. 并行冲突提示

| 文件 | 涉及 WP | 冲突风险 |
|---|---|---|
| `src/shared/plot-outline-contract.ts` | WP1、WP4 | 中：WP1 改格式，WP4 读格式 |
| `src/services/workflows/commands/directory.command.ts` | WP2、WP6 | 高：都会动蓝图 |
| `electron/repositories/blueprint-repository.ts` | WP2、WP6 | 高 |
| `src/services/workflow-guards.ts` | WP3 | 低 |
| `src/components/stage/chapter/ReviewSheet.tsx` | WP4、WP6 | 中：都要复用建议卡片 |

**结论**：改建议卡片（`ReviewSheet` 或其通用化版本）最好**只由一个会话负责**。
建议：会话 B 把卡片机制**抽成通用组件**，会话 C 只调用、不修改。

---

## 5. 当前代码里已经修好、不要重做的部分

这些是最近几个版本刚修完的，动手前先看，**别重复造轮子或改回去**：

| 能力 | 状态 | 位置 |
|---|---|---|
| 细纲逐章引擎（游标/续写/重试） | ✅ 已跑通 270 章 | `architecture.command.ts` |
| 工具循环（角色增删改查+知识库） | ✅ 已跑通，日志可见 | `tool-loop.ts` + `base-command.ts` |
| 粗纲注入（本段+全书索引） | ✅ 已修 | `chapterOutlineArcDirective` |
| 工具轮次不污染章节游标 | ✅ 已修 | `derivePlotOutlineCursor` 的 `isToolCallRound` |
| 日记体检测（只拦新产出） | ✅ 已修 1.5.28 | `isLedgerStyleOutline` + 准入闸门 |
| 模型新建角色自动分配 ID | ✅ 已修 1.5.27 | `assignCharacterIdForNewCard` |
| 角色工具注册（含 MCP 共存） | ✅ 已修 | `registerBuiltinTools` 幂等 |
| 蓝图已有 relationships / newCharacterCandidates | ✅ 本来就有 | `blueprint-semantic-contract.ts` |
| 正文审稿（检查→建议→接受） | ✅ 本来就有 | `ReviewSheet.tsx` / `review_findings` |

---

## 6. 待用户确认的开放问题

1. **架构页是否保留细纲入口**（WP3）——细纲作为创作层要保留，但架构页那一节是否还显示？
2. **蓝图为「派生」后，是否还允许作者手工编辑蓝图**？（现在蓝图页是可编辑的）
3. **AI 检查的接受方式**：是逐条接受，还是可以"全部接受"？
4. **检查结果是否持久化**（像 `review_findings` 那样存表，可复检），还是只做一次性？

---

## 7. 版本与发布

每个 WP 完成后：

1. `pnpm exec tsc --noEmit` / `pnpm run lint` / `pnpm run check:i18n`
2. 相关单测 + `pnpm run test:browser`（80 文件 958 项）
3. 升版本号、写 `.release/notes/vX.Y.Z.md`、`clean:build` → `prepare-native-for-electron` → `vite build` → `electron-builder --win --x64 --publish never`
4. `node scripts/verify-win-package.mjs`
5. commit / tag / `gh release create` / 部署到 `F:\aiNovel\ai-novel-writer`（先杀进程，copy app.asar，校验 SHA-256）

当前版本：**1.5.28**（最新 tag 与 release 都是它）

---

## 8. 《源起》项目现状（供测试）

- 项目路径：`F:\yuanqi\源起`，DB：`F:\yuanqi\源起\.ai-novel\project.db`
- 总章数 3000，每章 3000 字
- 角色名单：**9 人**（含沈砚）
- 粗纲：20 段（1–3000 章）全部 confirmed
- 细纲：270 章（**待清理**，用户认为质量不好）
- 蓝图：**0 条**
- 有 180 条脏运行记录（20 running + 160 paused）需清

**测试建议**：不要直接在《源起》上做大范围实验。可以新建一个小测试项目（如 30–50 章），验证通过再回到《源起》。


---

## 9. 用户已确认的决策（取代 §6 的开放问题）

1. **架构页是否保留细纲入口** → **保留**（细纲作为创作层保留，架构页仍显示入口）。
2. **蓝图是否允许作者手工编辑** → **可以**（蓝图页保持可编辑）。
3. **AI 检查的接受方式** → **逐条接受 + 全部接受都支持**。
4. **检查结果是否持久化** → **持久化**（复用 review_findings 形状，可复检）。

### 9.1 本次并行分工（已在执行）

| 工作包 | 执行者 | 理由 |
|---|---|---|
| WP1 → WP2 → WP3 | 主会话（串行） | 改同一批文件（plot-outline-contract / directory.command / blueprint-repository / workflow-guards），并行必冲突 |
| WP5 粗纲检查 | 子进程 1 | 零依赖；文件与主链不重叠 |
| 正文检查增强 | 子进程 2 | 检查机制已存在；只改 ReviewSheet 与正文审稿命令 |
| WP4 细纲检查 | 待 WP1 落地后再派 | 需要锁死后的细纲格式 |
| WP6 蓝图检查 | 待 WP2 落地后再派 | 需要 costsAndTurns / foreshadowing 字段 |

### 9.2 子进程文件边界（防冲突）

- 子进程 1（WP5）：可动 arc 相关文件 + 新建建议机制模块；**禁动** ReviewSheet.tsx / directory.command.ts / plot-outline-contract.ts / blueprint-repository.ts / workflow-guards.ts
- 子进程 2（正文检查）：可动 ReviewSheet.tsx 与正文审稿命令；**禁动** arc 相关 / directory.command.ts / plot-outline-contract.ts / blueprint-repository.ts / workflow-guards.ts
- 子进程不 bump 版本、不 commit / tag / release（由主会话统一发布）

