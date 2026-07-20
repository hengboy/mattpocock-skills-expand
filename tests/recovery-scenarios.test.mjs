import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createCheckpoint, readCheckpoint, writeCheckpoint } from "../skills/execute-mattpocock-spec/lib/checkpoint.mjs";
import { verifyCheckpointIntegrity } from "../skills/execute-mattpocock-spec/lib/checkpoint-integrity.mjs";
import { createNativeAdapter } from "../skills/execute-mattpocock-spec/lib/completion-adapter.mjs";
import { createExecutionCoordinator } from "../skills/execute-mattpocock-spec/lib/execution-coordinator.mjs";
import { currentHead } from "../skills/execute-mattpocock-spec/lib/git.mjs";
import { materializeLocalPlan, writePlan } from "../skills/execute-mattpocock-spec/lib/plan.mjs";
import { createFeatureWorktree, ensureFeatureWorktree } from "../skills/execute-mattpocock-spec/lib/worktree-lifecycle.mjs";

const exec = promisify(execFile);

async function git(cwd, ...args) {
  await exec("git", args, { cwd });
}

async function gitOutput(cwd, ...args) {
  return (await exec("git", args, { cwd })).stdout.trim();
}

test("recovers a missing feature worktree from its committed Plan and Checkpoint", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "spec-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  const source = join(root, "source");
  await mkdir(join(source, "issues"), { recursive: true });
  await writeFile(join(root, "README.md"), "base\n");
  await writeFile(join(source, "spec.md"), "# Example\n");
  await writeFile(join(source, "issues", "01-first.md"), "# First\n- [ ] works\n");
  await writeFile(join(source, "issues", "02-second.md"), "# Second\nBlocked by: 01\n- [ ] follows\n");
  await git(root, "add", "README.md", "source");
  await git(root, "commit", "-m", "baseline");
  const baseline = await currentHead(root);
  const worktree = join(root, "nested", "feature-worktree");
  await createFeatureWorktree({ repository: root, branch: "feat/example", baseline, path: worktree });
  const plan = await materializeLocalPlan({ mainWorktree: root, specPath: join(source, "spec.md"), issuesDirectory: join(source, "issues"), featureSlug: "example", now: "2026-07-17T08:00:00+08:00" });
  await writePlan(root, plan);
  const checkpoint = createCheckpoint({ plan, baseline, branch: "feat/example", worktree, now: "2026-07-17T08:00:00+08:00" });
  await writeCheckpoint(root, "example", checkpoint);
  await git(root, "add", ".scratch");
  await git(root, "commit", "-m", "initialize execution");
  await writeFile(join(worktree, "implementation.txt"), "done\n");
  await git(worktree, "add", "implementation.txt");
  await git(worktree, "commit", "-m", "implement first ticket");
  checkpoint.tickets[0] = { id: "01", status: "done", end_commit: await currentHead(worktree), completed_at: "2026-07-17T08:01:00+08:00" };
  checkpoint.updated_at = "2026-07-17T08:01:00+08:00";
  await writeCheckpoint(root, "example", checkpoint);
  await git(root, "add", ".scratch/example/checkpoint.json");
  await git(root, "commit", "-m", "checkpoint first ticket");
  assert.equal((await verifyCheckpointIntegrity({ worktree: root, featureWorktree: worktree, featureSlug: "example" })).status, "valid");
  await git(root, "worktree", "remove", worktree);
  const restored = await ensureFeatureWorktree({ repository: root, branch: "feat/example", path: worktree });
  assert.equal(restored.created, true);
  assert.equal((await verifyCheckpointIntegrity({ worktree: root, featureWorktree: restored.worktree, featureSlug: "example" })).status, "valid");
});

