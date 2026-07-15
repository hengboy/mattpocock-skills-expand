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
- **Feature worktree** 是为当前 Spec 创建的独立工作目录，绑定 `feat/{feature-slug}` 分支。所有实施和评审都在其中进行，主工作树不会切换分支。

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

在恢复之前，先记录主工作树根目录：`primary_root=$(git rev-parse --show-toplevel)`。确认 `state.json` 的 `worktree` 是绝对路径、目录存在、与 `primary_root` 不同，且 `git -C <worktree> branch --show-current` 与记录的 `branch` 一致。然后在该 worktree 中核对 checkpoint：运行 `git -C <worktree> rev-parse HEAD` 和 `git -C <worktree> log --oneline <baseline>..HEAD`。如果 checkpoint 标记为 `done` 的 Ticket 在该范围内没有对应的 commit，则 checkpoint 已过期——在继续之前标记并询问用户。当两者不一致时，信任 git 而非 checkpoint。

如果记录的 worktree 已不存在，使用 `git worktree list --porcelain` 按 `branch refs/heads/<branch>` 查找它，并排除 `primary_root`。找到独立 worktree 后更新 `state.json` 的 `worktree` 路径；找不到则停止并请用户恢复或指定该 feature 分支的 worktree。不要在主工作树中 checkout 该分支。

追加一条 `history` 条目：`{ "event": "resumed", "detail": "<恢复位置>" }`。

#### 初始化

如果 `state.json` 不存在或无法解析，则初始化它。首先记录 **baseline**：在任何编辑之前执行 `git rev-parse HEAD`，并记录主工作树根目录 `primary_root=$(git rev-parse --show-toplevel)`。主工作树可以有未提交的其他工作：feature worktree 从 baseline commit 创建，因此不会带入这些改动，也不会要求用户 commit 或 stash。

然后创建独立的 feature worktree，而不是在主工作树中 checkout feature 分支。分支名使用 `feat/{feature-slug}`；默认路径为主仓库同级的 `.worktrees/<repository-name>/<feature-slug>`。先运行 `mkdir -p "$(dirname <worktree-path>)"` 创建父目录，再使用 baseline 创建它：`git worktree add -b feat/{feature-slug} <worktree-path> <baseline>`。这会同时创建分支和 worktree，但不会改变主工作树所在的分支。

如果 `feat/{feature-slug}` 已存在，先用 `git worktree list --porcelain` 查找绑定该分支的已注册 worktree，并排除 `primary_root`；存在则复用其路径，否则使用 `git worktree add <worktree-path> feat/{feature-slug}` 创建 worktree。如果该分支只在主工作树中 checkout，停止并请用户先将主工作树切回其他分支，再创建独立 worktree。目标路径已被其他 worktree 或普通目录占用时，也停止并请用户处理；绝不通过 `git checkout` 切换主工作树。确认新建或复用的 feature worktree 干净后，将 `branch` 和绝对路径 `worktree` 写入 `state.json`。

从此以后，所有会读取或改变实施结果的 Git 命令都必须在 feature worktree 中执行：`git -C <worktree> …`。编排器仍可从主工作树读写 `.scratch/<feature>/state.json`。

然后判断 MattPocock Spec 是否已拆分（步骤 3），构建执行计划（步骤 4），并在任何分派之前写入初始的 `state.json`。

完成标准：执行从有效的 `state.json` 运行，且 baseline commit、feature branch 和 feature worktree 均已记录；主工作树未切换分支，未提交的主工作树改动未进入 feature worktree。

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
2. **同时分派**该层内每个 Ticket：分派一个子代理，子代理命名为 `"Issue Task - {ticket_title}"`，**显式指定与主代理相同的模型**（不指定时子代理可能继承不一致的默认模型）。分派方式取决于当前 harness（opencode 用 Task 工具，Codex/Claude Code 用 Agent 工具），并明确让子代理只在 `state.json` 记录的 feature worktree 中工作；prompt 如下：

