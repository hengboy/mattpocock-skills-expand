---
name: execute-mattpocock-spec
description: "以可验证的 Execution Plan、Checkpoint、worktree 生命周期与 Completion Adapter 执行 MattPocock Spec。"
disable-model-invocation: true
---

# Execute MattPocock Spec

将一个已签署的 MattPocock Spec 实施、评审并合并到 `main`。只有 Ticket 实施可委派；主协调器亲自评审、修复并整合。执行记录由可执行 module 管理，不以分散的 Markdown 规则充当实现。

Issue tracker 必须已配置：若缺少 `docs/agents/issue-tracker.md`，先运行 `setup-matt-pocock-skills`。

## 执行记录

执行期间，两个记录都位于 feature 分支并必须提交；成功整合后，最终 Checkpoint 继续提交在 `main`，使 feature worktree 删除后仍可恢复：

- **Execution Plan**：`.scratch/<feature>/plan.json`。不可变的 Spec、Ticket、验收事实和 `blocked_by` 快照；`revision` 是其内容摘要。
- **Checkpoint**：`.scratch/<feature>/checkpoint.json`。可变的生命周期、Git commit、评审和整合进度；它必须引用一个 Plan revision。

旧 `.scratch/<feature>/state.json` **不兼容且不迁移**。发现它时停止，要求用户以新格式重新初始化；不得把它解释为 Checkpoint。

`lib/` 中的 module 是唯一的实现 seam：

| Module | Interface | 负责的 implementation |
| --- | --- | --- |
| `plan.mjs` | Tracker 输入 → Execution Plan | 本地 Markdown 物化、Ticket 依赖与 revision |
| `checkpoint.mjs` | Plan 与 Ticket 终态 → Checkpoint | 初始化、状态转换、写入 |
| `checkpoint-integrity.mjs` | worktree + feature slug → `valid` / 精确诊断 | Plan revision、Git 祖先与 Ticket commit 证明 |
| `worktree-lifecycle.mjs` | repository + branch → worktree | 创建、复用、重建、干净检查、删除 |
| `completion-adapter.mjs` | Frontier + worktree → Completion Results | 原生终态收集、协议规范化、unsupported 结果 |
| `execution-coordinator.mjs` | 一次执行输入 → 可恢复生命周期 | 初始化、恢复、Frontier、评审、合并与清理的串联 |

`execution-plan-schema.json` 和 `checkpoint-schema.json` 是持久化格式的权威；`completion-result-schema.json` 是 Completion Result 的权威。每次写入前后验证对应 schema。

## 1. 初始化

1. 解析用户给出的 Spec，确定 feature slug、Tracker 和 feature branch `feat/<feature>`。
2. 在修改任何文件前记录 `baseline`。用 `worktree-lifecycle.mjs` 的 `createFeatureWorktree` 从 baseline 创建唯一 feature worktree；不得在主工作树 checkout feature 分支。
3. 调用 `plan.mjs` 的 Tracker materializer。首个实现只支持 `local` Markdown；没有已注入 adapter 的 GitHub、GitLab 或其他 Tracker 必须返回明确 `blocked`，不得伪造读取结果。
4. 在 feature worktree 写入 `plan.json`，以该 Plan 创建并写入 `checkpoint.json`。初始 commit **只**包含这两个文件。
5. 初始 Checkpoint commit 后确认 worktree 干净，才可分派 Ticket。

主工作树可以有未提交的其他工作；它们绝不进入 feature worktree。

## 2. 恢复

1. 从 feature slug 得到 branch。用 `ensureFeatureWorktree` 复用注册的 worktree；分支存在但 worktree 丢失时自动重建独立 worktree。分支不存在、目标路径冲突或重建后不干净时停止并报告。
2. 若 Checkpoint 记录的 worktree 路径与 lifecycle module 返回的路径不同，用 `relocateCheckpoint` 更新路径并提交只包含 `checkpoint.json` 的 relocation checkpoint。
3. 调用 `verifyCheckpointIntegrity({ worktree, featureSlug })`。只有 `status: "valid"` 才能继续。
4. 完整性校验必须证明：
   - Plan revision 与 Checkpoint 引用相同；
   - baseline 存在且是 `HEAD` 的祖先；
   - 当前分支与 Checkpoint 的 branch 相同，且每个 Plan Ticket 恰有一个 Checkpoint 条目；
   - 每个 `in_progress` Ticket 的 `start_commit`、每个 `done` Ticket 的 `end_commit` 都存在且是 `HEAD` 的祖先；
   - Checkpoint 中的 Ticket 全部属于该 Plan。
