# mattpocock-skills-expand

基于 [mattpocock/skills](https://github.com/mattpocock/skills) 扩展的技能集合。主代理不直接实施，全部委派子代理。

## 技能列表

| 技能 | 说明 |
|------|------|
| [execute-mattpocock-spec](./skills/execute-mattpocock-spec/SKILL.md) | 全自动执行 MattPocock Spec，按 frontier 层级逐层分派子代理（层内并行），最后做 `code-review` 双轴评审 |

## execute-mattpocock-spec

自动判断 Spec 是否已被 `to-tickets` skill 拆分为多个 Ticket：
- **已拆分**：按 frontier 层级逐层分派子代理（层内并行），每个子代理加载 `implement` skill 实施对应 Ticket
- **未拆分**：委派单个子代理执行 `implement` skill

主代理不直接实施任何 Ticket，全部委派给子代理。执行开始时会创建绑定 `feat/{feature-slug}` 的独立 Git worktree；主工作树保持在原分支，即使有未提交改动也可继续处理其他事项。主代理通过 harness 的原生完成通知等待子代理，而不是定时查询任务状态；Codex/Claude Code 使用 Agent 结果收集，OpenCode 使用 Task 结果或 headless 模式的 SSE 事件流。全部完成后对整个 Spec 做 `code-review` 双轴评审。通过 `state.json` 记录全生命周期，支持断点续传。

> 示例：一个 Spec 拆分成 5 个 Ticket，01 blocked_by 空，02 blocked_by 01，03/04 blocked_by 02，05 blocked_by 03/04。
> - Level 0（01）→ 委派子代理 → 完成
> - Level 1（02）→ 委派子代理 → 完成
> - Level 2（03、04）→ 同时委派两个子代理 → 全部完成
> - Level 3（05）→ 委派子代理 → 完成
> - 最终 `code-review` 对整个 Spec 做双轴评审

## 安装

### skills.sh（推荐）

```bash
npx skills@latest add hengboy/mattpocock-skills-expand
```

### 手动安装

```bash
# 克隆到本地
git clone git@github.com:hengboy/mattpocock-skills-expand.git

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
| 2. 恢复或初始化 | 读取 `state.json` 检查点；新执行创建独立 feature worktree，存在则在记录的 worktree 中断点续传 |
| 3. 判断是否拆票 | 本地看 `issues/` 目录，GitHub 看子 Issue |
| 4. 构建执行计划 | 解析 blocking edges，计算 frontier 层级 |
| 5. 分派执行 | 层内并行、层间串行；子代理终态结果会通知主代理，主代理不轮询状态 |
| 6. 最终评审 | 主代理直接执行 `code-review` skill，对整个 Spec 的 diff 做双轴评审 |

## state.json 断点续传

`.scratch/<feature>/state.json` 记录完整的执行状态，包括 feature 分支和 worktree 的绝对路径；中断后重新运行从最后一个检查点恢复，不重复执行已完成的 Ticket。

## 文件结构

```
mattpocock-skills-expand/
├── README.md
├── .gitignore
└── skills/
    └── execute-mattpocock-spec/
        ├── SKILL.md              # 技能定义
        ├── state-schema.json      # state.json 的 JSON Schema
        └── agents/
            └── openai.yaml        # Codex UI 元数据
```

## 兼容性

支持 opencode、Codex、Claude Code 等基于 Agent Skills 标准的 harness。