test("commits execution records while restoring unrelated main worktree changes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "spec-main-changes-"));
  const worktreePath = `${root}-feature`;
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(worktreePath, { recursive: true, force: true })]));
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  const source = join(root, "source");
  await mkdir(join(source, "issues"), { recursive: true });
  await writeFile(join(root, "README.md"), "base\n");
  await writeFile(join(source, "spec.md"), "# Example\n");
  await writeFile(join(source, "issues", "01-works.md"), "# Integration work\n- [ ] implemented\n");
  await git(root, "add", "README.md", "source");
  await git(root, "commit", "-m", "baseline");

  const adapter = createNativeAdapter({
    spawn: async ({ ticket, worktree, readTicket }) => {
      assert.equal(readTicket, undefined);
      assert.equal(ticket.ref, "source/issues/01-works.md");
      assert.equal(await readFile(join(worktree, ticket.ref), "utf8"), "# Integration work\n- [ ] implemented\n");
      await writeFile(join(worktree, `${ticket.id}.txt`), "implemented\n");
      await git(worktree, "add", `${ticket.id}.txt`);
      await git(worktree, "commit", "-m", `implement ${ticket.id}`);
      return { ticket, worktree, commit: await currentHead(worktree) };
    },
    collect: async (task) => `RESULT: DONE\nCOMMITS: ${task.commit}\nTESTS: none\nSUMMARY: ${task.ticket.id}`,
  });
  const coordinator = createExecutionCoordinator({
    adapter,
    now: () => "2026-07-17T08:00:00+08:00",
    generateCommitMessage: async () => ":memo: 记录 Example 的执行结果",
  });
  await coordinator.initialize({
    repository: root,
    branch: "feat/example",
    worktreePath,
    tracker: { tracker: "local", specPath: join(source, "spec.md"), issuesDirectory: join(source, "issues"), featureSlug: "example", now: "2026-07-17T08:00:00+08:00" },
  });
  await writeFile(join(root, "README.md"), "uncommitted\n");
  await writeFile(join(root, "staged.md"), "staged\n");
  await git(root, "add", "staged.md");
  await writeFile(join(root, "notes.md"), "untracked\n");

  const complete = await coordinator.run({
    repository: root,
    branch: "feat/example",
    featureSlug: "example",
    worktreePath,
    review: async () => ({ approved: true, findingsSummary: "no findings" }),
  });

  assert.equal(complete.status, "complete");
  assert.equal(await readFile(join(root, "README.md"), "utf8"), "uncommitted\n");
  assert.equal(await readFile(join(root, "staged.md"), "utf8"), "staged\n");
  assert.equal(await readFile(join(root, "notes.md"), "utf8"), "untracked\n");
  assert.equal(await gitOutput(root, "diff", "--name-only"), "README.md");
  assert.equal(await gitOutput(root, "diff", "--cached", "--name-only"), "staged.md");
  assert.equal((await gitOutput(root, "status", "--porcelain")).includes("?? notes.md"), true);
  assert.equal(await gitOutput(root, "stash", "list"), "");
  assert.equal((await gitOutput(root, "show", "--name-only", "--format=", "HEAD")).includes(".scratch/example/checkpoint.json"), true);
});

test("retains the stash when restoring a main change conflicts with merged code", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "spec-stash-conflict-"));
  const worktreePath = `${root}-feature`;
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(worktreePath, { recursive: true, force: true })]));
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  const source = join(root, "source");
  await mkdir(join(source, "issues"), { recursive: true });
  await writeFile(join(root, "README.md"), "base\n");
  await writeFile(join(source, "spec.md"), "# Example\n");
  await writeFile(join(source, "issues", "01-works.md"), "# Integration work\n- [ ] implemented\n");
  await git(root, "add", "README.md", "source");
  await git(root, "commit", "-m", "baseline");

  const adapter = createNativeAdapter({
    spawn: async ({ ticket, worktree }) => {
      await writeFile(join(worktree, "README.md"), "feature\n");
      await git(worktree, "add", "README.md");
      await git(worktree, "commit", "-m", `implement ${ticket.id}`);
      return { ticket, worktree, commit: await currentHead(worktree) };
    },
    collect: async (task) => `RESULT: DONE\nCOMMITS: ${task.commit}\nTESTS: none\nSUMMARY: ${task.ticket.id}`,
  });
  const coordinator = createExecutionCoordinator({
    adapter,
    now: () => "2026-07-17T08:00:00+08:00",
    generateCommitMessage: async () => ":memo: 记录 Example 的执行结果",
  });
  await coordinator.initialize({
    repository: root,
    branch: "feat/example",
    worktreePath,
    tracker: { tracker: "local", specPath: join(source, "spec.md"), issuesDirectory: join(source, "issues"), featureSlug: "example", now: "2026-07-17T08:00:00+08:00" },
  });
  await writeFile(join(root, "README.md"), "main\n");

  await assert.rejects(
    coordinator.run({
      repository: root,
      branch: "feat/example",
      featureSlug: "example",
      worktreePath,
      review: async () => ({ approved: true, findingsSummary: "no findings" }),
    }),
    /Could not restore unrelated main worktree changes from stash [0-9a-f]+/,
  );
  assert.equal((await gitOutput(root, "stash", "list")).includes("execute-mattpocock-spec:example"), true);
  assert.equal((await readCheckpoint(root, "example")).integration.status, "done");
  assert.equal((await gitOutput(root, "show", "--name-only", "--format=", "HEAD")).includes(".scratch/example/checkpoint.json"), true);
});

