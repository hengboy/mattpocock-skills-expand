import { checkpointPath, planPath } from "./paths.mjs";
import { beginReview, blockTicket, completeIntegration, completeReview, completeTicket, createCheckpoint, markMerged, readCheckpoint, relocateCheckpoint, startTickets, writeCheckpoint } from "./checkpoint.mjs";
import { verifyCheckpointIntegrity } from "./checkpoint-integrity.mjs";
import { currentHead, git, gitSucceeds, isAncestor } from "./git.mjs";
import { assertLocalPlanInMainWorktree, checkLocalTicketBoxes, createTrackerMaterializer, readPlan, verifyPlan, writePlan } from "./plan.mjs";
import { assertCompletionResult } from "./validation.mjs";
import { createFeatureWorktree, ensureFeatureWorktree, findFeatureWorktree, findMainWorktree, removeFeatureWorktree, worktreeIsClean } from "./worktree-lifecycle.mjs";

async function commitFiles(worktree, files, message) {
  await git(worktree, ["add", "--", ...files]);
  await git(worktree, ["commit", "-m", message]);
}

async function persistCheckpoint(worktree, featureSlug, checkpoint, message, files = []) {
  await writeCheckpoint(worktree, featureSlug, checkpoint);
  await commitFiles(worktree, [...files, checkpointPath(featureSlug)], message);
  return checkpoint;
}

async function assertResultCommits(worktree, result) {
  for (const commit of result.commits) {
    if (!await gitSucceeds(worktree, ["rev-parse", "--verify", `${commit}^{commit}`])) {
      throw new Error(`Completion Result commit does not exist: ${commit}`);
    }
    if (!await isAncestor(worktree, commit)) {
      throw new Error(`Completion Result commit is not on the feature branch: ${commit}`);
    }
  }
}

