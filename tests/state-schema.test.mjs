import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const schema = JSON.parse(
  await readFile(new URL("../skills/execute-mattpocock-spec/state-schema.json", import.meta.url)),
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(schema);

function checkpoint(ticket, review = { status: "pending" }) {
  return {
    spec: { ref: ".scratch/example/spec.md", tracker: "local", feature_slug: "example" },
    mode: "single",
    status: "executing",
    baseline: "abcdef1",
    branch: "feat/example",
    worktree: "/tmp/example",
    created_at: "2026-07-15T13:00:00+08:00",
    updated_at: "2026-07-15T13:00:00+08:00",
    tickets: [
      { id: "spec", title: "Example", level: 0, blocked_by: [], ...ticket },
    ],
    review,
    history: [],
  };
}

test("accepts valid Ticket states", () => {
  for (const ticket of [
    { status: "pending" },
    {
      status: "in_progress",
      start_commit: "abcdef1",
      started_at: "2026-07-15T13:00:00+08:00",
    },
    {
      status: "done",
      end_commit: "abcdef2",
      completed_at: "2026-07-15T13:01:00+08:00",
    },
    { status: "blocked", error: "test failure" },
  ]) {
    assert.equal(validate(checkpoint(ticket)), true, JSON.stringify(validate.errors));
  }
});

test("rejects invalid Ticket state facts", () => {
  for (const ticket of [
    { status: "pending", blocking_edges: [] },
    { status: "pending", ref: ".scratch/example/spec.md" },
    { status: "in_progress" },
    { status: "in_progress", start_commit: "abcdef1", started_at: "" },
    { status: "done", end_commit: null, completed_at: null },
    { status: "done", end_commit: "abcdef2", completed_at: "2026-07-15" },
    { status: "blocked" },
    { status: "blocked", error: "test failure", end_commit: null },
    {
      status: "blocked",
      error: "test failure",
      completed_at: "2026-07-15T13:01:00+08:00",
    },
  ]) {
    assert.equal(validate(checkpoint(ticket)), false);
  }
});

test("enforces completed review facts", () => {
  assert.equal(
    validate(checkpoint({ status: "pending" }, { status: "done" })),
    false,
  );
  assert.equal(
    validate(
      checkpoint(
        { status: "pending" },
        {
          status: "done",
          findings_summary: "no findings",
          completed_at: "2026-07-15T13:01:00+08:00",
        },
      ),
    ),
    true,
  );
});
