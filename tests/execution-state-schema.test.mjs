import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { beginReview, blockTicket, completeIntegration, completeReview, completeTicket, createCheckpoint, markMerged, relocateCheckpoint, startTickets, writeCheckpoint } from "../skills/execute-mattpocock-spec/lib/checkpoint.mjs";
import { materializeLocalPlan, verifyPlan, writePlan } from "../skills/execute-mattpocock-spec/lib/plan.mjs";
import { createExecutionCoordinator } from "../skills/execute-mattpocock-spec/lib/execution-coordinator.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const planSchema = JSON.parse(await readFile(new URL("../skills/execute-mattpocock-spec/execution-plan-schema.json", import.meta.url)));
const checkpointSchema = JSON.parse(await readFile(new URL("../skills/execute-mattpocock-spec/checkpoint-schema.json", import.meta.url)));
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validatePlan = ajv.compile(planSchema);
const validateCheckpoint = ajv.compile(checkpointSchema);
const SHAS = {
  baseline: "a".repeat(40),
  start: "b".repeat(40),
  end: "c".repeat(40),
  feature: "d".repeat(40),
  merged: "e".repeat(40),
};

const plan = {
  version: 3,
  revision: "a".repeat(64),
  created_at: "2026-07-17T08:00:00+08:00",
  execution_mode: "delegated",
  spec: { ref: ".scratch/example/spec.md", tracker: "local", feature_slug: "example", title: "Example" },
  tickets: [{ id: "spec", ref: "spec.md", title: "Example", level: 0, blocked_by: [] }],
};

test("accepts an immutable Execution Plan", () => {
  assert.equal(validatePlan(plan), true, JSON.stringify(validatePlan.errors));
  assert.equal(validatePlan({ ...plan, tickets: [] }), false);
});

test("rejects Plan content and copied work items", () => {
  assert.equal(validatePlan({ ...plan, spec: { ...plan.spec, content: "# Example" } }), false);
  assert.equal(validatePlan({ ...plan, tickets: [{ ...plan.tickets[0], acceptance: ["implemented"] }] }), false);
});

test("materializes Plans without copying Spec or Issue content", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "execution-plan-content-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const issuesDirectory = join(directory, "issues");
  const specPath = join(directory, "spec.md");
  await mkdir(issuesDirectory);
  await writeFile(specPath, "# Example\nSpec-only detail\n");
  await writeFile(join(issuesDirectory, "01-example.md"), "# Example Ticket\nIssue-only detail\n- [ ] implemented\n");

  const materialized = await materializeLocalPlan({ mainWorktree: directory, specPath, issuesDirectory, featureSlug: "example" });

  assert.equal(materialized.version, 3);
  assert.equal(materialized.spec.ref, "spec.md");
  assert.equal(materialized.tickets[0].ref, "issues/01-example.md");
  assert.equal("content" in materialized.spec, false);
  assert.equal("content" in materialized.tickets[0], false);
  assert.equal("acceptance" in materialized.tickets[0], false);
  assert.equal(verifyPlan(materialized), materialized);
});

test("delegates a single Ticket with too many work items automatically", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "execution-complexity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const issuesDirectory = join(directory, "issues");
  const cases = [
    ["risk.md", "# Database migration\n- [ ] preserve data\n"],
    ["work-items.md", "# Example\n- [ ] first\n- [ ] second\n- [ ] third\n"],
    ["long.md", `# Example\n${"a".repeat(1001)}`],
  ];
  for (const [name, content] of cases) {
    const specPath = join(directory, name);
    await writeFile(specPath, content);
    const plan = await materializeLocalPlan({ mainWorktree: directory, specPath, issuesDirectory, featureSlug: "example" });
    assert.equal(plan.execution_mode, "delegated", name);
  }
});

test("uses coordinator mode at the 1000-character content limit", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "execution-content-limit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const specPath = join(directory, "spec.md");
  await writeFile(specPath, `# Example\n${"a".repeat(990)}`);
  const plan = await materializeLocalPlan({ mainWorktree: directory, specPath, issuesDirectory: join(directory, "issues"), featureSlug: "example" });
  assert.equal(plan.execution_mode, "coordinator");
});

test("accepts a Checkpoint that references the Execution Plan", () => {
  const checkpoint = createCheckpoint({
    plan,
    baseline: SHAS.baseline,
    branch: "feat/example",
    worktree: "/tmp/example",
    now: "2026-07-17T08:00:00+08:00",
  });
  assert.equal(validateCheckpoint(checkpoint), true, JSON.stringify(validateCheckpoint.errors));
  assert.equal(validateCheckpoint({ ...checkpoint, plan: { ...checkpoint.plan, revision: "bad" } }), false);
});

test("requires the Git facts for active and completed Tickets", () => {
  const base = createCheckpoint({ plan, baseline: SHAS.baseline, branch: "feat/example", worktree: "/tmp/example", now: "2026-07-17T08:00:00+08:00" });
  const inProgress = { ...base, tickets: [{ id: "spec", status: "in_progress" }] };
  assert.equal(validateCheckpoint(inProgress), false);
  const done = { ...base, tickets: [{ id: "spec", status: "done", end_commit: SHAS.end, completed_at: "2026-07-17T08:01:00+08:00" }] };
  assert.equal(validateCheckpoint(done), true, JSON.stringify(validateCheckpoint.errors));
});

