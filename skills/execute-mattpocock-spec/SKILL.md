---
name: execute-mattpocock-spec
description: "以可验证的 Execution Plan、Checkpoint、worktree 生命周期与 Completion Adapter 执行 MattPocock Spec。"
disable-model-invocation: true
---

# Execute MattPocock Spec

将一个已签署的 MattPocock Spec 实施、评审并合并到 `main`。多 Ticket 实施可委派；单 Ticket 的低风险工作可由主协调器直接实施，主协调器始终亲自评审、修复并整合。执行记录由可执行 module 管理，不以分散的 Markdown 规则充当实现。

Issue tracker 必须已配置：若缺少 `docs/agents/issue-tracker.md`，先运行 `setup-matt-pocock-skills`。

## 执行记录

主代理在主仓库的 `main` 分支维护所有执行记录；feature worktree 只包含 Ticket 实现代码及其提交。`plan.json`、`checkpoint.json` 和本地 Issue 复选框在执行期间只写入工作区；所有 Ticket 完成、最终 `code-review` 显式返回 `approved: true` 后，待合并与清理完成时由主代理使用 `git-commit` skill 生成贴合实际变更的提交信息并统一提交：

- **Execution Plan**：`main:.scratch/<feature>/plan.json`。不可变的 Spec/Issue 源引用、Ticket 仓库相对 `ref`、派生事实和 `blocked_by` 快照；正文和工作项始终保留在 Git 中的 Spec/Issue 文件，`revision` 是 Plan 事实摘要。
- **Checkpoint**：`main:.scratch/<feature>/checkpoint.json`。可变的生命周期、Git commit、评审和整合进度；它必须引用一个 Plan revision。
- **Issue 复选框**：本地 Markdown Issue 的 Ticket 完成后，由主代理在 `main` 勾选；它与 Plan、最终 Checkpoint 一起进入唯一的执行记录提交。Issue/Spec 路径必须位于主仓库。

`lib/` 中的 module 是唯一的实现 seam：

| Module | Interface | 负责的 implementation |
| --- | --- | --- |
| `plan.mjs` | Tracker 输入 → Execution Plan | 本地 Markdown 物化、Ticket 依赖与 revision |
| `checkpoint.mjs` | Plan 与 Ticket 终态 → Checkpoint | 初始化、状态转换、写入 |
| `checkpoint-integrity.mjs` | worktree + feature slug → `valid` / 精确诊断 | Plan revision、Git 祖先与 Ticket commit 证明 |
| `worktree-lifecycle.mjs` | repository + branch → worktree | 创建、复用、重建、干净检查、删除 |
| `completion-adapter.mjs` | Frontier + worktree → Completion Results | 原生终态收集、协议规范化、unsupported 结果 |
| `execution-coordinator.mjs` | 一次执行输入 → 可恢复生命周期 | `run` 连续推进 Frontier、评审、合并与清理 |

`execution-plan-schema.json` 和 `checkpoint-schema.json` 是持久化格式的权威；`completion-result-schema.json` 是 Completion Result 的权威。每次写入前后验证对应 schema。

在最终提交前必须注入 `generateCommitMessage({ mainWorktree, featureSlug, plan, files })`。主代理在此回调中调用 `git-commit` skill，基于本次实际变动的文件列表和 Plan 生成非空的 Gitmoji + Conventional Commit message；缺少该回调时协调器拒绝提交。

## 运行时依赖

安装器必须将 `package.json` 和 `package-lock.json` 与 skill 一起安装，并在该 skill 目录执行 `npm ci --omit=dev`。不得只安装 `ajv` 与 `ajv-formats`，或复制一个现成的 `node_modules`：锁文件负责恢复它们的所有传递依赖。缺少依赖时停止执行，不得跳过 schema 校验。

## 1. 初始化

