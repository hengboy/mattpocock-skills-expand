---
name: execute-mattpocock-spec
description: "全自动执行 MattPocock Spec。主代理不直接实施，全部委派子代理。按 frontier 层级逐层分派（层内并行），最后对整个 Spec 做 /code-review。通过 state.json 断点续传。"
disable-model-invocation: true
---

# Execute MattPocock Spec

将一个 MattPocock Spec 从签署完成的计划推进到经过评审、已提交的代码——并能从中断中恢复。**主代理不直接实施任何 Ticket，所有 Ticket 全部委派给子代理执行。** 根据 `/to-tickets` 是否已将 MattPocock Spec 拆分为多个 Ticket 进行分支：已拆分时按 frontier 层级逐层委派子代理（层内并行）；未拆分时委派单个子代理。无论哪种方式，最后都对整个 MattPocock Spec 做 `/code-review`。`state.json` 文件记录全生命周期状态，使得重新运行时从最后一个检查点 **恢复**，而不会重新开始。

Issue tracker 必须已配置——如果缺少 `docs/agents/issue-tracker.md`，请先运行 `/setup-matt-pocock-skills`。

## 核心概念

- **MattPocock Spec** 是原始工作单元——由 `/to-spec` 产出的一个 Issue 或 `.scratch/<feature>/spec.md`。
- **Ticket** 是由 `/to-tickets` 产出的 tracer-bullet 切片。每个 Ticket 声明它的 **blocking edges（阻塞边）**——即必须在其之前完成的其他 Ticket。
- **Frontier** 是其所有阻塞项均已完成的 Ticket 集合。沿着 frontier 逐个推进，blockers 优先。
- **Checkpoint** 是 `.scratch/<feature>/state.json`——记录执行进度的唯一真实来源。在 compaction 或中断后，信任它而非你的记忆。
- **Baseline** 是在任何工作开始前记录的 commit；最终的 `/code-review` 以它为基线进行 diff。

## 流程

### 1. 定位 MattPocock Spec 和 Checkpoint

用户给出一个 MattPocock Spec 引用——Issue 编号/URL，或 `.scratch/<feature>/spec.md` 的路径。按照 `docs/agents/issue-tracker.md` 解析它，获取完整的 MattPocock Spec 正文（以及评论，如果是在真实 Tracker 上）。从路径或 MattPocock Spec 标题推导出 **feature slug**。

Checkpoint 位于 `.scratch/<feature>/state.json`。如果存在则读取它。

完成标准：MattPocock Spec 正文已在上下文中，feature slug 已确定，`state.json` 已读取或确认不存在。

### 2. 恢复或初始化

根据 `state.json` 是否存在且为有效 JSON 进行分支。

#### 恢复

如果 `state.json` 存在且可解析，**不要**重新判断、重新拆分或重新执行已完成的工作。从记录的状态恢复执行：

- `status: "complete"` -> 告知用户 MattPocock Spec 已完成，显示最终评审，停止。
- `status: "reviewing"` -> 跳到步骤 6（最终 `/code-review`）。
- `status: "executing"` -> 从最低的未完成层级开始恢复：找到第一个包含非 `done` Ticket 的层级，将该层中所有 `pending` 和 `in_progress` 的 Ticket 作为当前层级，按步骤 5 的方式重新分派该层（并行）。已 `done` 的 Ticket 跳过——它们的 commit 已经落地；永不重新分派它们。

在恢复之前，用 git 核对 checkpoint：运行 `git rev-parse HEAD` 和 `git log --oneline <baseline>..HEAD`。如果 checkpoint 标记为 `done` 的 Ticket 在该范围内没有对应的 commit，则 checkpoint 已过期——在继续之前标记并询问用户。当两者不一致时，信任 git 而非 checkpoint。

追加一条 `history` 条目：`{ "event": "resumed", "detail": "<恢复位置>" }`。

#### 初始化

如果 `state.json` 不存在或无法解析，则初始化它。首先记录 **baseline**：在任何编辑之前执行 `git rev-parse HEAD`。确认工作树是干净的（`git status --porcelain`）——脏树会将不相关的更改卷入最终评审。如果脏了，请用户先 commit 或 stash。

然后判断 MattPocock Spec 是否已拆分（步骤 3），构建执行计划（步骤 4），并在任何分派之前写入初始的 `state.json`。

完成标准：执行从有效的 `state.json` 运行，且 baseline commit 已记录在其中。

