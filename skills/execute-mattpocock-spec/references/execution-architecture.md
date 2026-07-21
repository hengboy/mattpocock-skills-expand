# 执行架构

## 记录所有权

主代理只在主仓库的 `main` 维护执行记录：不可变的 `.scratch/<feature>/plan.json`、可变的 `.scratch/<feature>/checkpoint.json` 和本地 Issue 复选框。feature worktree 只承载 Ticket 实现代码及其提交。

Plan 保存 Spec/Issue 的仓库相对引用、派生依赖与 revision；正文始终留在 Git 中的 Spec/Issue 文件。Checkpoint 引用 Plan revision，保存生命周期、Git commit、评审和整合状态。三个 JSON schema 是持久化格式的权威，每次读写都必须验证。

所有 Ticket 完成、最终评审通过、合并和清理成功后，主代理才调用 `git-commit` 生成非空 Gitmoji + Conventional Commit message，并将执行记录作为一次汇总提交。`generateCommitMessage({ mainWorktree, featureSlug, plan, files })` 缺失或返回空消息时拒绝提交。

## Module 边界

| Module | 输入和输出 | 唯一职责 |
| --- | --- | --- |
| `plan.mjs` | Tracker 输入 -> Plan | 物化本地 Markdown、依赖和 revision |
| `checkpoint.mjs` | Plan、Ticket 终态 -> Checkpoint | 状态转换和持久化 |
| `checkpoint-integrity.mjs` | worktree、feature slug -> `valid` 或 diagnostics | 验证记录与 Git 事实 |
| `worktree-lifecycle.mjs` | repository、branch -> worktree | 创建、复用、重建、清理 |
| `completion-adapter.mjs` | Frontier、worktree -> Completion Results | 派发、收集和协议规范化 |
| `execution-coordinator.mjs` | 执行输入 -> 生命周期结果 | 连续推进、评审、整合和清理 |

## 不变规则

- 每个 Spec 只有一个 feature worktree；Ticket 不创建 branch、worktree 或 PR。
- 首个 Tracker materializer 只支持本地 Markdown；没有注入 adapter 的 GitHub、GitLab 或其他 Tracker 必须返回明确 blocked，绝不伪造读取结果。
- `delegated` 用于多 Ticket 和高风险或复杂的单 Ticket；只有内容不超过 1000 字符、工作项不超过两项且不涉及迁移、安全、发布或性能的单 Ticket 可自动使用 `coordinator`。
- Plan 是不可变输入；Checkpoint 是唯一的可变执行记录。`done` Ticket 的 `end_commit` 必须是实现提交，Git 事实优先于 Checkpoint。
- 子代理只能在 feature worktree 编辑、测试和提交实现代码；主代理在 main 更新 Issue、Plan 和 Checkpoint。
- 最终 Standards 与 Spec 两轴评审，以及用户确认的修复，始终由主协调器在 feature worktree 完成。
- 整合只在 `approved: true` 和非空 `findingsSummary` 后开始；feature worktree 必须干净。main 的无关改动以路径限定 stash 隔离，合并冲突时 abort merge 并恢复 stash。
- 合并成功后，确认 feature HEAD 是 main 的祖先，记录 `merged`，清理 worktree，并使用 `git-commit` 提交 Plan、最终 Checkpoint 与本地 Issue 复选框。清理或恢复 stash 失败时保留 `merged` 或 stash 引用并报告；后续只重试未完成的清理。