export function createExecutionCoordinator({ adapter, materialize = createTrackerMaterializer(), now = () => new Date().toISOString() } = {}) {
  return {
    async initialize({ repository, branch, baseline, worktreePath, tracker }) {
      baseline ??= await currentHead(repository);
      const plan = await materialize(tracker);
      verifyPlan(plan);
      const mainWorktree = await findMainWorktree(repository);
      if (!mainWorktree) throw new Error("Main worktree is unavailable");
      await assertLocalPlanInMainWorktree({ mainWorktree, plan });
      const worktree = await createFeatureWorktree({ repository, branch, baseline, path: worktreePath });
      await writePlan(mainWorktree, plan);
      const checkpoint = createCheckpoint({ plan, baseline, branch, worktree, now: now() });
      await writeCheckpoint(mainWorktree, plan.spec.feature_slug, checkpoint);
      await commitFiles(mainWorktree, [planPath(plan.spec.feature_slug), checkpointPath(plan.spec.feature_slug)], "initialize execution");
      return { worktree, mainWorktree, plan, checkpoint };
    },

    async resume({ repository, branch, featureSlug, worktreePath }) {
      const mainWorktree = await findMainWorktree(repository);
      if (!mainWorktree) throw new Error("Main worktree is unavailable");
      if (mainWorktree) {
        try {
          const mainCheckpoint = await readCheckpoint(mainWorktree, featureSlug);
          if (mainCheckpoint.integration.status === "done") {
            const integrity = await verifyCheckpointIntegrity({ worktree: mainWorktree, featureSlug });
            if (integrity.status !== "valid") throw new Error(JSON.stringify(integrity.diagnostics));
            return { status: "complete", worktree: mainWorktree, ...integrity };
          }
          if (mainCheckpoint.integration.status === "merged") {
            return this.completeMergedCleanup({ repository, mainWorktree, featureSlug, checkpoint: mainCheckpoint });
          }
          if (mainCheckpoint.status === "integrating" && await isAncestor(mainWorktree, branch)) {
            const merged = markMerged(mainCheckpoint, { featureHead: await git(mainWorktree, ["rev-parse", branch]), mainWorktree, mergedCommit: await currentHead(mainWorktree) }, now());
            await persistCheckpoint(mainWorktree, featureSlug, merged, "record recovered merge");
            return this.completeMergedCleanup({ repository, mainWorktree, featureSlug, checkpoint: merged });
          }
        } catch (error) {
          if (!String(error.message).includes("ENOENT")) throw error;
        }
      }
      const plan = await readPlan(mainWorktree, featureSlug);
      await assertLocalPlanInMainWorktree({ mainWorktree, plan });
      const ensured = await ensureFeatureWorktree({ repository, branch, path: worktreePath });
      let checkpoint = await readCheckpoint(mainWorktree, featureSlug);
      if (checkpoint.worktree !== ensured.worktree) {
        checkpoint = relocateCheckpoint(checkpoint, ensured.worktree, now());
        await persistCheckpoint(mainWorktree, featureSlug, checkpoint, "relocate checkpoint worktree");
      }
      const integrity = await verifyCheckpointIntegrity({ worktree: mainWorktree, featureWorktree: ensured.worktree, featureSlug });
      if (integrity.status !== "valid") throw new Error(`Checkpoint integrity failed: ${JSON.stringify(integrity.diagnostics)}`);
      return { status: "resumed", worktree: ensured.worktree, mainWorktree, plan, checkpoint, ...integrity };
    },

    async executeFrontier({ worktree, mainWorktree, featureSlug, plan, checkpoint }) {
      if (!adapter) throw new Error("Completion Adapter is required to execute a Frontier");
      if (checkpoint.tickets.some((ticket) => ticket.status === "blocked")) {
        return { status: "blocked", checkpoint, results: [] };
      }
      const unfinished = plan.tickets.filter((ticket) => checkpoint.tickets.find((state) => state.id === ticket.id)?.status !== "done");
      if (unfinished.length === 0) throw new Error("No unfinished Ticket remains");
      const activeLevel = Math.min(...unfinished.map((ticket) => ticket.level));
      const frontier = plan.tickets.filter((ticket) => ticket.level === activeLevel && ["pending", "in_progress"].includes(checkpoint.tickets.find((state) => state.id === ticket.id)?.status));
      const pending = frontier.filter((ticket) => checkpoint.tickets.find((state) => state.id === ticket.id).status === "pending");
      if (pending.length > 0) {
        checkpoint = startTickets(checkpoint, pending.map((ticket) => ticket.id), await currentHead(worktree), now());
        await persistCheckpoint(mainWorktree, featureSlug, checkpoint, `dispatch frontier ${activeLevel}`);
      }
      const rawResults = await adapter.executeFrontier({ tickets: frontier, worktree });
      if (!Array.isArray(rawResults)) throw new Error("Completion Adapter must return an array of Completion Results");
      const results = rawResults.map(assertCompletionResult);
      const byTicket = new Map(results.map((result) => [result.ticket_id, result]));
      for (const ticket of frontier) {
        const result = byTicket.get(ticket.id);
        if (!result) {
          checkpoint = blockTicket(checkpoint, ticket.id, "Completion Adapter omitted this Ticket", now());
        } else if (result.status === "done") {
          await assertResultCommits(worktree, result);
          checkpoint = completeTicket(checkpoint, ticket.id, result.commits.at(-1), now());
        } else {
          checkpoint = blockTicket(checkpoint, ticket.id, result.error, now());
        }
        const issueFiles = result?.status === "done"
          ? await checkLocalTicketBoxes({ mainWorktree, plan, ticketId: ticket.id })
          : [];
        await persistCheckpoint(mainWorktree, featureSlug, checkpoint, `checkpoint ${ticket.id}`, issueFiles);
      }
      return { checkpoint, results };
    },

    async startReview({ mainWorktree, featureSlug, checkpoint }) {
      const reviewing = beginReview(checkpoint, now());
      return persistCheckpoint(mainWorktree, featureSlug, reviewing, "start final review");
    },

    async finishReview({ mainWorktree, featureSlug, checkpoint, findingsSummary }) {
      const integrating = completeReview(checkpoint, findingsSummary, now());
      return persistCheckpoint(mainWorktree, featureSlug, integrating, "complete final review");
    },

    async run({ repository, branch, featureSlug, worktreePath, tracker, review }) {
      let execution;
      if (await gitSucceeds(repository, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])) {
        execution = await this.resume({ repository, branch, featureSlug, worktreePath });
      } else {
        if (!tracker) throw new Error("Tracker input is required to initialize an execution");
        execution = await this.initialize({ repository, branch, worktreePath, tracker });
        execution.status = "initialized";
      }
      if (execution.status === "complete") return execution;
      let { worktree, mainWorktree, plan, checkpoint } = execution;
      while (checkpoint.status === "executing") {
        const result = await this.executeFrontier({ worktree, mainWorktree, featureSlug, plan, checkpoint });
        if (result.status === "blocked") return result;
        checkpoint = result.checkpoint;
        if (checkpoint.tickets.every((ticket) => ticket.status === "done")) {
          checkpoint = await this.startReview({ mainWorktree, featureSlug, checkpoint });
        }
      }
      if (checkpoint.status === "reviewing") {
        if (!review) return { status: "reviewing", worktree, plan, checkpoint };
        const reviewResult = await review({ worktree, plan, checkpoint });
        if (!reviewResult?.findingsSummary) return { status: "reviewing", worktree, plan, checkpoint };
        checkpoint = await this.finishReview({ mainWorktree, featureSlug, checkpoint, findingsSummary: reviewResult.findingsSummary });
      }
      if (checkpoint.status === "integrating") {
        return this.integrate({ repository, worktree, featureSlug, checkpoint });
      }
      return { status: checkpoint.status, worktree, plan, checkpoint };
    },

    async integrate({ repository, worktree, featureSlug, checkpoint }) {
      if (checkpoint.status !== "integrating") throw new Error("Checkpoint is not ready for integration");
      if (!await worktreeIsClean(worktree)) throw new Error("Feature worktree is not clean");
      const mainWorktree = await findMainWorktree(repository);
      if (!mainWorktree || !await worktreeIsClean(mainWorktree)) throw new Error("Main worktree is unavailable or not clean");
      const featureHead = await currentHead(worktree);
      try {
        await git(mainWorktree, ["merge", "--no-edit", checkpoint.branch]);
      } catch (error) {
        await gitSucceeds(mainWorktree, ["merge", "--abort"]);
        throw error;
      }
      if (!await isAncestor(mainWorktree, featureHead)) throw new Error("Merged main does not contain feature HEAD");
      const mainCheckpoint = await readCheckpoint(mainWorktree, featureSlug);
      const merged = markMerged(mainCheckpoint, { featureHead, mainWorktree, mergedCommit: await currentHead(mainWorktree) }, now());
      await persistCheckpoint(mainWorktree, featureSlug, merged, "record merged execution");
      return this.completeMergedCleanup({ repository, mainWorktree, featureSlug, checkpoint: merged });
    },

    async completeMergedCleanup({ repository, mainWorktree, featureSlug, checkpoint }) {
      const featureWorktree = await findFeatureWorktree(repository, checkpoint.branch);
      if (featureWorktree) await removeFeatureWorktree({ repository, worktree: featureWorktree });
      const complete = completeIntegration(checkpoint, now());
      await persistCheckpoint(mainWorktree, featureSlug, complete, "complete execution cleanup");
      return { status: "complete", worktree: mainWorktree, checkpoint: complete };
    },
  };
}