### 3. 判断 MattPocock Spec 是否已拆分

读取 `docs/agents/issue-tracker.md`，根据 Tracker 类型分支：

- **本地 Markdown** -> 列出 `.scratch/<feature>/issues/`。两个或更多 `<NN>-<slug>.md` 文件意味着已拆分；不存在或只有一个文件意味着未拆分。
- **真实 Tracker（GitHub、GitLab...）** -> 获取 MattPocock Spec Issue。如果它有子 Issue / 子任务列表 / 指向其他 Issue 的 `Blocked by` 边，或 `.scratch/<feature>/issues/` 存在且有两个或更多文件，则视为已拆分。

完成标准：得出布尔值 `split` 判定，当已拆分时枚举了每个子 Ticket——不遗漏任何一个。

### 4. 构建执行计划

- **未拆分** -> `mode: "single"`。一个 Ticket，其 `ref` 就是 MattPocock Spec 本身。
- **已拆分** -> `mode: "multi"`。读取每个 Ticket 文件/Issue，解析其 **blocking edges**：`Blocked by:` 行（本地）或 `issue_dependencies_summary.blocked_by` / `Blocked by:` 正文行（GitHub）。记录每个 Ticket 的 `id`（`NN`）、`title`、`blocked_by` 列表和 `status: "pending"`。

计算 **frontier 层级**（拓扑分层）：
- **Level 0**：所有 `blocked_by` 为空的 Ticket（无依赖，可立即开始）。
- **Level 1**：所有 blockers 全部在 Level 0 中的 Ticket。
- **Level N**：所有 blockers 全部在 Level < N 中的 Ticket。

同一层级内的 Ticket 彼此不阻塞，可以**并行委派**；跨层级必须**串行**——上一层级全部完成后，才能开始下一层级。

完成标准：Ticket 按 frontier 层级分组，每个 Ticket 的 `level` 字段已记录，层级间的依赖关系正确。

### 5. 执行

如果是新初始化，立即写入 `state.json`（来自步骤 3-4）。**主代理不直接实施任何 Ticket，全部委派给子代理。** 按 frontier 层级逐层分派：

**逐层推进，层内并行，层间串行。** 对于每个 frontier 层级（`mode: "single"` 时只有一个 Level 0 层，一个 Ticket）：

1. 将该层内所有 `pending` Ticket 标记为 `in_progress`，记录各自的 `start_commit` 和 `started_at`，追加 `history` 条目，写入 `state.json`。
2. **同时分派**该层内每个 Ticket：分派一个子代理，子代理命名为 `"Issue Task - {ticket_title}"`，**显式指定与主代理相同的模型**（不指定时子代理可能继承不一致的默认模型）。分派方式取决于当前 harness（opencode 用 Task 工具，Codex/Claude Code 用 Agent 工具），prompt 如下：

```
/implement 开始实施 {feature-slug} issue {ticket_id}/{total} — "{ticket_title}"

{ticket body}
```

3. 等待该层**所有**子代理返回，然后处理每个结果：
   - **DONE**（测试通过，已提交）-> 标记该 Ticket 为 `done`，记录 `end_commit`（`git rev-parse HEAD`）和 `completed_at`。
   - **BLOCKED**（无法完成）-> 标记该 Ticket 为 `blocked`，附带 `error` 文本。停止整个流程——不要继续到下一层级，阻塞项会阻塞其下游的所有内容。

4. 该层全部处理完后，写入 `state.json`（更新所有 Ticket 状态），追加 `history` 条目。如果该层有 BLOCKED 则停止；否则进入下一层级。

继续直到所有层级处理完毕——即所有 Ticket 都是 `done`。

完成标准：计划中的每个 Ticket 都是 `done`，每个都记录了已落地的 commit，没有跳过任何一个。

### 6. 对整个 MattPocock Spec 做最终 /code-review

每个子代理只关注自己的切片。现在将 **整个 MattPocock Spec** 作为一个 diff 来评审。

先在 `state.json` 中设置 `status: "reviewing"`，这样如果在此处中断，恢复时会进入评审而非重新分派 Ticket。

加载 `/code-review` skill 并运行：
- **Fixed point（固定点）：** `state.json` 中的 `baseline` commit。
- **Diff：** `git diff <baseline>...HEAD`（三点符，针对 merge-base）。
- **MattPocock Spec source：** 步骤 1 中的 MattPocock Spec——将 MattPocock Spec 路径或获取到的正文交给评审者。