```
/implement 开始实施 {feature-slug} issue {ticket_id}/{total} — "{ticket_title}"

{ticket body}

工作目录：{worktree}
仅在此 worktree 中编辑、测试和提交；不要创建分支、worktree 或 PR。
```

3. 等待该层**所有**子代理返回，然后处理每个结果：
   - **DONE**（测试通过，已提交）-> 标记该 Ticket 为 `done`，记录 `end_commit`（`git -C <worktree> rev-parse HEAD`）和 `completed_at`。
   - **BLOCKED**（无法完成）-> 标记该 Ticket 为 `blocked`，附带 `error` 文本。停止整个流程——不要继续到下一层级，阻塞项会阻塞其下游的所有内容。

4. 该层全部处理完后，写入 `state.json`（更新所有 Ticket 状态），追加 `history` 条目。如果该层有 BLOCKED 则停止；否则进入下一层级。

继续直到所有层级处理完毕——即所有 Ticket 都是 `done`。

完成标准：计划中的每个 Ticket 都是 `done`，每个都记录了已落地的 commit，没有跳过任何一个。

### 6. 最终 `/code-review` 与修复循环

每个子代理只关注自己的切片。现在将 **整个 MattPocock Spec** 作为一个 diff 来评审，发现的问题必须全部修复。

先在 `state.json` 中设置 `status: "reviewing"`，这样如果在此处中断，恢复时会进入评审而非重新分派 Ticket。

#### 6a. 执行评审

主代理直接在 `<worktree>` 上下文中加载并执行 `/code-review` **skill**；`/code-review` 不是可通过 Agent/Task 工具委派的子代理。若其流程需要 Standards 和 Spec 子代理，由该 skill 按自身规则创建和汇总。然后提供：
- **Fixed point（固定点）：** `state.json` 中的 `baseline` commit。
- **Diff：** `git -C <worktree> diff <baseline>...HEAD`（三点符，针对 merge-base）。
- **MattPocock Spec source：** 步骤 1 中的 MattPocock Spec——将 MattPocock Spec 路径或获取到的正文交给评审者。

不要为 `/code-review` 创建子代理任务，也不要在主工作树中评审或修复 feature diff。

`/code-review` 会并行启动其 Standards 和 Spec 子代理并汇总结果。如果评审**无任何发现**，跳到步骤 6c。

#### 6b. 修复循环

如果评审有发现，执行以下循环：

1. **列出全部问题**——将 Standards 和 Spec 两个轴的所有发现合并为一个完整列表，逐条编号呈现给用户。每条标注来源（Standards / Spec）和严重程度。

2. **询问用户要修复的项**——用户确认哪些项需要修复。不要自行决定跳过任何项。

3. **委派子代理修复**——将用户确认的修复项合并为一个修复任务，委派一个子代理执行（子代理命名为 `"Issue Task - Fix Review Issues"`，使用与主代理相同的模型），prompt 如下：

```
/implement 修复 {feature-slug} 的 code-review 问题

以下问题需要修复：
{逐条列出用户确认的问题，含来源文件和具体描述}

要求：
- 逐一修复上述所有问题
- 修复后运行受影响的测试，确保通过
- 工作目录：{worktree}
- 仅在此 worktree 中编辑、测试和提交；不要创建分支、worktree 或 PR
- 将修复提交到 feature worktree 的当前分支：<branch>
- 返回：DONE | BLOCKED，commits，tests 摘要
```

4. **修复完成后重新评审**——修复子代理提交后，回到步骤 6a 重新执行 `/code-review`。使用相同的 baseline 和 spec source，diff 范围不变。

5. 重复 6a → 6b 循环，直到 `/code-review` 无任何发现，或用户确认不再修复。

#### 6c. 完成评审

在 `state.json` 中设置 `status: "complete"`，记录 `review.completed_at` 和 `review.findings_summary`，追加一条最终的 `history` 条目。