test("reports an exact diagnostic when a completed Ticket commit is absent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "spec-integrity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  const source = join(root, "source");
  await mkdir(source);
  await writeFile(join(root, "README.md"), "base\n");
  await writeFile(join(source, "spec.md"), "# Example\n");
  await git(root, "add", "README.md", "source");
  await git(root, "commit", "-m", "baseline");
  const baseline = await currentHead(root);
  const worktree = join(root, "nested", "feature-worktree");
  await createFeatureWorktree({ repository: root, branch: "feat/example", baseline, path: worktree });
  const plan = await materializeLocalPlan({ mainWorktree: root, specPath: join(source, "spec.md"), issuesDirectory: join(source, "issues"), featureSlug: "example", now: "2026-07-17T08:00:00+08:00" });
  await writePlan(root, plan);
  const checkpoint = createCheckpoint({ plan, baseline, branch: "feat/example", worktree, now: "2026-07-17T08:00:00+08:00" });
  checkpoint.tickets[0] = { id: "spec", status: "done", end_commit: "d".repeat(40), completed_at: "2026-07-17T08:01:00+08:00" };
  await writeCheckpoint(root, "example", checkpoint);
  const result = await verifyCheckpointIntegrity({ worktree: root, featureWorktree: worktree, featureSlug: "example" });
  assert.equal(result.status, "invalid");
  assert.deepEqual(result.diagnostics, [{ code: "ticket-commit-missing", detail: `spec:${"d".repeat(40)}` }]);
});

test("coordinates the complete lifecycle and persists completion on main", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "spec-coordinator-"));
  const worktreePath = `${root}-feature`;
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(worktreePath, { recursive: true, force: true })]));
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  const source = join(root, "source");
  await mkdir(join(source, "issues"), { recursive: true });
  await writeFile(join(root, "README.md"), "base\n");
  await writeFile(join(source, "spec.md"), "# Example\n");
  await writeFile(join(source, "issues", "01-works.md"), "# Works\n- [ ] implemented\n");
  await writeFile(join(source, "issues", "02-also-works.md"), "# Also works\nBlocked by: 01\n- [ ] implemented\n");
  await git(root, "add", "README.md", "source");
  await git(root, "commit", "-m", "baseline");
  const baseline = await currentHead(root);
  const adapter = createNativeAdapter({
    spawn: async ({ ticket, worktree }) => {
      await writeFile(join(worktree, `${ticket.id}.txt`), "implemented\n");
      await git(worktree, "add", `${ticket.id}.txt`);
      await git(worktree, "commit", "-m", `implement ${ticket.id}`);
      return { ticket, worktree, commit: await currentHead(worktree) };
    },
    collect: async (task) => `RESULT: DONE\nCOMMITS: ${task.commit}\nTESTS: none\nSUMMARY: ${task.ticket.id}`,
  });
  const generatedMessages = [];
  const coordinator = createExecutionCoordinator({
    adapter,
    now: () => "2026-07-17T08:00:00+08:00",
    generateCommitMessage: async ({ plan, files }) => {
      generatedMessages.push({ title: plan.spec.title, files: [...files].sort() });
      return ":memo: 记录 Example 的执行结果";
    },
  });
  let reviewAttempts = 0;
  const review = async ({ readTicket }) => {
    assert.equal(await readTicket("01"), "# Works\n- [x] implemented\n");
    assert.equal(await readTicket("02"), "# Also works\nBlocked by: 01\n- [x] implemented\n");
    assert.equal(await currentHead(root), baseline, "execution records must remain uncommitted until review passes");
    assert.deepEqual(
      [
        ...(await gitOutput(root, "diff", "--name-only")).split("\n"),
        ...(await gitOutput(root, "ls-files", "--others", "--exclude-standard")).split("\n"),
      ].sort(),
      [
        ".scratch/example/checkpoint.json",
        ".scratch/example/plan.json",
        "source/issues/01-works.md",
        "source/issues/02-also-works.md",
      ],
    );
    if (reviewAttempts++ === 0) return { approved: false, findingsSummary: "finding requires a fix" };
    return { approved: true, findingsSummary: "no findings" };
  };
  const reviewing = await coordinator.run({
    repository: root,
    branch: "feat/example",
    featureSlug: "example",
    worktreePath,
    tracker: { tracker: "local", specPath: join(source, "spec.md"), issuesDirectory: join(source, "issues"), featureSlug: "example", now: "2026-07-17T08:00:00+08:00" },
    review,
  });
  assert.equal(reviewing.status, "reviewing");
  assert.equal(await currentHead(root), baseline, "a failed review must not commit execution records");
  assert.deepEqual(generatedMessages, [], "a failed review must not generate a commit message");
  const complete = await coordinator.run({
    repository: root,
    branch: "feat/example",
    featureSlug: "example",
    worktreePath,
    review,
  });
  assert.equal(complete.status, "complete");
  assert.equal((await verifyCheckpointIntegrity({ worktree: root, featureSlug: "example" })).status, "valid");
  assert.equal(await readFile(join(source, "issues", "01-works.md"), "utf8"), "# Works\n- [x] implemented\n");
  assert.equal(await readFile(join(source, "issues", "02-also-works.md"), "utf8"), "# Also works\nBlocked by: 01\n- [x] implemented\n");
  assert.deepEqual((await gitOutput(root, "diff", "--name-only", baseline, "feat/example")).split("\n").sort(), ["01.txt", "02.txt"]);
  const executionCommits = (await gitOutput(root, "log", "--format=%s", `${baseline}..main`)).split("\n").filter((subject) => subject === ":memo: 记录 Example 的执行结果");
  assert.equal(executionCommits.length, 1);
  assert.deepEqual(generatedMessages, [{
    title: "Example",
    files: [
      ".scratch/example/checkpoint.json",
      ".scratch/example/plan.json",
      "source/issues/01-works.md",
      "source/issues/02-also-works.md",
    ],
  }]);
  complete.checkpoint.integration.merged_commit = "d".repeat(40);
  await writeCheckpoint(root, "example", complete.checkpoint);
  const staleMerge = await verifyCheckpointIntegrity({ worktree: root, featureSlug: "example" });
  assert.equal(staleMerge.status, "invalid");
  assert.deepEqual(staleMerge.diagnostics, [{ code: "merged-commit-missing", detail: "d".repeat(40) }]);
});

