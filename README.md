# mattpocock-skills-expand

基于 [mattpocock/skills](https://github.com/mattpocock/skills) 扩展的技能集合。多个 Issue 的实施委派给子代理；小且低风险的单 Issue 可由主代理直接实施。最终评审及用户确认的修复始终由主代理完成。

## 技能列表

| 技能 | 说明 |
|------|------|
| [execute-mattpocock-spec](./skills/execute-mattpocock-spec/SKILL.md) | 全自动执行 MattPocock Spec，按 frontier 层级逐层分派 Issue 实施子代理（层内并行），由主代理完成最终双轴 `code-review` 和确认的修复 |

## execute-mattpocock-spec

自动判断 Spec 是否已被 `to-tickets` skill 拆分为多个 Ticket：
- **已拆分：** 按 frontier 层级逐层分派子代理（层内并行），每个子代理加载 `implement` skill 实施对应 Ticket
- **未拆分：** 按复杂度自动选择。内容不超过 1000 字符、工作项不超过 2 条且不涉及高风险领域的单 Ticket，由主代理直接实施；其余委派单个子代理执行 `implement` skill

多 Ticket 一律由子代理实施；单 Ticket 的 `execution_mode` 则按内容长度、工作项数量和高风险领域词自动写入 Plan。主代理只在自动判定为低复杂度的单 Ticket 中直接实施。最终双轴 `code-review` 与用户确认的评审修复必须由主代理在 feature worktree 中完成。每个 Spec 只有一个 `feat/{feature-slug}` worktree，且它只承载实现代码。主代理在 `main` 更新 Issue 复选框、不可变 `plan.json` 和可变 `checkpoint.json`，待全部 Ticket 完成、最终 `code-review` 通过并完成整合清理后，由 `git-commit` 生成贴合实际变更的提交信息后统一提交。Execution Coordinator 将这些主仓库记录、worktree 生命周期和 Completion Adapter 串成可恢复流程。`execution_mode: coordinator` 通过注入的 `directExecutor` 返回相同的 Completion Result；`delegated` 则由 Completion Adapter 注入 Codex/Claude 或 OpenCode 的原生 spawn/collect capability。没有 capability 时后者返回结构化 blocked 结果。

> 示例：一个 Spec 拆分成 5 个 Ticket，01 blocked_by 空，02 blocked_by 01，03/04 blocked_by 02，05 blocked_by 03/04。
> - Level 0（01）→ 委派子代理 → 完成
> - Level 1（02）→ 委派子代理 → 完成
> - Level 2（03、04）→ 同时委派两个子代理 → 全部完成
> - Level 3（05）→ 委派子代理 → 完成
> - 主代理对整个 Spec 做最终双轴 `code-review`；若用户确认修复项，主代理直接修复并重新评审

## 安装

### skills.sh（推荐）

```bash
npx skills@latest add hengboy/mattpocock-skills-expand
```

安装器必须同时安装 `skills/execute-mattpocock-spec/package.json` 和 `package-lock.json`，然后在该目录执行：

```bash
npm run check:runtime
```

不要只安装 `ajv` 和 `ajv-formats`；锁文件会同时恢复 AJV 的全部传递依赖。

### 手动安装

```bash
# 克隆到本地
git clone git@github.com:hengboy/mattpocock-skills-expand.git

# 安装并检查 skill 的锁定运行时依赖
(cd mattpocock-skills-expand/skills/execute-mattpocock-spec && npm run check:runtime)

# 链接到 agents 技能目录
ln -s $(pwd)/mattpocock-skills-expand/skills/execute-mattpocock-spec ~/.agents/skills/execute-mattpocock-spec
```

## 前置条件

运行前必须先加载并运行 `setup-matt-pocock-skills` skill 配置 Issue Tracker。

## 使用方式

在当前 harness 中加载 `execute-mattpocock-spec` skill，然后提供 Spec 引用（Issue 编号、URL 或 `.scratch/<feature>/spec.md` 路径）。

## 工作流程

| 步骤 | 说明 |
|------|------|
| 1. 定位 Spec | 解析用户传入的 Spec 引用，读取完整内容 |
| 2. 恢复或初始化 | 物化 `plan.json` 与 `checkpoint.json`；新执行创建独立 feature worktree，恢复时自动重建丢失的 feature worktree |
| 3. 物化执行计划 | 本地 Markdown Tracker 写入不可变 Plan；远程 Tracker 需注入 adapter，否则明确 blocked |
| 4. 构建执行计划 | Plan 解析 `blocked_by` 并计算 frontier 层级 |
| 5. 分派执行 | 层内并行、层间串行；子代理终态结果会通知主代理，主代理不轮询状态 |
| 6. 最终评审与修复 | 主代理亲自完成整个 Spec 的双轴 `code-review`；用户确认的发现也由主代理直接修复并重新评审 |

## Execution Plan 与 Checkpoint

主仓库中的 `.scratch/<feature>/plan.json` 是不可变的 Spec/Issue 源引用与 Ticket 派生事实快照，正文仍保留在 Git 中的 Spec/Issue 文件；`.scratch/<feature>/checkpoint.json` 只记录执行生命周期。主代理在每个 Ticket 完成后，在主仓库勾选对应本地 Issue 复选框并更新 Checkpoint；所有这些改动在全部 Ticket 完成、最终 `code-review` 通过并完成整合清理后统一提交。恢复模块从 main 读取已提交记录、在 feature `HEAD` 验证 Ticket commits；汇总提交前只能在保留这些改动的同一 main worktree 恢复。

## 文件结构

```
mattpocock-skills-expand/
├── README.md
├── .gitignore
└── skills/
    └── execute-mattpocock-spec/
        ├── SKILL.md              # 技能定义
        ├── execution-plan-schema.json # 不可变 Plan 的 JSON Schema
        ├── checkpoint-schema.json # 可变 Checkpoint 的 JSON Schema
        ├── completion-result-schema.json # Completion Result 的 JSON Schema
        ├── references/            # 按需加载的架构与协议资料
        ├── scripts/               # 可执行运行时预检
        ├── lib/                   # 可执行的生命周期 modules
        └── agents/
            └── openai.yaml        # Codex UI 元数据
```

## 运行环境支持

Completion Adapter 支持 Codex、Claude Code 和 OpenCode；其他 harness 需要先提供具体 Adapter。