test("records a worktree relocation through the Checkpoint module", () => {
  const base = createCheckpoint({ plan, baseline: SHAS.baseline, branch: "feat/example", worktree: "/tmp/old", now: "2026-07-17T08:00:00+08:00" });
  const relocated = relocateCheckpoint(base, "/tmp/new", "2026-07-17T08:01:00+08:00");
  assert.equal(relocated.worktree, "/tmp/new");
  assert.equal(relocated.history.at(-1).event, "worktree-relocated");
});

test("records review and integration transitions through the Checkpoint module", () => {
  const base = createCheckpoint({ plan, baseline: SHAS.baseline, branch: "feat/example", worktree: "/tmp/example", now: "2026-07-17T08:00:00+08:00" });
  const active = startTickets(base, ["spec"], SHAS.start, "2026-07-17T08:01:00+08:00");
  const done = completeTicket(active, "spec", SHAS.end, "2026-07-17T08:02:00+08:00");
  const reviewing = beginReview(done, "2026-07-17T08:03:00+08:00");
  const integrating = completeReview(reviewing, "no findings", "2026-07-17T08:04:00+08:00");
  const merged = markMerged(integrating, { featureHead: SHAS.feature, mainWorktree: "/tmp/main", mergedCommit: SHAS.merged }, "2026-07-17T08:05:00+08:00");
  const complete = completeIntegration(merged, "2026-07-17T08:06:00+08:00");
  assert.equal(validateCheckpoint(complete), true, JSON.stringify(validateCheckpoint.errors));

  const sha256Checkpoint = structuredClone(complete);
  sha256Checkpoint.baseline = "f".repeat(64);
  sha256Checkpoint.tickets[0].start_commit = "f".repeat(64);
  sha256Checkpoint.tickets[0].end_commit = "f".repeat(64);
  sha256Checkpoint.integration.feature_head = "f".repeat(64);
  sha256Checkpoint.integration.merged_commit = "f".repeat(64);
  assert.equal(validateCheckpoint(sha256Checkpoint), true, JSON.stringify(validateCheckpoint.errors));

  const shortShaMutations = [
    (checkpoint) => { checkpoint.baseline = "abcdef1"; },
    (checkpoint) => { checkpoint.tickets[0].start_commit = "abcdef1"; },
    (checkpoint) => { checkpoint.tickets[0].end_commit = "abcdef1"; },
    (checkpoint) => { checkpoint.integration.feature_head = "abcdef1"; },
    (checkpoint) => { checkpoint.integration.merged_commit = "abcdef1"; },
  ];
  for (const mutate of shortShaMutations) {
    const invalidCheckpoint = structuredClone(complete);
    mutate(invalidCheckpoint);
    assert.equal(validateCheckpoint(invalidCheckpoint), false);
  }
});

test("refuses review until every Plan Ticket is done", () => {
  const base = createCheckpoint({ plan, baseline: SHAS.baseline, branch: "feat/example", worktree: "/tmp/example", now: "2026-07-17T08:00:00+08:00" });
  assert.throws(() => beginReview(base), /not done/);
});

test("validates persisted Plan and Checkpoint records at runtime", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "execution-schema-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(writePlan(directory, { ...plan, revision: "bad" }), /Execution Plan/);
  const checkpoint = createCheckpoint({ plan, baseline: SHAS.baseline, branch: "feat/example", worktree: "/tmp/example", now: "2026-07-17T08:00:00+08:00" });
  await assert.rejects(writeCheckpoint(directory, "example", { ...checkpoint, version: 2 }), /Checkpoint/);
});

test("returns a structured blocked outcome without re-dispatching a blocked Ticket", async () => {
  const base = createCheckpoint({ plan, baseline: SHAS.baseline, branch: "feat/example", worktree: "/tmp/example", now: "2026-07-17T08:00:00+08:00" });
  const active = startTickets(base, ["spec"], SHAS.start, "2026-07-17T08:01:00+08:00");
  const blocked = blockTicket(active, "spec", "test failure", "2026-07-17T08:02:00+08:00");
  const coordinator = createExecutionCoordinator({ adapter: { executeFrontier: async () => { throw new Error("must not dispatch"); } }, generateCommitMessage: async () => ":memo: 记录执行结果" });
  const result = await coordinator.executeFrontier({ worktree: "/not-used", featureSlug: "example", plan, checkpoint: blocked });
  assert.deepEqual(result, { status: "blocked", checkpoint: blocked, results: [] });
});

test("rejects an invalid materialized Plan before creating a worktree", async () => {
  const { execution_mode, ...incompletePlan } = plan;
  const coordinator = createExecutionCoordinator({ materialize: async () => incompletePlan });
  await assert.rejects(
    coordinator.initialize({ repository: "/not-used", branch: "feat/example", baseline: SHAS.baseline, worktreePath: "/not-used-worktree", tracker: {} }),
    /Execution Plan/,
  );
});

test("records Ticket transitions through the Checkpoint module", () => {
  const base = createCheckpoint({ plan, baseline: SHAS.baseline, branch: "feat/example", worktree: "/tmp/example", now: "2026-07-17T08:00:00+08:00" });
  const active = startTickets(base, ["spec"], SHAS.start, "2026-07-17T08:01:00+08:00");
  const done = completeTicket(active, "spec", SHAS.end, "2026-07-17T08:02:00+08:00");
  assert.equal(done.tickets[0].status, "done");
  assert.equal(done.tickets[0].end_commit, SHAS.end);
  assert.equal(validateCheckpoint(done), true, JSON.stringify(validateCheckpoint.errors));
});
