# Completion Adapter 协议

`completion-adapter.mjs` 是唯一解析终态协议的 module。`createNativeAdapter({ spawn, collect })` 先派发整个 Frontier，再收集全部结果；一个 Ticket blocked 不会提前结束收集。需要工作项时，原生任务从 feature worktree 的 `ticket.ref` 读取。

Codex/Claude 和 OpenCode 分别注入自己的原生 `spawn`/`collect` 能力。没有原生能力时，`createUnsupportedAdapter(name)` 为整个 Frontier 返回结构化 blocked 结果，绝不轮询或伪造任务。一次派发失败时，先收集已启动 Ticket 的终态，再重试失败派发一次；仍失败才返回 blocked。

子代理终态格式为：

```text
RESULT: DONE | BLOCKED
COMMITS: <DONE 时为一个或多个完整 SHA；BLOCKED 时为 none>
TESTS: <已运行测试；没有则 none>
SUMMARY: <非空摘要>
ERROR: <仅 RESULT=BLOCKED 时填写，且非空>
```

`completion-result-schema.json` 是字段格式的权威。`normalizeCompletion` 将缺字段、无效或短 SHA、`DONE` 无提交、`DONE` 含 ERROR、`BLOCKED` 含提交转换为 blocked Completion Result。协议错误的 `summary` 固定为 `Completion protocol error`，`error` 说明具体原因。

子代理名为 `Issue Task - {ticket_title}`，使用主代理的模型并加载 `implement` skill。它只编辑、测试和提交实现代码；主协调器在 main 勾选本地 Issue 复选框并更新 Checkpoint。
