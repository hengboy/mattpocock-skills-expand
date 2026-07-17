import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createCheckpoint, writeCheckpoint } from "../skills/execute-mattpocock-spec/lib/checkpoint.mjs";
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
  const plan = await materializeLocalPlan({ specPath: join(source, "spec.md"), issuesDirectory: join(source, "issues"), featureSlug: "example", now: "2026-07-17T08:00:00+08:00" });
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
  const plan = await materializeLocalPlan({ specPath: join(source, "spec.md"), issuesDirectory: join(source, "issues"), featureSlug: "example", now: "2026-07-17T08:00:00+08:00" });
  await writePlan(root, plan);
  const checkpoint = createCheckpoint({ plan, baseline, branch: "feat/example", worktree, now: "2026-07-17T08:00:00+08:00" });
  checkpoint.tickets[0] = { id: "spec", status: "done", end_commit: "deadbeef", completed_at: "2026-07-17T08:01:00+08:00" };
  await writeCheckpoint(root, "example", checkpoint);
  const result = await verifyCheckpointIntegrity({ worktree: root, featureWorktree: worktree, featureSlug: "example" });
  assert.equal(result.status, "invalid");
  assert.deepEqual(result.diagnostics, [{ code: "ticket-commit-missing", detail: "spec:deadbeef" }]);
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
  const coordinator = createExecutionCoordinator({ adapter, now: () => "2026-07-17T08:00:00+08:00" });
  const complete = await coordinator.run({
    repository: root,
    branch: "feat/example",
    featureSlug: "example",
    worktreePath,
    tracker: { tracker: "local", specPath: join(source, "spec.md"), issuesDirectory: join(source, "issues"), featureSlug: "example", now: "2026-07-17T08:00:00+08:00" },
    review: async () => ({ findingsSummary: "no findings" }),
  });
  assert.equal(complete.status, "complete");
  assert.equal((await verifyCheckpointIntegrity({ worktree: root, featureSlug: "example" })).status, "valid");
  assert.equal(await readFile(join(source, "issues", "01-works.md"), "utf8"), "# Works\n- [x] implemented\n");
  assert.deepEqual((await gitOutput(root, "diff", "--name-only", baseline, "feat/example")).split("\n"), ["01.txt"]);
  complete.checkpoint.integration.merged_commit = "deadbeef";
  await writeCheckpoint(root, "example", complete.checkpoint);
  const staleMerge = await verifyCheckpointIntegrity({ worktree: root, featureSlug: "example" });
  assert.equal(staleMerge.status, "invalid");
  assert.deepEqual(staleMerge.diagnostics, [{ code: "merged-commit-missing", detail: "deadbeef" }]);
});
