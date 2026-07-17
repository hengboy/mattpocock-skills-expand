import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { beginReview, blockTicket, completeIntegration, completeReview, completeTicket, createCheckpoint, markMerged, relocateCheckpoint, startTickets, writeCheckpoint } from "../skills/execute-mattpocock-spec/lib/checkpoint.mjs";
import { writePlan } from "../skills/execute-mattpocock-spec/lib/plan.mjs";
import { createExecutionCoordinator } from "../skills/execute-mattpocock-spec/lib/execution-coordinator.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const planSchema = JSON.parse(await readFile(new URL("../skills/execute-mattpocock-spec/execution-plan-schema.json", import.meta.url)));
const checkpointSchema = JSON.parse(await readFile(new URL("../skills/execute-mattpocock-spec/checkpoint-schema.json", import.meta.url)));
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validatePlan = ajv.compile(planSchema);
const validateCheckpoint = ajv.compile(checkpointSchema);

const plan = {
  version: 1,
  revision: "a".repeat(64),
  created_at: "2026-07-17T08:00:00+08:00",
  spec: { ref: ".scratch/example/spec.md", tracker: "local", feature_slug: "example", title: "Example", content: "# Example" },
  tickets: [{ id: "spec", title: "Example", level: 0, blocked_by: [], acceptance: [], content: "# Example" }],
};

test("accepts an immutable Execution Plan", () => {
  assert.equal(validatePlan(plan), true, JSON.stringify(validatePlan.errors));
  assert.equal(validatePlan({ ...plan, tickets: [] }), false);
});

test("accepts a Checkpoint that references the Execution Plan", () => {
  const checkpoint = createCheckpoint({
    plan,
    baseline: "abcdef1",
    branch: "feat/example",
    worktree: "/tmp/example",
    now: "2026-07-17T08:00:00+08:00",
  });
  assert.equal(validateCheckpoint(checkpoint), true, JSON.stringify(validateCheckpoint.errors));
  assert.equal(validateCheckpoint({ ...checkpoint, plan: { ...checkpoint.plan, revision: "bad" } }), false);
});

test("requires the Git facts for active and completed Tickets", () => {
  const base = createCheckpoint({ plan, baseline: "abcdef1", branch: "feat/example", worktree: "/tmp/example", now: "2026-07-17T08:00:00+08:00" });
  const inProgress = { ...base, tickets: [{ id: "spec", status: "in_progress" }] };
  assert.equal(validateCheckpoint(inProgress), false);
  const done = { ...base, tickets: [{ id: "spec", status: "done", end_commit: "abcdef2", completed_at: "2026-07-17T08:01:00+08:00" }] };
  assert.equal(validateCheckpoint(done), true, JSON.stringify(validateCheckpoint.errors));
});

test("records a worktree relocation through the Checkpoint module", () => {
  const base = createCheckpoint({ plan, baseline: "abcdef1", branch: "feat/example", worktree: "/tmp/old", now: "2026-07-17T08:00:00+08:00" });
  const relocated = relocateCheckpoint(base, "/tmp/new", "2026-07-17T08:01:00+08:00");
  assert.equal(relocated.worktree, "/tmp/new");
  assert.equal(relocated.history.at(-1).event, "worktree-relocated");
});

test("records review and integration transitions through the Checkpoint module", () => {
  const base = createCheckpoint({ plan, baseline: "abcdef1", branch: "feat/example", worktree: "/tmp/example", now: "2026-07-17T08:00:00+08:00" });
  const active = startTickets(base, ["spec"], "abcdef1", "2026-07-17T08:01:00+08:00");
  const done = completeTicket(active, "spec", "abcdef2", "2026-07-17T08:02:00+08:00");
  const reviewing = beginReview(done, "2026-07-17T08:03:00+08:00");
  const integrating = completeReview(reviewing, "no findings", "2026-07-17T08:04:00+08:00");
  const merged = markMerged(integrating, { featureHead: "abcdef3", mainWorktree: "/tmp/main", mergedCommit: "abcdef4" }, "2026-07-17T08:05:00+08:00");
  const complete = completeIntegration(merged, "2026-07-17T08:06:00+08:00");
  assert.equal(validateCheckpoint(complete), true, JSON.stringify(validateCheckpoint.errors));
});

test("refuses review until every Plan Ticket is done", () => {
  const base = createCheckpoint({ plan, baseline: "abcdef1", branch: "feat/example", worktree: "/tmp/example", now: "2026-07-17T08:00:00+08:00" });
  assert.throws(() => beginReview(base), /not done/);
});

test("validates persisted Plan and Checkpoint records at runtime", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "execution-schema-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(writePlan(directory, { ...plan, revision: "bad" }), /Execution Plan/);
  const checkpoint = createCheckpoint({ plan, baseline: "abcdef1", branch: "feat/example", worktree: "/tmp/example", now: "2026-07-17T08:00:00+08:00" });
  await assert.rejects(writeCheckpoint(directory, "example", { ...checkpoint, version: 2 }), /Checkpoint/);
});

test("returns a structured blocked outcome without re-dispatching a blocked Ticket", async () => {
  const base = createCheckpoint({ plan, baseline: "abcdef1", branch: "feat/example", worktree: "/tmp/example", now: "2026-07-17T08:00:00+08:00" });
  const active = startTickets(base, ["spec"], "abcdef1", "2026-07-17T08:01:00+08:00");
  const blocked = blockTicket(active, "spec", "test failure", "2026-07-17T08:02:00+08:00");
  const coordinator = createExecutionCoordinator({ adapter: { executeFrontier: async () => { throw new Error("must not dispatch"); } } });
  const result = await coordinator.executeFrontier({ worktree: "/not-used", featureSlug: "example", plan, checkpoint: blocked });
  assert.deepEqual(result, { status: "blocked", checkpoint: blocked, results: [] });
});

test("rejects an invalid materialized Plan before creating a worktree", async () => {
  const coordinator = createExecutionCoordinator({ materialize: async () => ({ ...plan, revision: "bad" }) });
  await assert.rejects(
    coordinator.initialize({ repository: "/not-used", branch: "feat/example", baseline: "abcdef1", worktreePath: "/not-used-worktree", tracker: {} }),
    /Execution Plan/,
  );
});

test("records Ticket transitions through the Checkpoint module", () => {
  const base = createCheckpoint({ plan, baseline: "abcdef1", branch: "feat/example", worktree: "/tmp/example", now: "2026-07-17T08:00:00+08:00" });
  const active = startTickets(base, ["spec"], "abcdef1", "2026-07-17T08:01:00+08:00");
  const done = completeTicket(active, "spec", "abcdef2", "2026-07-17T08:02:00+08:00");
  assert.equal(done.tickets[0].status, "done");
  assert.equal(done.tickets[0].end_commit, "abcdef2");
  assert.equal(validateCheckpoint(done), true, JSON.stringify(validateCheckpoint.errors));
});
