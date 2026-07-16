---
name: execute-mattpocock-spec
description: "全自动执行 MattPocock Spec。仅将 Issue 实施按 frontier 层级逐层委派给子代理（层内并行）；主代理亲自完成最终双轴 code-review 和用户确认的修复，并在完成后自动合并到 main、删除 feature worktree。通过 state.json 断点续传。"
disable-model-invocation: true
---

# Execute MattPocock Spec

将一个 MattPocock Spec 从签署完成的计划推进到经过评审、已提交并合并到 `main` 的代码——并能从中断中恢复。**仅 Issue/Ticket 的实施委派给子代理。** 根据 `to-tickets` skill 是否已将 MattPocock Spec 拆分为多个 Ticket 进行分支：已拆分时按 frontier 层级逐层委派子代理（层内并行）；未拆分时委派单个子代理。主代理亲自对整个 MattPocock Spec 完成最终的双轴 `code-review`，并亲自修复用户确认的发现；随后自动合并 feature 分支到 `main` 并删除 feature worktree。`state.json` 文件记录全生命周期状态，使得重新运行时从最后一个检查点 **恢复**，而不会重新开始。

Issue tracker 必须已配置——如果缺少 `docs/agents/issue-tracker.md`，请先加载并运行 `setup-matt-pocock-skills` skill。

## 核心概念

- **MattPocock Spec** 是原始工作单元——由 `to-spec` skill 产出的一个 Issue 或 `.scratch/<feature>/spec.md`。
- **Ticket** 是由 `to-tickets` skill 产出的 tracer-bullet 切片。每个 Ticket 声明它的 **blocking edges（阻塞边）**——即必须在其之前完成的其他 Ticket。
- **Frontier** 是其所有阻塞项均已完成的 Ticket 集合。沿着 frontier 逐个推进，blockers 优先。
- **Checkpoint** 是 `.scratch/<feature>/state.json`——记录执行进度的唯一真实来源。在 compaction 或中断后，信任它而非你的记忆。
- **Issue checklist** 是本地 Markdown Ticket 文件中用 `- [ ]` 表示的验收项。Ticket 只有在实施完成后将其全部勾选为 `- [x]`，才能记录为 `done`。
- **Baseline** 是在任何工作开始前记录的 commit；最终的 `code-review` 以它为基线进行 diff。
- **Feature worktree** 是为当前 Spec 创建的唯一独立工作目录，绑定 `feat/{feature-slug}` 分支。整个 Spec 仅创建或复用这一个 worktree；所有 Ticket 的实施、测试和评审都在其中进行，主工作树不会切换分支。最终合并成功后必须删除它。
- **Completion Adapter** 执行一个 Frontier，并将各 Ticket 的原生终态规范化为 Completion Result。harness task ID 与原始 agent message 只存在于该 module 的 implementation 内。

## Completion Adapter module

步骤 5 调用同目录的 [Completion Adapter](./COMPLETION-ADAPTER.md)。它拥有 Frontier 的并行分派、原生终态等待、子代理提示中的终态协议，以及对 `completion-result-schema.json` 的验证。编排器只提交 Ticket 内容与 worktree，并接收按 Ticket 关联的 Completion Result。

Completion Adapter 只支持 Codex/Claude 和 OpenCode。没有对应 Adapter 时，它为该 Frontier 的每个 Ticket 返回 `blocked` Completion Result；不得降级为轮询或向编排器暴露 harness 错误。

## 流程

### 1. 定位 MattPocock Spec 和 Checkpoint

用户给出一个 MattPocock Spec 引用——Issue 编号/URL，或 `.scratch/<feature>/spec.md` 的路径。按照 `docs/agents/issue-tracker.md` 解析它，获取完整的 MattPocock Spec 正文（以及评论，如果是在真实 Tracker 上）。从路径或 MattPocock Spec 标题推导出 **feature slug**。

Checkpoint 位于 `.scratch/<feature>/state.json`。如果存在则读取它。

完成标准：MattPocock Spec 正文已在上下文中，feature slug 已确定，`state.json` 已读取或确认不存在。

### 2. 恢复或初始化

根据 `state.json` 是否存在进行分支。存在时必须先解析 JSON；若缺少 `integration`，先执行下述唯一允许的旧版迁移，再依照同目录的权威 `state-schema.json` 验证。其他情况必须在验证通过后才能读取 Checkpoint。

