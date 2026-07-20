import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { createNativeAdapter, createUnsupportedAdapter, normalizeCompletion } from "../skills/execute-mattpocock-spec/lib/completion-adapter.mjs";

const schema = JSON.parse(
  await readFile(
    new URL("../skills/execute-mattpocock-spec/completion-result-schema.json", import.meta.url),
  ),
);
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
const COMMIT = "a".repeat(40);

function result(fields) {
  return {
    ticket_id: "01",
    status: "done",
    commits: [COMMIT],
    tests: [],
    summary: "implemented the Ticket",
    ...fields,
  };
}

test("accepts a done Completion Result", () => {
  assert.equal(validate(result({})), true, JSON.stringify(validate.errors));
});

test("accepts a blocked Completion Result", () => {
  assert.equal(
    validate(
      result({
        status: "blocked",
        commits: [],
        summary: "cannot access the tracker",
        error: "tracker credentials are unavailable",
      }),
    ),
    true,
    JSON.stringify(validate.errors),
  );
});

test("rejects a done Completion Result without commits", () => {
  assert.equal(validate(result({ commits: [] })), false);
});

test("rejects a done Completion Result with an error", () => {
  assert.equal(validate(result({ error: "done results cannot include errors" })), false);
});

test("rejects a blocked Completion Result without an error", () => {
  assert.equal(validate(result({ status: "blocked", commits: [] })), false);
});

test("rejects a blocked Completion Result with a commit", () => {
  assert.equal(
    validate(result({ status: "blocked", commits: [COMMIT], error: "partial commit" })),
    false,
  );
});

test("rejects empty completion facts", () => {
  assert.equal(validate(result({ status: "blocked", commits: [], error: "" })), false);
  assert.equal(validate(result({ summary: "" })), false);
  assert.equal(validate(result({ ticket_id: "" })), false);
});

test("requires full commit SHAs", () => {
  assert.equal(validate(result({ commits: ["abcdef1"] })), false);
  assert.equal(validate(result({ commits: ["b".repeat(64)] })), true);
  assert.equal(
    normalizeCompletion({ ticketId: "01", raw: "RESULT: DONE\nCOMMITS: abcdef1\nTESTS: none\nSUMMARY: short SHA" }).status,
    "blocked",
  );
});

test("normalizes the terminal protocol at the Completion Adapter seam", () => {
  assert.deepEqual(
    normalizeCompletion({ ticketId: "01", raw: `RESULT: DONE\nCOMMITS: ${COMMIT}\nTESTS: npm test\nSUMMARY: done` }),
    result({ ticket_id: "01", tests: ["npm test"], summary: "done" }),
  );
  assert.equal(
    normalizeCompletion({ ticketId: "01", raw: "RESULT: DONE\nCOMMITS: none\nTESTS: none\nSUMMARY: bad" }).status,
    "blocked",
  );
});

test("collects every native result and blocks unsupported adapters", async () => {
  const adapter = createNativeAdapter({
    spawn: async ({ ticket }) => ticket.id,
    collect: async (id) => `RESULT: DONE\nCOMMITS: ${id.repeat(40)}\nTESTS: none\nSUMMARY: ${id}`,
  });
  const results = await adapter.executeFrontier({ tickets: [{ id: "1" }, { id: "2" }], worktree: "/tmp/example" });
  assert.deepEqual(results.map((item) => item.status), ["done", "done"]);
  const unsupported = await createUnsupportedAdapter("OpenCode").executeFrontier({ tickets: [{ id: "1" }] });
  assert.equal(unsupported[0].status, "blocked");
});

test("collects already-started tasks before retrying a failed dispatch", async () => {
  const collected = [];
  let failedOnce = true;
  const adapter = createNativeAdapter({
    spawn: async ({ ticket }) => {
      if (ticket.id === "2" && failedOnce) {
        failedOnce = false;
        throw new Error("capacity");
      }
      return ticket.id;
    },
    collect: async (id) => {
      collected.push(id);
      return `RESULT: DONE\nCOMMITS: ${id.repeat(40)}\nTESTS: none\nSUMMARY: ${id}`;
    },
  });
  const results = await adapter.executeFrontier({ tickets: [{ id: "1" }, { id: "2" }], worktree: "/tmp/example" });
  assert.deepEqual(collected, ["1", "2"]);
  assert.deepEqual(results.map((result) => result.status), ["done", "done"]);
});

test("converts a synchronous collection failure into a blocked result", async () => {
  const adapter = createNativeAdapter({
    spawn: async () => "task",
    collect: () => { throw new Error("collector unavailable"); },
  });
  const [result] = await adapter.executeFrontier({ tickets: [{ id: "1" }], worktree: "/tmp/example" });
  assert.equal(result.status, "blocked");
  assert.match(result.error, /collector unavailable/);
});
