---
name: execute-mattpocock-spec
description: "执行已签署的 MattPocock Spec，完成计划、实施、评审、合并与执行记录提交。"
disable-model-invocation: true
---

# Execute MattPocock Spec

将已签署的 MattPocock Spec 实施、评审并合并到 `main`。这是唯一的执行入口；它编排现有 module，而不在此重述其实现。生命周期所有权和硬性约束见 [执行架构](references/execution-architecture.md)。

## 前置条件

- 必须存在 `docs/agents/issue-tracker.md`；缺少时先运行 `setup-matt-pocock-skills`。
- 在 skill 目录运行 `npm run check:runtime`；安装与失败处理见 [运行时依赖](references/installation.md)。

## 1. 初始化

1. 解析已签署 Spec，确定 feature slug、Tracker 与 `feat/<feature>` 分支。
2. 记录 baseline，并在该 baseline 创建 feature worktree。
3. 物化并验证 Plan，在 main 写入 Plan 与 Checkpoint，但不提交。

**完成条件：** main 中存在通过 schema 校验的 Plan 和 Checkpoint，feature worktree 干净。

## 2. 恢复

1. 从 main 读取已有记录，并按 [恢复完整性](references/recovery-integrity.md) 验证；`invalid` 时报告 diagnostics 并停止。
2. 仅在记录允许时复用或重建 feature worktree；路径变动时更新 Checkpoint。
3. 从有效 Checkpoint 的状态继续：`executing`、`reviewing`、`integrating` 或 `complete`。

**完成条件：** 返回有效 Checkpoint 和匹配的 worktree，或返回唯一、精确的 blocked 诊断。

## 3. 执行

1. 连续执行每个可执行 Frontier，直至 blocked、需要评审输入或全部 Ticket 完成。
2. `delegated` 使用 [Completion Adapter 协议](references/completion-protocol.md)；`coordinator` 仅直接实施自动判定的低风险单 Ticket。
3. 在 main 记录每个 Ticket 的终态并勾选本地 Issue；blocked 结果立即停止流程。

**完成条件：** 所有 Ticket 为 `done` 时进入 `reviewing`；否则返回可恢复状态或 blocked 结果。

## 4. 评审与整合

1. 主协调器亲自完成 Standards 与 Spec 两轴评审，并直接完成用户确认的修复。
2. 仅在 `approved: true` 且 `findingsSummary` 非空时执行整合生命周期。
3. 完成执行记录的最终提交。

**完成条件：** main 包含唯一的执行记录提交；若合并后清理失败，保留 `merged` 并且下次只重试清理。