#### 恢复

如果 `state.json` 缺少 `integration`（旧版 Checkpoint），补写 `{ "status": "pending", "target_branch": "main" }`；若原状态为 `"complete"`，同时改为 `"integrating"`，然后验证。这是唯一允许在验证前执行的迁移，不是重新初始化。验证通过后，**不要**重新判断、重新拆分或重新执行已完成的工作。从记录的状态恢复执行：

- `status: "complete"` -> 确认 `integration.status` 为 `done`，告知用户 MattPocock Spec 已合并到 `main`，显示最终评审，停止。
- `status: "reviewing"` -> 跳到步骤 6（最终 `code-review`）。
- `status: "integrating"` -> 跳到步骤 7（合并与清理）；绝不重新评审或重新分派 Ticket。
- `status: "executing"` -> 从最低的未完成层级开始恢复：找到第一个包含非 `done` Ticket 的层级，将该层中所有 `pending` 和 `in_progress` 的 Ticket 作为当前层级，按步骤 5 的方式重新分派该层（并行）。已 `done` 的 Ticket 跳过——它们的 commit 已经落地；永不重新分派它们。

在恢复之前，先记录主工作树根目录：`primary_root=$(git rev-parse --show-toplevel)`。对于 `executing`、`reviewing` 或 `integration.status: "pending"`，确认 `state.json` 的 `worktree` 是绝对路径、目录存在、与 `primary_root` 不同，且 `git -C <worktree> branch --show-current` 与记录的 `branch` 一致。然后在该 worktree 中核对 checkpoint：运行 `git -C <worktree> rev-parse HEAD` 和 `git -C <worktree> log --oneline <baseline>..HEAD`。如果 checkpoint 标记为 `done` 的 Ticket 在该范围内没有对应的 commit，则 checkpoint 已过期——在继续之前标记并询问用户。当两者不一致时，信任 git 而非 checkpoint。对于 `integration.status: "merged"`，feature worktree 已可能被删除；改为验证记录的 `feature_head` 已是 `main` 的祖先，然后只完成步骤 7 尚未完成的清理。

如果记录的 worktree 已不存在，使用 `git worktree list --porcelain` 按 `branch refs/heads/<branch>` 查找它，并排除 `primary_root`。找到独立 worktree 后更新 `state.json` 的 `worktree` 路径；找不到则停止并请用户恢复或指定该 feature 分支的 worktree。不要在主工作树中 checkout 该分支。

追加一条 `history` 条目：`{ "event": "resumed", "detail": "<恢复位置>" }`。

#### 初始化

如果 `state.json` 不存在，则初始化它。若文件存在但 JSON 解析或 Schema 验证失败，停止并请用户修复或恢复 Checkpoint；绝不将其当作新执行初始化。初始化时，首先记录 **baseline**：在任何编辑之前执行 `git rev-parse HEAD`，并记录主工作树根目录 `primary_root=$(git rev-parse --show-toplevel)`。主工作树可以有未提交的其他工作：feature worktree 从 baseline commit 创建，因此不会带入这些改动，也不会要求用户 commit 或 stash。

然后为整个 Spec 创建或复用唯一的独立 feature worktree，而不是在主工作树中 checkout feature 分支。分支名使用 `feat/{feature-slug}`；默认路径为主仓库同级的 `.worktrees/<repository-name>/<feature-slug>`。先运行 `mkdir -p "$(dirname <worktree-path>)"` 创建父目录，再使用 baseline 创建它：`git worktree add -b feat/{feature-slug} <worktree-path> <baseline>`。这会同时创建分支和 worktree，但不会改变主工作树所在的分支；后续各 Ticket 不得另建 worktree。

如果 `feat/{feature-slug}` 已存在，先用 `git worktree list --porcelain` 查找绑定该分支的已注册 worktree，并排除 `primary_root`；存在则复用其路径，否则使用 `git worktree add <worktree-path> feat/{feature-slug}` 创建 worktree。如果该分支只在主工作树中 checkout，停止并请用户先将主工作树切回其他分支，再创建独立 worktree。目标路径已被其他 worktree 或普通目录占用时，也停止并请用户处理；绝不通过 `git checkout` 切换主工作树。

确认新建或复用的 feature worktree 干净后，将 `branch`、绝对路径 `worktree` 和 `integration: { "status": "pending", "target_branch": "main" }` 写入 `state.json`。

