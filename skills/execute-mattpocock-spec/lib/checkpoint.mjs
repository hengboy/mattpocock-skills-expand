import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkpointPath } from "./paths.mjs";
import { toShanghaiTimestamp } from "./time.mjs";
import { assertCheckpoint } from "./validation.mjs";

export function createCheckpoint({ plan, baseline, branch, worktree, now = new Date() }) {
  now = toShanghaiTimestamp(now);
  return {
    version: 1,
    plan: { path: `.scratch/${plan.spec.feature_slug}/plan.json`, revision: plan.revision },
    status: "executing",
    baseline,
    branch,
    worktree,
    created_at: now,
    updated_at: now,
    tickets: plan.tickets.map((ticket) => ({ id: ticket.id, status: "pending" })),
    review: { status: "pending" },
    integration: { status: "pending", target_branch: "main" },
    history: [{ event: "initialized", detail: "Execution Plan materialized", at: now }],
  };
}

export async function writeCheckpoint(worktree, featureSlug, checkpoint) {
  verifyCheckpointShape(checkpoint);
  const path = join(worktree, checkpointPath(featureSlug));
  await mkdir(join(worktree, ".scratch", featureSlug), { recursive: true });
  await writeFile(path, `${JSON.stringify(checkpoint, null, 2)}\n`);
  return path;
}

export async function readCheckpoint(worktree, featureSlug) {
  return verifyCheckpointShape(JSON.parse(await readFile(join(worktree, checkpointPath(featureSlug)), "utf8")));
}

export function verifyCheckpointShape(checkpoint) {
  return assertCheckpoint(checkpoint);
}

function revise(checkpoint, event, detail, now) {
  const next = structuredClone(checkpoint);
  next.updated_at = now;
  next.history.push({ event, detail, at: now });
  return next;
}

export function startTickets(checkpoint, ticketIds, startCommit, now = new Date()) {
  now = toShanghaiTimestamp(now);
  const next = revise(checkpoint, "dispatched", ticketIds.join(", "), now);
  for (const ticket of next.tickets) {
    if (ticketIds.includes(ticket.id)) {
      if (ticket.status !== "pending") throw new Error(`Ticket ${ticket.id} is not pending`);
      ticket.status = "in_progress";
      ticket.start_commit = startCommit;
      ticket.started_at = now;
    }
  }
  return next;
}

export function completeTicket(checkpoint, ticketId, endCommit, now = new Date()) {
  now = toShanghaiTimestamp(now);
  const next = revise(checkpoint, "done", ticketId, now);
  const ticket = next.tickets.find((candidate) => candidate.id === ticketId);
  if (!ticket || ticket.status !== "in_progress") throw new Error(`Ticket ${ticketId} is not in progress`);
  ticket.status = "done";
  ticket.end_commit = endCommit;
  ticket.completed_at = now;
  delete ticket.error;
  return next;
}

export function blockTicket(checkpoint, ticketId, error, now = new Date()) {
  now = toShanghaiTimestamp(now);
  const next = revise(checkpoint, "blocked", ticketId, now);
  const ticket = next.tickets.find((candidate) => candidate.id === ticketId);
  if (!ticket || ticket.status !== "in_progress") throw new Error(`Ticket ${ticketId} is not in progress`);
  ticket.status = "blocked";
  ticket.error = error;
  return next;
}

export function relocateCheckpoint(checkpoint, worktree, now = new Date()) {
  now = toShanghaiTimestamp(now);
  const next = revise(checkpoint, "worktree-relocated", worktree, now);
  next.worktree = worktree;
  return next;
}

export function beginReview(checkpoint, now = new Date()) {
  now = toShanghaiTimestamp(now);
  if (checkpoint.tickets.some((ticket) => ticket.status !== "done")) {
    throw new Error("Cannot begin review while Tickets are not done");
  }
  const next = revise(checkpoint, "reviewing", "final review started", now);
  next.status = "reviewing";
  next.review = { status: "in_progress", started_at: now };
  return next;
}

export function completeReview(checkpoint, findingsSummary, now = new Date()) {
  now = toShanghaiTimestamp(now);
  const next = revise(checkpoint, "reviewed", findingsSummary, now);
  if (next.review.status !== "in_progress") throw new Error("Review is not in progress");
  next.review = { ...next.review, status: "done", findings_summary: findingsSummary, completed_at: now };
  next.status = "integrating";
  return next;
}

export function markMerged(checkpoint, { featureHead, mainWorktree, mergedCommit }, now = new Date()) {
  now = toShanghaiTimestamp(now);
  const next = revise(checkpoint, "merged", mergedCommit, now);
  if (next.status !== "integrating") throw new Error("Checkpoint is not integrating");
  next.integration = { status: "merged", target_branch: "main", feature_head: featureHead, main_worktree: mainWorktree, merged_commit: mergedCommit, merged_at: now };
  return next;
}

export function completeIntegration(checkpoint, now = new Date()) {
  now = toShanghaiTimestamp(now);
  const next = revise(checkpoint, "complete", "feature worktree removed", now);
  if (next.integration.status !== "merged") throw new Error("Feature branch has not been merged");
  next.integration = { ...next.integration, status: "done", cleaned_up_at: now };
  next.status = "complete";
  return next;
}