1. 解析用户给出的 Spec，确定 feature slug、Tracker 和 feature branch `feat/<feature>`。
2. 在修改任何文件前记录 `baseline`。用 `worktree-lifecycle.mjs` 的 `createFeatureWorktree` 从 baseline 创建唯一 feature worktree；不得在主工作树 checkout feature 分支。
3. 调用 `plan.mjs` 的 Tracker materializer。首个实现只支持 `local` Markdown；没有已注入 adapter 的 GitHub、GitLab 或其他 Tracker 必须返回明确 `blocked`，不得伪造读取结果。
   - 新建 Plan 自动决定 `execution_mode`：多 Ticket 一律为 `delegated`；单 Ticket 只有内容不超过 1000 字符、工作项不超过 2 条且不命中迁移、安全、发布、性能等高风险领域词时为 `coordinator`。其余情况为 `delegated`。
4. 在 main worktree 写入 `plan.json`，以该 Plan 创建并写入 `checkpoint.json`；此时不提交。
5. 确认 feature worktree 干净，才可分派 Ticket。

主工作树可以有未提交的其他工作；它们绝不进入 feature worktree。

## 2. 恢复

1. 汇总提交完成前，执行记录尚未持久化到 Git；只能在保留这些工作区改动的同一 main worktree 恢复。汇总提交完成后，从 feature slug 得到 branch，用 `ensureFeatureWorktree` 复用注册的 worktree；分支存在但 worktree 丢失时自动重建独立 worktree。分支不存在、目标路径冲突或重建后不干净时停止并报告。
2. 若 Checkpoint 记录的 worktree 路径与 lifecycle module 返回的路径不同，用 `relocateCheckpoint` 在 main 更新 Checkpoint，并将该改动纳入最终汇总提交。
3. 从 main 读取 Plan/Checkpoint，并调用 `verifyCheckpointIntegrity({ worktree: mainWorktree, featureWorktree, featureSlug })`。只有 `status: "valid"` 才能继续。
4. 完整性校验必须证明：
   - Plan revision 与 Checkpoint 引用相同；
   - baseline 存在且是 `HEAD` 的祖先；
   - 记录位于 `main`、feature worktree 位于 Checkpoint 的 branch，且每个 Plan Ticket 恰有一个 Checkpoint 条目；
   - 每个 `in_progress` Ticket 的 `start_commit`、每个 `done` Ticket 的 `end_commit` 都存在且是 `HEAD` 的祖先；
   - Checkpoint 中的 Ticket 全部属于该 Plan。
5. `invalid` 时停止并显示 module 的精确 diagnostics；不得猜测、降级 Ticket 状态、重派 `done` Ticket，或通过 `git log` 文本匹配决定一致性。
6. 有效 Checkpoint 按状态恢复：`executing` 从最低未完成 Frontier，`reviewing` 进入评审，`integrating` 只执行整合清理，`complete` 只报告结果。恢复入口优先检查 main 上的 `merged` / `complete` Checkpoint，避免重新创建已整合的 feature worktree。

## 3. 执行 Frontier

Plan 定义 Ticket 的 `level` 和 `blocked_by`；Checkpoint 只记录其运行终态。对每个 Frontier：

1. 用 `checkpoint.mjs` 的 `startTickets` 记录所有 `pending` Ticket 的 `in_progress`、开始 commit 和时间；主代理只在 main 写入 Checkpoint，不提交。
2. `execution_mode: delegated` 时调用 `completion-adapter.mjs` 的 Adapter：它必须并行派发该 Frontier 的所有 Ticket，并原生等待、收集所有终态；一个 blocked 结果不能提前结束收集。需要工作项时，Adapter 从 `worktree` 中的 `ticket.ref` 文件读取。`execution_mode: coordinator` 时，主协调器通过注入的 `directExecutor({ ticket, worktree, plan, readTicket })` 在同一 worktree 实施唯一 Ticket，并返回一份 Completion Result。
3. 委派时，每个子代理仅在记录的 feature worktree 中编辑、测试和提交代码；不得创建 branch/worktree/PR，也不得编辑 Plan 或 Checkpoint。它的 `DONE` 提交只包含实现代码。直接实施时，主协调器也只在 feature worktree 写入实现代码。
4. 逐个验证 Completion Result 的提交都在 feature `HEAD` 上。对 `done`，用 `completeTicket` 记录最后一个 implementation commit；对 `blocked`，用 `blockTicket` 记录非空错误并停止整个流程。
5. 每个 done Ticket 的代码提交后，主代理立刻在 main 勾选对应本地 Issue 的复选框，并写入 Checkpoint；`end_commit` 始终指向 implementation commit，不能指向 checkpoint commit。所有这些改动留待最终汇总提交。

