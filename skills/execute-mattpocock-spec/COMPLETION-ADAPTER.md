# Completion Adapter

Completion Adapter 是执行一个 Frontier 并返回其全部 Completion Result 的 module。它的 interface 是 Frontier 的 Ticket 内容与 worktree；编排器不传递或读取 harness task ID，也不处理原始 agent message。

## Completion Result

`completion-result-schema.json` 是 Completion Result 的唯一字段契约。一个结果总是关联一个 Ticket，包含 `commits`、`tests` 和非空 `summary`：

- `done` 必须至少有一个 commit，且不能有 `error`。
- `blocked` 必须没有 commit，且必须有非空 `error`。
- 空 `tests` 对应 `TESTS: none`。

Adapter 只把通过 Schema 验证的 Completion Result 交给编排器。原始终态缺字段、无法解析、`DONE` 无 commit 或 `BLOCKED` 含 commit 时，Adapter 为该 Ticket 生成 `blocked` Completion Result：`summary` 使用稳定的协议错误摘要，`error` 记录具体的解析或验证失败原因。

## Frontier execution

Adapter 为整个 Frontier 并行分派所有 Ticket，并等待每一个已分派 Ticket 的原生终态。一个 `blocked` 结果不会提前结束等待；Adapter 收齐全部 Completion Result 后才返回。

Frontier 完成通知只是一条给用户的中间进度，不得结束主协调器的执行。Codex adapter 必须在同一个主协调会话中等待并收集当前 Frontier 的全部原生终态，再派发下一 Frontier；不得把 Frontier 完成通知作为一次 Codex 执行的终点，或要求用户发送“继续”来创建下一层的子代理。

在开始下一 Frontier 前，Codex adapter 必须完成前一 Frontier 的原生 `wait/collect`，释放已经终态的子代理会话。若创建下一层 Agent 因会话/容量冲突失败，Adapter 先完成该清理后在同一协调会话中重试一次。仍无法创建时，未成功创建的 Ticket 必须得到 `blocked` Completion Result（说明原生派发失败）；不得把它的 checkpoint 从 `in_progress` 回退为 `pending`。

如果当前 harness 没有受支持的 Adapter，Adapter 不分派任何 Ticket，而是为 Frontier 中每个 Ticket 返回一个无 commit 的 `blocked` Completion Result，说明不受支持的 harness。

每个 Ticket 的子代理必须命名为 `Issue Task - {ticket_title}`，并显式使用与主代理相同的模型。Adapter 要求它加载 `implement` skill、只在记录的 feature worktree 中编辑、测试和提交，且不得创建分支、worktree 或 PR；它也不得编辑源 Issue 文件或 `state.json`。子代理的 `DONE` commits 只包含代码实现；主协调器紧随其后提交 Issue 复选框和 checkpoint 元数据。

## Prompt protocol

Adapter 将 Ticket 内容和 worktree 约束与以下条件终态模板一并写入子代理提示；终态协议只由 Adapter 拥有。`DONE` 输出四行并省略 `ERROR`，`BLOCKED` 输出五行。

```text
结束时只返回以下协议（这会作为完成通知发送给主代理）：
RESULT: DONE | BLOCKED
COMMITS: <DONE 时为一个或多个 commit SHA；BLOCKED 时为 none>
TESTS: <已运行测试及结果；没有则 none>
SUMMARY: <非空的已满足验收项或阻塞原因摘要>
ERROR: <仅 RESULT=BLOCKED 时填写，且非空>
```

`DONE` 的原始终态示例：

```text
RESULT: DONE
COMMITS: abcdef1
TESTS: none
SUMMARY: implemented the Ticket
```

`BLOCKED` 的原始终态示例：

```text
RESULT: BLOCKED
COMMITS: none
TESTS: npm test failed
SUMMARY: cannot satisfy the Ticket
ERROR: required tracker credentials are unavailable
```

Adapter 将条件文本解析为 Completion Result：`DONE` 映射为 `done`，`BLOCKED` 映射为 `blocked`，`none` 的测试映射为空数组。`ERROR` 不得出现在 `DONE` 结果中。

## Supported adapters

**Codex / Claude adapter**：分派 Agent 或子代理，并通过其原生 completion result 或 wait/collect 操作等待。不得轮询任务列表或状态。

**OpenCode adapter**：分派 Task，并通过 Task 结果等待；headless 编排时订阅 SSE 的终态事件后读取最终消息一次。不得轮询会话状态。

只有这两个具体 Adapter 使该 seam 成立。新增 harness 前必须新增具体 Adapter；不得以泛化的“其他 harness”分支扩大 interface。