test("executes an automatically coordinator-owned single Ticket without a Completion Adapter", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "spec-direct-execution-"));
  const worktreePath = `${root}-feature`;
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(worktreePath, { recursive: true, force: true })]));
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  const source = join(root, "source");
  await mkdir(source);
  await writeFile(join(root, "README.md"), "base\n");
  await writeFile(join(source, "spec.md"), "# Direct change\n- [ ] implemented\n");
  await git(root, "add", "README.md", "source");
  await git(root, "commit", "-m", "baseline");
  let directExecutions = 0;
  const coordinator = createExecutionCoordinator({
    directExecutor: async ({ ticket, worktree, plan, readTicket }) => {
      directExecutions += 1;
      assert.equal(ticket.id, "spec");
      assert.equal(plan.execution_mode, "coordinator");
      assert.equal(await readTicket(ticket.id), "# Direct change\n- [ ] implemented\n");
      await writeFile(join(worktree, "direct.txt"), "implemented\n");
      await git(worktree, "add", "direct.txt");
      await git(worktree, "commit", "-m", "implement direct ticket");
      return {
        ticket_id: ticket.id,
        status: "done",
        commits: [await currentHead(worktree)],
        tests: [],
        summary: "implemented directly",
      };
    },
    now: () => "2026-07-17T08:00:00+08:00",
    generateCommitMessage: async () => ":memo: 记录直接实施",
  });
  const complete = await coordinator.run({
    repository: root,
    branch: "feat/direct-change",
    featureSlug: "direct-change",
    worktreePath,
    tracker: {
      tracker: "local",
      specPath: join(source, "spec.md"),
      issuesDirectory: join(source, "issues"),
      featureSlug: "direct-change",
      now: "2026-07-17T08:00:00+08:00",
    },
    review: async ({ readTicket }) => {
      assert.equal(await readTicket("spec"), "# Direct change\n- [x] implemented\n");
      return { approved: true, findingsSummary: "no findings" };
    },
  });
  assert.equal(complete.status, "complete");
  assert.equal(directExecutions, 1);
  assert.equal(complete.checkpoint.tickets[0].status, "done");
  assert.equal(await readFile(join(source, "spec.md"), "utf8"), "# Direct change\n- [x] implemented\n");
  assert.equal((await readFile(join(root, ".scratch", "direct-change", "plan.json"), "utf8")).includes('"execution_mode": "coordinator"'), true);
});