完成一个 Frontier 不是执行终点。调用 `Execution Coordinator.run` 后，协调器在同一会话连续推进所有可执行 Frontier，直到 blocked、缺少 review callback、需要用户确认的评审发现或整个 Spec 已完成；不得把每层交还给调用方手动继续。

## 4. Completion Adapter

`completion-adapter.mjs` 是唯一解析终态协议的 module。其 interface 由 `createNativeAdapter({ spawn, collect })` 表达；Codex/Claude 和 OpenCode 使用各自注入的原生 `spawn`/`collect` 能力，因此两个 adapter 使这个 seam 真实存在。

子代理终态必须为：

```text
RESULT: DONE | BLOCKED
COMMITS: <DONE 时为完整 SHA；BLOCKED 时为 none>
TESTS: <结果；没有则 none>
SUMMARY: <非空摘要>
ERROR: <仅 BLOCKED 且非空>
```

Adapter 负责把缺字段、无效或非完整 SHA、`DONE` 无提交、`DONE` 含 ERROR 或 `BLOCKED` 含提交规范化为 `blocked` Completion Result。某次原生派发失败时，它会先收集已启动 Ticket 的终态，再重试失败派发一次；仍失败才返回 blocked。没有原生 harness 能力时使用 `createUnsupportedAdapter`：为整个 Frontier 返回结构化 blocked 结果，绝不轮询或伪造任务。

## 5. 评审与整合

所有 Ticket done 后，主协调器在 main 用 `beginReview` 将 Checkpoint 设为 `reviewing`，但不提交。主协调器直接在 feature worktree 完成 Standards 与 Spec 两轴评审，不得委派评审；用户确认的代码修复也由主协调器直接提交。评审回调必须同时返回非空 `findingsSummary` 与 `approved: true` 才算通过；否则保持 `reviewing` 且绝不提交。评审通过后，在 main 用 `completeReview` 记录摘要并进入 `integrating`。

评审结束后：

1. 在 main 将 Checkpoint 设为 `integrating`，但不提交；feature worktree 必须干净。
2. 用 `findMainWorktree` 找到 `main`；除本次执行记录以外的改动须以路径限定的 stash 临时隔离，绝不进入执行记录提交。恢复 stash 冲突时保留该 stash 并报告其引用，供用户处理。
3. 在 main worktree 合并 feature branch。冲突时 `git merge --abort`，恢复临时 stash，保留 feature worktree，记录 blocked 原因。
4. 验证 feature HEAD 是 `main` 的祖先，在 **main worktree** 使用 `markMerged` 记录 `integration.status: "merged"`。
5. 用 `removeFeatureWorktree` 删除干净的 feature worktree。成功后在 **main worktree** 使用 `completeIntegration` 记录 complete/done，再使用 `git-commit` skill 生成符合实际变更的 Gitmoji + Conventional Commit message，将 Plan、最终 Checkpoint 和所有 Issue 复选框作为一次汇总提交；清理失败时 main 保留 `merged`，下次只重试清理，绝不再次合并。

## 红线

- 每个 Spec 只有一个 feature worktree；Ticket 不得各自创建 worktree。
- 多 Ticket Plan 必须使用 `delegated`；`coordinator` 仅适用于复杂度规则自动判定为低风险的单 Ticket Plan。
- Plan 是不可变输入；不得在实施时修改其 Ticket 或执行事实。
- Checkpoint 是唯一的可变执行记录；执行期间由主代理在 main 更新，且必须在所有 Ticket 完成、最终评审通过和整合清理成功后随唯一的汇总提交持久化。
- `done` Ticket 的 commit 证明失败时必须停止；Git 事实优先于 Checkpoint。
- 最终评审与用户确认的修复不得委派。
- feature worktree 只可承载 Ticket 实现代码且合并前必须干净；Issue 复选框、Plan 与 Checkpoint 始终归 main 所有。main 的无关改动须先按路径暂存，执行记录提交后恢复；恢复冲突时保留 stash 并报错。
