---
name: verify
description: 在真实 Electron 中驱动 AI 小说作家，按场景截图、记录启动耗时并读取只读诊断。前端重设计 RD-0 至 RD-10 每个 PR 的实机验证都走这里。用于「实机验证」「截图对比」「跑一下界面场景」。
---

# verify

驱动脚本是 `scripts/redesign/drive.mjs`。它用 Playwright 的 `_electron` 启动当前工作树的构建产物（`electron .`），每个场景一个全新的隔离目录，模型调用全部走本机假服务，不调用真实模型。

## 启动前

在要验证的工作树根目录依次运行：

```bash
pnpm install --frozen-lockfile
pnpm rebuild:electron
pnpm build
```

驱动加载的是 `dist/` 与 `dist-electron/`，改了 `src/` 或 `electron/` 必须重新 `pnpm build`。`better-sqlite3` 刚为 vitest 切到 Node ABI（`pnpm prepare:native-node`）时，先 `pnpm rebuild:electron` 再驱动。

## 命令

```bash
pnpm verify:drive -- --scenario <名称> [--theme light|dark] [--out <目录>] [--dump-dom] [--console] [--app-root <目录>]
# 等价于
node scripts/redesign/drive.mjs --scenario <名称> ...
```

- `--theme` 默认 `light`，即外观里的「浅色」；`dark` 为「深色」。
- `--out` 默认 `.runtime/redesign-baseline/`（已被 git 忽略）。
- `--app-root` 默认当前工作树。性能对照时指向 trunk 的工作树，用同一个驱动测两边；目标工作树也要先跑完上面三条命令，它加载的是自己的 `dist-electron/` 和 `better-sqlite3`。
- 退出码：0 全部通过；1 有场景失败、残留进程或隔离目录外写入；2 参数错误。

## 场景

| 名称 | 对应流程 | 截图停在 | 用夹具模型 |
|---|---|---|---|
| `new-project` | 新建作品 | 新作品的小说配置页 | 否 |
| `open-sample` | 打开示例作品 | 项目树显示第 1 章与草稿_v1 | 否 |
| `write-chapter` | 写作此章 | 草稿标签已打开，正文非空 | 是 |
| `review` | AI 审稿 | 审稿报告标签 | 是 |
| `revise-merge` | 按确认意见修稿并合并 | 修稿合并对话框；截图后点完成合并，等对话框关闭 | 是 |
| `finalize` | 定稿 | 已定稿（只读），AI 输出显示后处理完成 | 是 |
| `run-panel` | 打开运行面板（现为 AI 输出） | 重开作品后从右侧栏打开 AI 输出，显示一条持久运行 | 是 |
| `settings` | 打开设置 | 设置弹窗 | 否 |
| `baseline-all` | 依次跑上面 8 个场景 | 8 张截图 | |
| `startup-timing` | 只启动 | 不截图，输出启动耗时 | 否 |

示例作品名为「灯塔」，第 1 章「旧港」，由公开 IPC 预置后从书房打开。

## 输出

在 `--out` 目录下：

- `<场景>-<主题>.png`：场景截图，1440×900。
- `<场景>-<主题>.json`：本次运行的结果数组。每项含 `screenshot`、`timing`、`externalRequests`、`residualProcesses`、`externalWrites`、`isolationRoot`，用夹具模型的场景另含 `modelRequests`（假服务收到的全部请求数，嵌入请求也计入，与 `--console` 里的 `[fake-model]` 行一一对应），失败时含 `error`。
- 失败时额外写 `<场景>-<主题>.failure.png`、`.dom.html`、`.aria.yml`、`.console.log`，隔离目录保留以便排查。

每个场景结束后，驱动会检查三件事：以 `--user-data-dir` 匹配不到任何存活进程（`residualProcesses` 为空）；`~/.vela`、`%APPDATA%\ai-novel-writer`、`%APPDATA%\AI小说作家` 的最新修改时间不变（`externalWrites` 为空）；主进程 `fetch` 没有访问 `https://api.openai.com/v1/*` 以外的地址（`externalRequests` 为空）。

## 只读诊断

```bash
node scripts/redesign/drive.mjs --scenario open-sample --dump-dom --console --out <目录>
```

- `--dump-dom` 写 `<场景>-<主题>.dom.html`（`page.content()`）和 `.aria.yml`（Playwright 无障碍快照）。改页面对象前先看 `.aria.yml`，选择器优先用其中的角色与可访问名称。
- `--console` 写 `<场景>-<主题>.console.log`：渲染进程控制台、页面异常、主进程 stdout/stderr，以及假模型每次请求的分类（`[fake-model] prose|review|revision|character-state|embedding`）。

## 截图可重复性

同一场景连续跑三次再比较：

```bash
for i in 1 2 3; do node scripts/redesign/drive.mjs --scenario review --out shots/r$i; done
node scripts/redesign/pixel-diff.mjs shots/r1/review-light.png shots/r2/review-light.png shots/r3/review-light.png
```

`pixel-diff.mjs` 输出各张相对第一张的不同像素占比，`maxRatio` 小于 0.005 时退出码 0。任一通道差值超过 2 级才算不同像素（`ratio`），因为同一状态连续截图时，渲染器在背景模糊和渐变上偶发全屏 ±1～2 级抖动；逐字节比较的结果另列为 `strictRatio`，供判断差异是不是这种抖动。

## 启动耗时

`startup-timing` 的 `timing` 字段：`readyToShowToInteractiveMs`（主窗口 `ready-to-show` 到书房「新建作品」按钮可见，计划里的性能指标）、`launchToInteractiveMs`、`navigationToInteractiveMs`。`windowsAtAttach` 为 0 说明 `ready-to-show` 监听先于窗口创建挂上；不为 0 时 `readyToShowToInteractiveMs` 可能为 null，改看另外两项。trunk 与 head 交替各跑 5 次取中位数：

```bash
node scripts/redesign/drive.mjs --scenario startup-timing --app-root <trunk 工作树> --out <目录>
node scripts/redesign/drive.mjs --scenario startup-timing --out <目录>
```

## 改外壳时

类名选择器只出现在 `scripts/redesign/pages/`，按任务域分文件：`shell`（启动与外壳就绪）、`bookshelf`（书房）、`project`（项目树）、`chapter`（单章写作、审稿、修稿合并、定稿）、`run-panel`（运行面板）、`settings`（设置）。外壳替换后只改这些页面对象，场景 `scripts/redesign/scenarios.mjs` 不动。

`/.claude/` 在 `.gitignore` 里，提交本文件的改动要用 `git add -f .claude/skills/verify/SKILL.md`（或 `git add -u`）。假模型在 `scripts/redesign/fake-model.mjs`，按提示词特征返回正文、审稿 JSON、修稿正文或角色状态 JSON。