从此以后，所有会读取或改变实施结果的 Git 命令都必须在 feature worktree 中执行：`git -C <worktree> …`。编排器仍可从主工作树读写 `.scratch/<feature>/state.json`。

然后判断 MattPocock Spec 是否已拆分（步骤 3），构建执行计划（步骤 4），并在任何分派之前写入初始的 `state.json`。

完成标准：执行从有效的 `state.json` 运行，且 baseline commit、feature branch 和 feature worktree 均已记录；主工作树未切换分支，未提交的主工作树改动未进入 feature worktree。

### 3. 判断 MattPocock Spec 是否已拆分

读取 `docs/agents/issue-tracker.md`，根据 Tracker 类型分支：

- **本地 Markdown** -> 列出 `.scratch/<feature>/issues/`。两个或更多 `<NN>-<slug>.md` 文件意味着已拆分；不存在或只有一个文件意味着未拆分。
- **真实 Tracker（GitHub、GitLab...）** -> 获取 MattPocock Spec Issue。如果它有子 Issue / 子任务列表 / 指向其他 Issue 的 `Blocked by` 边，或 `.scratch/<feature>/issues/` 存在且有两个或更多文件，则视为已拆分。

完成标准：得出布尔值 `split` 判定，当已拆分时枚举了每个子 Ticket——不遗漏任何一个。

### 4. 构建执行计划

- **未拆分** -> `mode: "single"`。一个 `id: "spec"` 的 Ticket，其 Spec 来源始终是顶层 `spec.ref`。
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
2. 调用 Completion Adapter 执行整个 Frontier。它并行分派 Ticket、注入终态协议、等待所有已分派 Ticket 的原生终态，并返回每个 Ticket 的已验证 Completion Result。编排器不得保存或读取 harness task ID。
3. 处理返回的每个 Completion Result：
   - **`done`**（已验证的完成结果）-> 对本地 Markdown Tracker，先在原始 Ticket 文件 `.scratch/<feature>/issues/<NN>-<slug>.md` 中核对验收项已满足，再将其中所有 `- [ ]` 复选框改为 `- [x]`。只有该文件已更新且不再包含未勾选复选框后，才能标记该 Ticket 为 `done`，并记录 `end_commit`（`git -C <worktree> rev-parse HEAD`）和 `completed_at`。未拆分的本地 Spec 同样处理其源 Markdown 文件；没有复选框的文件无需修改。若无法更新 Issue 文件或仍有未勾选项，则将 Ticket 标记为 `blocked` 并停止流程。真实 Tracker 不存在本地 Issue 文件时不适用此步骤。
   - **`blocked`**（已验证的阻塞结果）-> 标记该 Ticket 为 `blocked`，附带 Completion Result 的非空 `error`；不得写入 `end_commit` 或 `completed_at`。停止整个流程——不要继续到下一层级，阻塞项会阻塞其下游的所有内容。

4. 该层全部处理完后，写入 `state.json`（更新所有 Ticket 状态），追加 `history` 条目。如果该层有 `blocked` 结果则停止；否则进入下一层级。

继续直到所有层级处理完毕——即所有 Ticket 都是 `done`。

完成标准：计划中的每个 Ticket 都是 `done`，每个都记录了已落地的 commit；每个对应的本地 Issue 文件的复选框均已勾选，没有跳过任何一个。

### 6. 最终 `code-review` 与修复循环

每个 Issue 子代理只关注自己的切片。现在由主代理将 **整个 MattPocock Spec** 作为一个 diff 来评审；用户确认要修复的发现也由主代理直接修复。

先在 `state.json` 中设置 `status: "reviewing"`，这样如果在此处中断，恢复时会进入评审而非重新分派 Ticket。

#### 6a. 执行评审

主代理必须直接在 `<worktree>` 中完成双轴 `code-review`，**不得调用会创建 Standards / Spec 子代理的 `code-review` skill，也不得通过任何 Agent/Task 工具委派评审。** 以该 skill 的审查标准作为参考，但在当前主代理上下文中执行以下工作：

