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
      const collections = new Set();
      const collectTask = (ticket, task) => {
        const collection = Promise.resolve()
          .then(() => collect(task))
          .then((raw) => normalizeCompletion({ ticketId: ticket.id, raw }))
          .catch((error) => {
            const reason = error instanceof Error ? error.message : String(error);
            return protocolError(ticket.id, `native collection failed: ${reason}`);
          });
        collections.add(collection);
        void collection.finally(() => collections.delete(collection));
        return collection;
      };
      return Promise.all(tickets.map(async (ticket) => {
        try {
          return await collectTask(ticket, await spawn({ ticket, worktree }));
        } catch (firstError) {
          await Promise.all([...collections]);
          try {
            return await collectTask(ticket, await spawn({ ticket, worktree }));
          } catch (retryError) {
            const reason = retryError instanceof Error ? retryError.message : String(retryError);
            return protocolError(ticket.id, `native dispatch failed after retry: ${reason}`);
          }
        }
      }));
    },
  };
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
