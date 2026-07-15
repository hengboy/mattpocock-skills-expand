import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

const schema = JSON.parse(
  await readFile(
    new URL("../skills/execute-mattpocock-spec/completion-result-schema.json", import.meta.url),
  ),
);
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

function result(fields) {
  return {
    ticket_id: "01",
    status: "done",
    commits: ["abcdef1"],
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
    validate(result({ status: "blocked", commits: ["abcdef1"], error: "partial commit" })),
    false,
  );
});

test("rejects empty completion facts", () => {
  assert.equal(validate(result({ status: "blocked", commits: [], error: "" })), false);
  assert.equal(validate(result({ summary: "" })), false);
  assert.equal(validate(result({ ticket_id: "" })), false);
});