`/code-review` 会并行启动其 Standards 和 MattPocock Spec 子代理并汇总结果。将报告呈现给用户。如果它发现了问题，与用户一起决定是否在完成前分派一个携带全部问题列表的修复子代理。

评审完成后，在 `state.json` 中设置 `status: "complete"`，记录 `review.completed_at`，并追加一条最终的 `history` 条目。

完成标准：双轴评审报告已展示，范围覆盖从 baseline 到 HEAD 的完整 MattPocock Spec diff。

### 7. 完成

告知用户：MattPocock Spec 已实施，commit 在 `<branch>` 分支上，范围从 `<baseline>` 到 `<HEAD>`，最终评审已附上。指向 `.scratch/<feature>/state.json` 以获取完整的生命周期记录。

## state.json 结构

Checkpoint 位于 `.scratch/<feature>/state.json`。编排器读取和写入它；权威 schema 见同目录下的 `state-schema.json`：

```
{
  "spec": { "ref": "<Issue #N | 路径>", "title": "...", "tracker": "local|github|gitlab", "feature_slug": "..." },
  "mode": "single | multi",
  "status": "executing | reviewing | complete",
  "baseline": "<任何工作开始前的 commit SHA>",
  "branch": "<当前分支>",
  "created_at": "<ISO 8601（Asia/Shanghai）>",
  "updated_at": "<ISO 8601（Asia/Shanghai）>",
  "tickets": [
    {
      "id": "01", "title": "...", "level": 0, "blocked_by": [],
      "status": "pending | in_progress | done | blocked",
      "status": "pending | in_progress | done | blocked",
      "start_commit": "<sha>", "end_commit": "<sha>",
      "subagent_task_id": "<可选>",
      "error": "<可选，blocked 时>",
      "started_at": "<ISO 8601（Asia/Shanghai）>", "completed_at": "<ISO 8601（Asia/Shanghai）>"
    }
  ],
  "review": { "status": "pending | in_progress | done", "fixed_point": "<sha>", "started_at": "<ISO 8601（Asia/Shanghai）>", "completed_at": "<ISO 8601（Asia/Shanghai）>" },
  "history": [ { "ts": "<ISO 8601（Asia/Shanghai）>", "event": "init | dispatched | done | blocked | resumed | reviewing | complete", "detail": "..." } ]
}
```

每次更新时写入整个文件（它很小）。绝不编辑某个字段而不更新 `updated_at`。

## 设计选择的原因

- **每个 Ticket 一个子代理** 是 `/to-tickets` 规定的 context 清理（"逐个 Ticket 使用 `/implement` 推进 frontier，并在 Ticket 之间清理上下文"）。新子代理是一个干净的窗口，只包含该 Ticket 的切片。
- **层内并行、层间串行**：同一 frontier 层级的 Ticket 彼此不阻塞，可以同时委派多个子代理分别实施，加快执行速度；跨层级 Ticket 有 blocking 依赖，必须等上一层级全部落地后才能开始。
- **`state.json`** 是恢复地图：它命名的 commit 在 git 中存在，即使你的上下文不再记得创建它们。compaction 后，信任 checkpoint 和 `git log` 而非你的记忆。
- **最终的全 MattPocock Spec 评审** 与每个 Ticket 的自我评审是分开的：每个 Ticket 的评审只看到切片，只有全 MattPocock Spec 评审才能捕获跨 Ticket 的遗漏和范围蔓延。

## 红线（绝对禁止）

- **主代理绝不直接实施任何 Ticket**——所有 Ticket 无论是否拆分，全部委派给子代理执行。主代理只负责编排分派和最终评审。
- 同层级内可以并行分派多个子代理，但层级之间必须串行等待。
- 绝不让孩子代理创建分支或 PR——所有工作都作为 commit 落地到当前分支。
- 委派子代理时**必须显式指定模型**——不指定模型时子代理可能继承不一致的默认模型，导致行为差异。使用与主代理完全相同的模型。
- 在多分支路径上，绝不跳过最终的全 MattPocock Spec `/code-review`。
- 绝不重新分派 `state.json` 标记为 `done` 的 Ticket——其 commit 已落地。
- 恢复时绝不重新判断或重新拆分 MattPocock Spec——checkpoint 已经确定了这一点。
- 绝不使用脏的工作树开始工作——不相关的编辑会污染 baseline diff。
- 如果 `state.json` 和 `git log` 对已完成内容不一致，信任 git 并询问用户。