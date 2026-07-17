import { assertCompletionResult } from "./validation.mjs";

function protocolError(ticketId, error) {
  return assertCompletionResult({ ticket_id: ticketId, status: "blocked", commits: [], tests: [], summary: "Completion protocol error", error });
}

function fieldsFrom(raw) {
  const fields = new Map();
  for (const line of raw.trim().split("\n")) {
    const match = line.match(/^([A-Z]+):\s*(.*)$/);
    if (match) fields.set(match[1], match[2]);
  }
  return fields;
}

export function normalizeCompletion({ ticketId, raw }) {
  const fields = fieldsFrom(raw);
  const result = fields.get("RESULT");
  const commitsText = fields.get("COMMITS");
  const testsText = fields.get("TESTS");
  const summary = fields.get("SUMMARY");
  const error = fields.get("ERROR");
  if (!result || !commitsText || !testsText || !summary) return protocolError(ticketId, "missing required terminal fields");
  if (result !== "DONE" && result !== "BLOCKED") return protocolError(ticketId, "RESULT must be DONE or BLOCKED");
  const commits = commitsText === "none" ? [] : commitsText.split(/[\s,]+/).filter(Boolean);
  if (commits.some((commit) => !/^[0-9a-f]{7,40}$/.test(commit))) return protocolError(ticketId, "COMMITS contains an invalid SHA");
  const tests = testsText === "none" ? [] : [testsText];
  if (result === "DONE" && (commits.length === 0 || error)) return protocolError(ticketId, "DONE requires commits and forbids ERROR");
  if (result === "BLOCKED" && (commits.length > 0 || !error)) return protocolError(ticketId, "BLOCKED requires ERROR and forbids commits");
  return assertCompletionResult({ ticket_id: ticketId, status: result === "DONE" ? "done" : "blocked", commits, tests, summary, ...(error ? { error } : {}) });
}

export function createNativeAdapter({ spawn, collect }) {
  return {
    async executeFrontier({ tickets, worktree }) {
      const results = new Array(tickets.length);
      const firstAttempts = await Promise.allSettled(tickets.map((ticket) => spawn({ ticket, worktree })));
      const started = firstAttempts.flatMap((attempt, index) => attempt.status === "fulfilled" ? [{ index, task: attempt.value }] : []);
      await collectStarted(started, tickets, collect, results);
      const failedIndexes = firstAttempts.flatMap((attempt, index) => attempt.status === "rejected" ? [index] : []);
      const retries = await Promise.allSettled(failedIndexes.map((index) => spawn({ ticket: tickets[index], worktree })));
      const retried = retries.flatMap((attempt, index) => attempt.status === "fulfilled" ? [{ index: failedIndexes[index], task: attempt.value }] : []);
      await collectStarted(retried, tickets, collect, results);
      for (let index = 0; index < retries.length; index += 1) {
        if (retries[index].status === "rejected") {
          const reason = retries[index].reason instanceof Error ? retries[index].reason.message : String(retries[index].reason);
          results[failedIndexes[index]] = protocolError(tickets[failedIndexes[index]].id, `native dispatch failed after retry: ${reason}`);
        }
      }
      return results;
    },
  };
}

async function collectStarted(started, tickets, collect, results) {
  await Promise.all(started.map(async ({ index, task }) => {
    try {
      results[index] = normalizeCompletion({ ticketId: tickets[index].id, raw: await collect(task) });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      results[index] = protocolError(tickets[index].id, `native collection failed: ${reason}`);
    }
  }));
}

export function createUnsupportedAdapter(name) {
  return {
    async executeFrontier({ tickets }) {
      return tickets.map((ticket) => protocolError(ticket.id, `${name} adapter is unavailable`));
    },
  };
}

export const createCodexClaudeAdapter = createNativeAdapter;
export const createOpenCodeAdapter = createNativeAdapter;
