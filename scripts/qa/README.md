# QA 定时任务使用说明

两个定时任务共用这套基础设施。**共同红线：绝不读写用户自己的作品与配置。**

## 用户数据边界

| 位置 | 说明 | QA 能否碰 |
|---|---|---|
| `C:\Users\vencent\AppData\Roaming\ai-novel-writer` | 真机 Electron userData | ✗ 绝不 |
| `%APPDATA%\ai-novel-writer` | 全局配置/models.json | ✗ 绝不 |
| `F:\yuanqi\源起`、`F:\aiNovelWriter\.qa\*` 以外的任何作品目录 | 用户真实作品 | ✗ 只读，且只读**副本** |
| `F:\aiNovelWriter\repo\.qa\user-sim\run-*` | 模拟器隔离工作区 | ✓ 可读可写可删 |
| `F:\aiNovelWriter\repo\.runtime\qa\` | QA 报告 | ✓ 可写 |

## 1. 只读一致性检查 `scripts/qa/consistency-audit.mjs`

```bash
node scripts/qa/consistency-audit.mjs --project "<作品目录>" --json .runtime/qa/audit.json
```

- 先把 `.ai-novel/project.db`（连同 `-wal`/`-shm`）**拷到临时目录**，再用 `readOnly` 打开，物理上不可能写回。
- 抓的是**规则可证的硬冲突**：同一角色、同一属性（衣着颜色 / 身体状态）在不同章节出现互斥取值。
- 段落归属规则：段内点名 → 归最后被点名的角色；段内无名字但有「他身上/对方/穿着」→ 归上一段的人；两者都没有 → 丢弃（宁漏不误报）。
- 颜色必须与衣着词紧邻（前置定语或后置补语），否则「红色的实时通知」「指关节泛白」会被当成人物衣着。
- 另有 `cardIssues`：角色卡写了外貌但正文没体现、角色卡外貌为空（后续没有锚点）。
- 退出码：有硬冲突 = 1，仅角色卡问题/无问题 = 0。已用「源起」真实数据验证，能稳定抓出第 2 章「洗得泛白的风衣」→ 第 4 章「洗得泛黄」这一条，且不误报。

## 2. 模拟用户真写 `scripts/qa/user-sim.mjs`

```bash
node scripts/qa/user-sim.mjs --chapters=3 --words=700
```

- 用安装版 exe（`F:\aiNovel\ai-novel-writer\AI小说作家.exe`），每轮新建 `--work-root` 下的独立目录，重定向 `--user-data-dir`、`AI_NOVEL_APP_DATA_HOME`、`AI_NOVEL_LEGACY_SOURCE_HOME`、`HOME`、`USERPROFILE`、`LOCALAPPDATA`、`APPDATA`、`TEMP`。
- 模型固定 DeepSeek V4.1 Flash，走 `http://127.0.0.1:8790/v1`，key=`test_key`。
- 流程：新建作品 → 填设定 → 前提/世界观/角色 → 粗纲铺满 → 细纲 → 蓝图 → 逐章写正文 → 连续性抽取 → 第 1 章审稿定稿。
- 每步失败只记进报告不中断，末尾自动跑一遍一致性检查。报告默认 `.runtime/qa/user-sim-report.json`。
- 自动只保留最近 3 轮工作区。

## 已知通道风险

8790 代理对**全新长 prompt** 会挂起或 `ERR_CONNECTION_RESET`（见项目记忆 `e2e-deepseek-endpoint`）。模拟器因此把每步失败隔离，避免一个挂起毁掉整轮；找茬任务要把「挂起」本身也当成一条 issue 线索（区分「功能 bug」与「通道抖动」——挂起且代理日志显示账号耗尽/503 才是通道问题）。

## 建 issue 的去重

建之前必须 `gh issue list --state all --limit 100` 搜同主题，已有就评论补充证据而不是新建。