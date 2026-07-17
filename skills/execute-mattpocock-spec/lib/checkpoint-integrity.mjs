import { readPlan, verifyPlan } from "./plan.mjs";
import { readCheckpoint, verifyCheckpointShape } from "./checkpoint.mjs";
import { git, gitSucceeds, isAncestor } from "./git.mjs";
import { planPath } from "./paths.mjs";
import { resolve } from "node:path";

function diagnostic(code, detail) {
  return { code, detail };
}

export async function verifyCheckpointIntegrity({ worktree, featureSlug }) {
  const diagnostics = [];
  let plan;
  let checkpoint;
  try {
    plan = verifyPlan(await readPlan(worktree, featureSlug));
  } catch (error) {
    return { status: "invalid", diagnostics: [diagnostic("plan", error.message)] };
  }
  try {
    checkpoint = verifyCheckpointShape(await readCheckpoint(worktree, featureSlug));
  } catch (error) {
    return { status: "invalid", diagnostics: [diagnostic("checkpoint", error.message)] };
  }
  if (checkpoint.plan.revision !== plan.revision) {
    diagnostics.push(diagnostic("plan-revision", "Checkpoint does not identify this Execution Plan revision"));
  }
  if (checkpoint.plan.path !== planPath(featureSlug)) {
    diagnostics.push(diagnostic("plan-path", checkpoint.plan.path));
  }
  const currentBranch = await git(worktree, ["branch", "--show-current"]);
  const integrationRecord = ["merged", "done"].includes(checkpoint.integration.status);
  if (integrationRecord) {
    if (currentBranch !== checkpoint.integration.target_branch) {
      diagnostics.push(diagnostic("integration-branch", currentBranch));
    }
    if (!await gitSucceeds(worktree, ["rev-parse", "--verify", `${checkpoint.integration.feature_head}^{commit}`])) {
      diagnostics.push(diagnostic("feature-head-missing", checkpoint.integration.feature_head));
    } else if (!await isAncestor(worktree, checkpoint.integration.feature_head)) {
      diagnostics.push(diagnostic("feature-head-not-ancestor", checkpoint.integration.feature_head));
    }
    if (!await gitSucceeds(worktree, ["rev-parse", "--verify", `${checkpoint.integration.merged_commit}^{commit}`])) {
      diagnostics.push(diagnostic("merged-commit-missing", checkpoint.integration.merged_commit));
    } else if (!await isAncestor(worktree, checkpoint.integration.merged_commit)) {
      diagnostics.push(diagnostic("merged-commit-not-ancestor", checkpoint.integration.merged_commit));
    }
  } else {
    if (checkpoint.worktree !== resolve(worktree)) {
      diagnostics.push(diagnostic("worktree-path", checkpoint.worktree));
    }
    if (currentBranch !== checkpoint.branch) {
      diagnostics.push(diagnostic("branch", checkpoint.branch));
    }
  }
  if (!await gitSucceeds(worktree, ["rev-parse", "--verify", `${checkpoint.baseline}^{commit}`])) {
    diagnostics.push(diagnostic("baseline-missing", checkpoint.baseline));
  } else if (!await isAncestor(worktree, checkpoint.baseline)) {
    diagnostics.push(diagnostic("baseline-not-ancestor", checkpoint.baseline));
  }
  const planTicketIds = new Set(plan.tickets.map((ticket) => ticket.id));
  const checkpointTicketIds = new Set();
  for (const ticket of checkpoint.tickets) {
    if (checkpointTicketIds.has(ticket.id)) diagnostics.push(diagnostic("duplicate-ticket", ticket.id));
    checkpointTicketIds.add(ticket.id);
    if (!planTicketIds.has(ticket.id)) diagnostics.push(diagnostic("unknown-ticket", ticket.id));
    const commit = ticket.status === "done" ? ticket.end_commit : ticket.status === "in_progress" ? ticket.start_commit : null;
    if (!commit) {
      if (ticket.status === "done" || ticket.status === "in_progress") diagnostics.push(diagnostic("ticket-commit-missing", ticket.id));
      continue;
    }
    if (!await gitSucceeds(worktree, ["rev-parse", "--verify", `${commit}^{commit}`])) {
      diagnostics.push(diagnostic("ticket-commit-missing", `${ticket.id}:${commit}`));
    } else if (!await isAncestor(worktree, commit)) {
      diagnostics.push(diagnostic("ticket-commit-not-ancestor", `${ticket.id}:${commit}`));
    }
  }
  for (const ticketId of planTicketIds) {
    if (!checkpointTicketIds.has(ticketId)) diagnostics.push(diagnostic("plan-ticket-missing", ticketId));
  }
  return diagnostics.length === 0
    ? { status: "valid", plan, checkpoint, diagnostics: [] }
    : { status: "invalid", plan, checkpoint, diagnostics };
}