5. `invalid` 时停止并显示 module 的精确 diagnostics；不得猜测、降级 Ticket 状态、重派 `done` Ticket，或通过 `git log` 文本匹配决定一致性。
6. 有效 Checkpoint 按状态恢复：`executing` 从最低未完成 Frontier，`reviewing` 进入评审，`integrating` 只执行整合清理，`complete` 只报告结果。恢复入口优先检查 main 上的 `merged` / `complete` Checkpoint，避免重新创建已整合的 feature worktree。

## 3. 执行 Frontier

Plan 定义 Ticket 的 `level` 和 `blocked_by`；Checkpoint 只记录其运行终态。对每个 Frontier：

1. 用 `checkpoint.mjs` 的 `startTickets` 记录所有 `pending` Ticket 的 `in_progress`、开始 commit 和时间；写入并提交只包含 `checkpoint.json` 的 dispatch checkpoint。
2. 调用 `completion-adapter.mjs` 的 Adapter。Adapter 必须并行派发该 Frontier 的所有 Ticket，并原生等待、收集所有终态；一个 blocked 结果不能提前结束收集。
3. 每个子代理仅在记录的 feature worktree 中编辑、测试和提交代码；不得创建 branch/worktree/PR，也不得编辑 Plan 或 Checkpoint。它的 `DONE` 提交只包含实现代码。
4. 逐个验证 Completion Result 的提交都在 feature `HEAD` 上。对 `done`，用 `completeTicket` 记录最后一个 implementation commit；对 `blocked`，用 `blockTicket` 记录非空错误并停止整个流程。
5. 每个 done Ticket 的代码提交后立刻写入并提交一个只包含 `checkpoint.json` 的 checkpoint commit。`end_commit` 始终指向 implementation commit，不能指向 checkpoint commit。

完成一个 Frontier 不是执行终点。成功写入 checkpoint 后，主协调器必须在同一会话继续下一可执行 Frontier，直到 blocked、需要用户确认的评审发现或整个 Spec 已完成。

## 4. Completion Adapter

`completion-adapter.mjs` 是唯一解析终态协议的 module。其 interface 由 `createNativeAdapter({ spawn, collect })` 表达；Codex/Claude 和 OpenCode 使用各自注入的原生 `spawn`/`collect` 能力，因此两个 adapter 使这个 seam 真实存在。

子代理终态必须为：

```text
RESULT: DONE | BLOCKED
COMMITS: <DONE 时为 SHA；BLOCKED 时为 none>
TESTS: <结果；没有则 none>
SUMMARY: <非空摘要>
ERROR: <仅 BLOCKED 且非空>
```

Adapter 负责把缺字段、无效 SHA、`DONE` 无提交、`DONE` 含 ERROR 或 `BLOCKED` 含提交规范化为 `blocked` Completion Result。没有原生 harness 能力时使用 `createUnsupportedAdapter`：为整个 Frontier 返回结构化 blocked 结果，绝不轮询或伪造任务。

## 5. 评审与整合

所有 Ticket done 后，主协调器用 `beginReview` 将 Checkpoint 设为 `reviewing` 并提交。主协调器直接在 feature worktree 完成 Standards 与 Spec 两轴评审，不得委派评审；用户确认的修复也由主协调器直接提交。评审完成时用 `completeReview` 记录摘要并进入 `integrating`。

评审结束后：

1. 将 Checkpoint 设为 `integrating`，记录 feature `HEAD` 并提交；feature worktree 必须干净。
2. 用 `findMainWorktree` 找到 `main`；main worktree 必须干净。
3. 在 main worktree 合并 feature branch。冲突时 `git merge --abort`，保留 feature worktree，记录 blocked 原因。
4. 验证 feature HEAD 是 `main` 的祖先，在 **main worktree** 使用 `markMerged` 提交 `integration.status: "merged"`。
5. 用 `removeFeatureWorktree` 删除干净的 feature worktree。成功后在 **main worktree** 使用 `completeIntegration` 提交 complete/done；清理失败时 main 保留 `merged`，下次只重试清理，绝不再次合并。

## 红线

- 每个 Spec 只有一个 feature worktree；Ticket 不得各自创建 worktree。
- Plan 是不可变输入；不得在实施时修改其 Ticket 或验收事实。
- Checkpoint 是唯一的可变执行记录；不得把进度留在主工作树或未提交改动中。
- `done` Ticket 的 commit 证明失败时必须停止；Git 事实优先于 Checkpoint。
- 最终评审与用户确认的修复不得委派。
- 代码与执行中的 Plan/Checkpoint 必须落在 feature branch；整合后最终 Checkpoint 归 main 所有，且只在两个 worktree 都干净时合并。