完成标准：`/code-review` 双轴均无发现，或用户确认不再修复，`state.json` 状态为 `complete`。

### 7. 完成

告知用户：MattPocock Spec 已实施，commit 在 `<branch>` 分支的 `<worktree>` 中，范围从 `<baseline>` 到 `<HEAD>`，最终评审已附上。指向 `.scratch/<feature>/state.json` 以获取完整的生命周期记录。

## state.json 结构

Checkpoint 位于 `.scratch/<feature>/state.json`。编排器读取和写入它；权威 schema 见同目录下的 `state-schema.json`：

```
{
  "spec": { "ref": "<Issue #N | 路径>", "title": "...", "tracker": "local|github|gitlab", "feature_slug": "..." },
  "mode": "single | multi",
  "status": "executing | reviewing | complete",
  "baseline": "<任何工作开始前的 commit SHA>",
  "branch": "feat/<feature-slug>",
  "worktree": "<feature worktree 的绝对路径>",
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
  "history": [ { "ts": "<ISO 8601（Asia/Shanghai）>", "event": "init | dispatched | done | blocked | resumed | reviewing | fixing | complete", "detail": "..." } ]
}
```

每次更新时写入整个文件（它很小）。绝不编辑某个字段而不更新 `updated_at`。

## 设计选择的原因

- **每个 Ticket 一个子代理** 是 `/to-tickets` 规定的 context 清理（"逐个 Ticket 使用 `/implement` 推进 frontier，并在 Ticket 之间清理上下文"）。新子代理是一个干净的窗口，只包含该 Ticket 的切片。
- **层内并行、层间串行**：同一 frontier 层级的 Ticket 彼此不阻塞，可以同时委派多个子代理分别实施，加快执行速度；跨层级 Ticket 有 blocking 依赖，必须等上一层级全部落地后才能开始。
- **`state.json`** 是恢复地图：它命名的 commit 在 git 中存在，即使你的上下文不再记得创建它们。compaction 后，信任 checkpoint 和 `git log` 而非你的记忆。
- **独立 feature worktree** 将实施分支与主工作树隔离：即使主工作树有未提交的其他工作，也可以继续留在 main/master 处理其他事项；所有 Ticket、测试和评审只影响 feature worktree。
- **最终的全 MattPocock Spec 评审** 与每个 Ticket 的自我评审是分开的：每个 Ticket 的评审只看到切片，只有全 MattPocock Spec 评审才能捕获跨 Ticket 的遗漏和范围蔓延。

## 红线（绝对禁止）

- **主代理绝不直接实施任何 Ticket**——所有 Ticket 无论是否拆分，全部委派给子代理执行。主代理只负责编排分派和最终评审。
- **最终 `/code-review` 是主代理直接执行的 skill，不是子代理**；其内部的 Standards / Spec 评审代理由该 skill 自行管理。
- 同层级内可以并行分派多个子代理，但层级之间必须串行等待。
- 绝不让孩子代理创建分支、worktree 或 PR——所有工作都作为 commit 落地到 feature worktree 当前分支。
- 委派子代理时**必须显式指定模型**——不指定模型时子代理可能继承不一致的默认模型，导致行为差异。使用与主代理完全相同的模型。
- 在多分支路径上，绝不跳过最终的全 MattPocock Spec `/code-review`。
- 绝不重新分派 `state.json` 标记为 `done` 的 Ticket——其 commit 已落地。
- 恢复时绝不重新判断或重新拆分 MattPocock Spec——checkpoint 已经确定了这一点。
- 实施开始前**必须创建独立 Git worktree**（绑定 `feat/{feature-slug}`），绝不在主工作树中 checkout feature 分支或直接在 main/master 分支上执行。
- 绝不使用脏的 **feature worktree** 开始工作——不相关的编辑会污染 baseline diff；主工作树可保留未提交的其他工作。
- 如果 `state.json` 和 `git log` 对已完成内容不一致，信任 git 并询问用户。