1. 以 `state.json` 中的 `baseline` 为固定点，检查 `git -C <worktree> diff <baseline>...HEAD`（三点符，针对 merge-base）及 `git -C <worktree> log <baseline>..HEAD --oneline`。
2. 读取仓库的编码规范来源，以及 `code-review` skill 所定义的 smell baseline；审核 Standards 轴。
3. 读取步骤 1 获取的 MattPocock Spec source；审核 Spec 轴。
4. 在主代理的评审结果中分列 `## Standards` 与 `## Spec`，逐项给出文件/代码位置、依据、严重程度和修复建议；任一轴没有发现时明确写出。

不要在主工作树中评审或修复 feature diff。如果评审**无任何发现**，跳到步骤 6c。

#### 6b. 修复循环

如果评审有发现，执行以下循环：

1. **列出全部问题**——将 Standards 和 Spec 两个轴的所有发现合并为一个完整列表，逐条编号呈现给用户。每条标注来源（Standards / Spec）和严重程度。

2. **询问用户要修复的项**——用户确认哪些项需要修复。不要自行决定跳过任何项。

3. **主代理直接修复**——主代理在 `<worktree>` 中逐一修复用户确认的所有问题，运行受影响的测试，并将修复提交到 feature worktree 当前分支 `<branch>`。不得创建任何子代理；将 `state.json.review` 和 `history` 更新为修复中的实际进度。

4. **修复完成后重新评审**——主代理回到步骤 6a，使用相同的 baseline 和 spec source 重新完成双轴 `code-review`。diff 范围不变。

5. 重复 6a → 6b 循环，直到 `code-review` 无任何发现，或用户确认不再修复。

#### 6c. 完成评审

记录 `review.completed_at` 和 `review.findings_summary`，并将 `state.json.status` 设置为 `"integrating"`；此时尚未完成，必须继续步骤 7。

完成标准：`code-review` 双轴均无发现，或用户确认不再修复，且 Checkpoint 已进入 `integrating`。

### 7. 自动合并到 `main` 并清理 worktree

仅在所有 Ticket 都已完成、最终评审完成，且 feature worktree 中的所有变更均已提交后执行。主代理亲自完成此步骤，不委派给子代理。

1. 将 `state.json.status` 设为 `"integrating"`，记录 `integration.feature_head=$(git -C <worktree> rev-parse HEAD)` 并写入 Checkpoint。确认 `git -C <worktree> status --porcelain` 为空；不为空则停止，绝不合并或删除 worktree。
2. 通过 `git worktree list --porcelain` 找到唯一 checkout `refs/heads/main` 的 worktree，记为 `<main-worktree>`。若不存在，或 `git -C <main-worktree> status --porcelain` 非空，停止并告知用户；不得切换主工作树、stash 或覆盖其改动。
3. 在 `<main-worktree>` 执行 `git merge --no-edit <branch>`。发生冲突时立即执行 `git merge --abort`，保持 feature worktree，记录阻塞原因并停止。合并成功后，验证 `git merge-base --is-ancestor <feature_head> main`，记录 `integration.status: "merged"`、`main_worktree`、合并后的 `main` HEAD 和时间，并写入 Checkpoint。
4. 执行 `git worktree remove <worktree>` 删除 feature worktree。若删除失败，保留 `integration.status: "merged"` 并停止；下次恢复只重试删除，绝不再次合并。删除成功后记录清理时间，将 `integration.status` 和顶层 `status` 都设为 `"done"` / `"complete"`，追加最终 `complete` history 条目并验证 Checkpoint。

完成标准：feature HEAD 已包含在 `main`，feature worktree 已删除，Checkpoint 的 `status` 为 `complete` 且 `integration.status` 为 `done`。

### 8. 告知用户

告知用户：MattPocock Spec 已实施并合并到 `main`，范围从 `<baseline>` 到 `<feature_head>`，feature worktree 已删除，最终评审已附上。指向 `.scratch/<feature>/state.json` 以获取完整的生命周期记录。

## Checkpoint 契约

Checkpoint 位于 `.scratch/<feature>/state.json`。同目录的 `state-schema.json` 是字段和局部状态约束的唯一权威来源；每次读取已有 Checkpoint 前、以及每次写入后都必须验证它。

- Spec 来源只写在顶层 `spec.ref`；Ticket 使用唯一的 `blocked_by` 表示依赖。
- `in_progress` Ticket 必须记录 `start_commit` 与 `started_at`。
- `done` Ticket 必须记录 `end_commit` 与 `completed_at`。
- `blocked` Ticket 必须记录非空 `error`，且不得有 `end_commit` 或 `completed_at`。
- `review.status: "done"` 必须记录非空 `findings_summary` 与 `completed_at`。
- `integration.status: "merged"` 必须记录 feature HEAD、承载 `main` 的 worktree、合并后的 main HEAD 和合并时间；`"done"` 还必须记录 feature worktree 的删除时间。
- Schema 只验证单条记录的局部事实；Ticket 汇总、状态先后与 Git 真实性由编排器验证。

