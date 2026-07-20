# Completion Adapter

`lib/completion-adapter.mjs` 是 Completion Adapter 的 implementation。它的 interface 是 Frontier Ticket、feature worktree 与原生 harness capability；返回每个 Ticket 的已验证 Completion Result。编排器不读取 task ID、原始 message 或 harness 状态。

## Interface

```js
const adapter = createNativeAdapter({ spawn, collect });
const results = await adapter.executeFrontier({ tickets, worktree });
```

- `spawn({ ticket, worktree })` 创建一个原生任务；`ticket.ref` 是仓库相对的 Issue 路径，原生任务需要工作项时从 `worktree` 读取该文件。
- `collect(task)` 等待该任务的原生终态并返回其终态文本。
- `executeFrontier` 先派发整个 Frontier，再收集全部结果；某个 Ticket blocked 不会提前结束收集。

Codex/Claude 和 OpenCode 分别将自己的原生 Agent/Task capability 注入 `createCodexClaudeAdapter` 或 `createOpenCodeAdapter`。这是两个真实 adapter。没有原生 capability 时使用 `createUnsupportedAdapter(name)`，它为所有 Ticket 返回结构化 blocked 结果，绝不轮询。

在下一 Frontier 前，调用方必须已完成本 Frontier 的 `executeFrontier`，因此终态任务不再占用派发容量。某个原生派发失败时，Adapter 立即收集已启动任务的终态，再重试该 Ticket 一次；仍失败的 Ticket 保持 `in_progress`，并得到 blocked Completion Result，不能悄悄退回 `pending`。

## Terminal protocol

子代理只能返回以下字段：

```text
RESULT: DONE | BLOCKED
COMMITS: <DONE 时为一个或多个 SHA；BLOCKED 时为 none>
TESTS: <已运行测试；没有则 none>
SUMMARY: <非空摘要>
ERROR: <仅 RESULT=BLOCKED 时填写，且非空>
```

`normalizeCompletion` 解析并验证协议。`completion-result-schema.json` 是字段格式的权威：

- `done` 至少有一个 SHA，且没有 `error`。
- `blocked` 没有 SHA，且有非空 `error`。
- `TESTS: none` 映射为 `[]`。

任何解析或协议错误都变为该 Ticket 的 blocked Completion Result，`summary` 固定为 `Completion protocol error`，`error` 说明具体原因。

## 子代理约束

每个 Ticket 子代理名为 `Issue Task - {ticket_title}`，显式使用与主代理相同的模型，并加载 `implement` skill。它只可在记录的 feature worktree 编辑、测试和提交实现代码；不得创建 branch、worktree 或 PR，也不得改写 Issue、`plan.json` 或 `checkpoint.json`。主协调器在主仓库勾选 Issue 复选框并记录 Checkpoint。
