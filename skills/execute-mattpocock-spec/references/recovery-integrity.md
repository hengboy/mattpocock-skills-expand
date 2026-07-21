# 恢复完整性

汇总提交前，执行记录尚未持久化到 Git，只能在保留这些工作区改动的同一 main worktree 恢复。汇总提交后，按 feature slug 查找 branch，并用 lifecycle module 复用已注册 worktree；丢失时可重建独立 worktree。branch 不存在、目标路径冲突或重建后的 worktree 不干净时停止并报告。

调用 `verifyCheckpointIntegrity({ worktree: mainWorktree, featureWorktree, featureSlug })`。只有 `status: "valid"` 可继续。它必须证明：

- Plan revision 与 Checkpoint 引用一致，baseline 存在且是 `HEAD` 的祖先。
- 执行记录在 main，feature worktree 位于记录的 branch，每个 Plan Ticket 恰有一个 Checkpoint 条目。
- 每个 `in_progress` Ticket 的 `start_commit` 与每个 `done` Ticket 的 `end_commit` 都存在且是 `HEAD` 的祖先。
- Checkpoint 中的每个 Ticket 都属于 Plan。

`invalid` 时显示 module 返回的精确 diagnostics；不得猜测、降级 Ticket、重派 `done` Ticket 或用 `git log` 文本匹配替代验证。路径变动时用 `relocateCheckpoint` 更新记录。

**有效 Checkpoint 的恢复规则：** `executing` 从最低未完成 Frontier 继续，`reviewing` 进入评审，`integrating` 只做整合清理，`complete` 只报告结果。先检查 main 上的 `merged` 和 `complete`，避免重建已整合的 worktree。