每次更新时写入整个文件（它很小）。绝不编辑某个字段而不更新 `updated_at`。

## 设计选择的原因

- **每个 Ticket 一个子代理** 是 `to-tickets` skill 规定的 context 清理（"逐个 Ticket 使用 `implement` skill 推进 frontier，并在 Ticket 之间清理上下文"）。新子代理是一个干净的窗口，只包含该 Ticket 的切片。
- **层内并行、层间串行**：同一 frontier 层级的 Ticket 彼此不阻塞，可以同时委派多个子代理分别实施，加快执行速度；跨层级 Ticket 有 blocking 依赖，必须等上一层级全部落地后才能开始。
- **`state.json`** 是恢复地图：它命名的 commit 在 git 中存在，即使你的上下文不再记得创建它们。compaction 后，信任 checkpoint 和 `git log` 而非你的记忆。
- **独立 feature worktree** 将实施分支与主工作树隔离：即使主工作树有未提交的其他工作，也可以继续留在 main/master 处理其他事项；整个 Spec 只使用这一个 feature worktree，所有 Ticket、测试和评审均影响它。只有完成并提交、评审结束后，才将其合并到干净的 `main` 并删除。
- **最终的全 MattPocock Spec 评审** 与每个 Ticket 的自我评审是分开的：每个 Ticket 的评审只看到切片，只有全 MattPocock Spec 评审才能捕获跨 Ticket 的遗漏和范围蔓延。
- **Completion Adapter** 将分派、原生终态等待和结果验证集中在一个 module：编排器只处理一个 Frontier 的 Completion Result，而不会产生定时状态轮询。

## 红线（绝对禁止）

- **只有 Issue/Ticket 的实施可以委派给子代理**——所有 Ticket 无论是否拆分，全部由子代理执行；最终评审和评审发现的修复均由主代理执行。
- **最终 `code-review` 不得委派**——主代理必须亲自完成 Standards 与 Spec 两个轴的审核，不得调用或使用会创建评审子代理的工作流。
- **用户确认的评审修复不得委派**——主代理直接在 feature worktree 中编辑、测试并提交，随后亲自重新评审。
- **每个 Spec 只创建或复用一个 feature worktree**——不得按 Ticket 创建 worktree；每个 Ticket 的子代理均使用 `state.json.worktree`。
- 同层级内可以并行分派多个子代理，但层级之间必须串行等待。
- 绝不让孩子代理创建分支、worktree 或 PR——所有工作都作为 commit 落地到 feature worktree 当前分支。
- 委派子代理时**必须显式指定模型**——不指定模型时子代理可能继承不一致的默认模型，导致行为差异。使用与主代理完全相同的模型。
- **绝不轮询子代理状态**——只等待/订阅 harness 的原生终态通知；没有该能力的 harness 不支持此 skill 的并行执行。
- 在多分支路径上，绝不跳过最终的全 MattPocock Spec `code-review`。
- 绝不重新分派 `state.json` 标记为 `done` 的 Ticket——其 commit 已落地。
- 对含复选框的本地 Issue 文件，绝不在将其所有复选框勾选为 `- [x]` 前把对应 Ticket 标为 `done`。
- 恢复时绝不重新判断或重新拆分 MattPocock Spec——checkpoint 已经确定了这一点。
- 实施开始前**必须创建独立 Git worktree**（绑定 `feat/{feature-slug}`），绝不在主工作树中 checkout feature 分支或直接在 main/master 分支上执行。
- 绝不使用脏的 **feature worktree** 开始工作——不相关的编辑会污染 baseline diff；主工作树可保留未提交的其他工作。
- **完成后必须自动合并到 `main` 并删除 feature worktree**——仅当 feature worktree 和承载 `main` 的 worktree 都干净时执行；合并冲突、`main` 脏或清理失败时停止并保留 feature worktree，绝不丢弃或覆盖改动。
- 如果 `state.json` 和 `git log` 对已完成内容不一致，信任 git 并询问用户。
