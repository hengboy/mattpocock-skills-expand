# execute-mattpocock-spec

基于 [mattpocock/skills](https://github.com/mattpocock/skills) 封装的 MattPocock Spec 全自动执行技能。

自动判断 Spec 是否已被 `/to-tickets` 拆分为多个 Ticket：
- **已拆分**：按 frontier 层级逐层分派子代理（层内并行），每个子代理调用 `/implement` 实施对应 Ticket
- **未拆分**：在当前上下文中直接运行 `/implement`

全部完成后对整个 Spec 做 `/code-review` 双轴评审。通过 `state.json` 记录全生命周期，支持断点续传。

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

运行前必须先执行 `/setup-matt-pocock-skills` 配置 Issue Tracker。

## 使用方式

```
/execute-mattpocock-spec
```

输入 Spec 引用（Issue 编号、URL 或 `.scratch/<feature>/spec.md` 路径），技能自动执行。

## 工作流程

| 步骤 | 说明 |
|------|------|
| 1. 定位 Spec | 解析用户传入的 Spec 引用，读取完整内容 |
| 2. 恢复或初始化 | 读取 `state.json` 检查点，存在则断点续传，不存在则初始化 |
| 3. 判断是否拆票 | 本地看 `issues/` 目录，GitHub 看子 Issue |
| 4. 构建执行计划 | 解析 blocking edges，计算 frontier 层级 |
| 5. 分派执行 | 层内并行、层间串行，每个 Ticket 一个子代理 |
| 6. 最终评审 | 对整个 Spec 的 diff 做 `/code-review` 双轴评审 |

## state.json 断点续传

`.scratch/<feature>/state.json` 记录完整的执行状态，中断后重新运行从最后一个检查点恢复，不重复执行已完成的 Ticket。

## 文件结构

```
mattpocock-skills-expand/
├── skills/
│   └── execute-mattpocock-spec/
│       ├── SKILL.md              # 技能定义
│       ├── state-schema.json      # state.json 的 JSON Schema
│       ├── README.md              # 项目文档
│       └── agents/
│           └── openai.yaml        # Codex UI 元数据
```

## 兼容性

支持 opencode、Codex、Claude Code 等基于 Agent Skills 标准的 harness。