test("automatically delegates a multi-Ticket Plan", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "spec-multi-direct-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const issuesDirectory = join(source, "issues");
  await mkdir(issuesDirectory, { recursive: true });
  await writeFile(join(source, "spec.md"), "# Example\n");
  await writeFile(join(issuesDirectory, "01-first.md"), "# First\n");
  await writeFile(join(issuesDirectory, "02-second.md"), "# Second\n");
  const plan = await materializeLocalPlan({ mainWorktree: root, specPath: join(source, "spec.md"), issuesDirectory, featureSlug: "example" });
  assert.equal(plan.execution_mode, "delegated");
});

test("preserves Ticket dependencies written with a Markdown-formatted label", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "spec-markdown-dependencies-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const issuesDirectory = join(source, "issues");
  await mkdir(issuesDirectory, { recursive: true });
  await writeFile(join(source, "spec.md"), "# Example\n");
  await writeFile(join(issuesDirectory, "01-first.md"), "# First\n");
  await writeFile(join(issuesDirectory, "02-second.md"), "# Second\n**Blocked by:** 01\n");
  await writeFile(join(issuesDirectory, "03-third.md"), "# Third\nBlocked by: 02\n");

  const plan = await materializeLocalPlan({ mainWorktree: root, specPath: join(source, "spec.md"), issuesDirectory, featureSlug: "example" });

  assert.deepEqual(plan.tickets.map(({ id, blocked_by, level }) => ({ id, blocked_by, level })), [
    { id: "01", blocked_by: [], level: 0 },
    { id: "02", blocked_by: ["01"], level: 1 },
    { id: "03", blocked_by: ["02"], level: 2 },
  ]);
});

test("records a direct executor failure as a blocked Ticket", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "spec-direct-failure-"));
  const worktreePath = `${root}-feature`;
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(worktreePath, { recursive: true, force: true })]));
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  const source = join(root, "source");
  await mkdir(source);
  await writeFile(join(root, "README.md"), "base\n");
  await writeFile(join(source, "spec.md"), "# Direct failure\n");
  await git(root, "add", "README.md", "source");
  await git(root, "commit", "-m", "baseline");
  const coordinator = createExecutionCoordinator({
    directExecutor: async () => { throw new Error("test failure"); },
    now: () => "2026-07-17T08:00:00+08:00",
  });
  const execution = await coordinator.initialize({
    repository: root,
    branch: "feat/direct-failure",
    worktreePath,
    tracker: {
      tracker: "local",
      specPath: join(source, "spec.md"),
      issuesDirectory: join(source, "issues"),
      featureSlug: "direct-failure",
      now: "2026-07-17T08:00:00+08:00",
    },
  });
  const result = await coordinator.executeFrontier({ ...execution, featureSlug: "direct-failure" });
  assert.equal(result.results[0].status, "blocked");
  assert.equal(result.checkpoint.tickets[0].status, "blocked");
  assert.equal(result.checkpoint.tickets[0].error, "test failure");
});

test("requires a direct executor before starting a coordinator-owned Ticket", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "spec-direct-preflight-"));
  const worktreePath = `${root}-feature`;
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(worktreePath, { recursive: true, force: true })]));
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  const source = join(root, "source");
  await mkdir(source);
  await writeFile(join(root, "README.md"), "base\n");
  await writeFile(join(source, "spec.md"), "# Direct preflight\n");
  await git(root, "add", "README.md", "source");
  await git(root, "commit", "-m", "baseline");
  const coordinator = createExecutionCoordinator({ now: () => "2026-07-17T08:00:00+08:00" });
  const execution = await coordinator.initialize({
    repository: root,
    branch: "feat/direct-preflight",
    worktreePath,
    tracker: {
      tracker: "local",
      specPath: join(source, "spec.md"),
      issuesDirectory: join(source, "issues"),
      featureSlug: "direct-preflight",
      now: "2026-07-17T08:00:00+08:00",
    },
  });
  await assert.rejects(
    coordinator.executeFrontier({ ...execution, featureSlug: "direct-preflight" }),
    /direct executor is required/,
  );
  assert.equal(execution.checkpoint.tickets[0].status, "pending");
});
