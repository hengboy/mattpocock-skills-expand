import { checkpointPath, planPath } from "./paths.mjs";
import { beginReview, blockTicket, completeIntegration, completeReview, completeTicket, createCheckpoint, markMerged, readCheckpoint, relocateCheckpoint, startTickets, writeCheckpoint } from "./checkpoint.mjs";
import { verifyCheckpointIntegrity } from "./checkpoint-integrity.mjs";
import { currentHead, git, gitSucceeds, isAncestor } from "./git.mjs";
import { createTrackerMaterializer, readPlan, writePlan } from "./plan.mjs";
import { createFeatureWorktree, ensureFeatureWorktree, findFeatureWorktree, findMainWorktree, removeFeatureWorktree, worktreeIsClean } from "./worktree-lifecycle.mjs";

async function commitFiles(worktree, files, message) {
  await git(worktree, ["add", "--", ...files]);
  await git(worktree, ["commit", "-m", message]);
}

async function persistCheckpoint(worktree, featureSlug, checkpoint, message) {
  await writeCheckpoint(worktree, featureSlug, checkpoint);
  await commitFiles(worktree, [checkpointPath(featureSlug)], message);
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
      const worktree = await createFeatureWorktree({ repository, branch, baseline, path: worktreePath });
      const plan = await materialize(tracker);
      await writePlan(worktree, plan);
      const checkpoint = createCheckpoint({ plan, baseline, branch, worktree, now: now() });
      await writeCheckpoint(worktree, plan.spec.feature_slug, checkpoint);
      await commitFiles(worktree, [planPath(plan.spec.feature_slug), checkpointPath(plan.spec.feature_slug)], "initialize execution");
      return { worktree, plan, checkpoint };
    },

    async resume({ repository, branch, featureSlug, worktreePath }) {
      const mainWorktree = await findMainWorktree(repository);
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
      const ensured = await ensureFeatureWorktree({ repository, branch, path: worktreePath });
      let checkpoint = await readCheckpoint(ensured.worktree, featureSlug);
      if (checkpoint.worktree !== ensured.worktree) {
        checkpoint = relocateCheckpoint(checkpoint, ensured.worktree, now());
        await persistCheckpoint(ensured.worktree, featureSlug, checkpoint, "relocate checkpoint worktree");
      }
      const integrity = await verifyCheckpointIntegrity({ worktree: ensured.worktree, featureSlug });
      if (integrity.status !== "valid") throw new Error(`Checkpoint integrity failed: ${JSON.stringify(integrity.diagnostics)}`);
      return { status: "resumed", worktree: ensured.worktree, ...integrity };
    },

    async executeFrontier({ worktree, featureSlug, plan, checkpoint }) {
      if (!adapter) throw new Error("Completion Adapter is required to execute a Frontier");
      const unfinished = plan.tickets.filter((ticket) => checkpoint.tickets.find((state) => state.id === ticket.id)?.status !== "done");
      if (unfinished.length === 0) throw new Error("No unfinished Ticket remains");
      const activeLevel = Math.min(...unfinished.map((ticket) => ticket.level));
      const frontier = plan.tickets.filter((ticket) => ticket.level === activeLevel && ["pending", "in_progress"].includes(checkpoint.tickets.find((state) => state.id === ticket.id)?.status));
      const pending = frontier.filter((ticket) => checkpoint.tickets.find((state) => state.id === ticket.id).status === "pending");
      if (pending.length > 0) {
        checkpoint = startTickets(checkpoint, pending.map((ticket) => ticket.id), await currentHead(worktree), now());
        await persistCheckpoint(worktree, featureSlug, checkpoint, `dispatch frontier ${activeLevel}`);
      }
      const results = await adapter.executeFrontier({ tickets: frontier, worktree });
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
        await persistCheckpoint(worktree, featureSlug, checkpoint, `checkpoint ${ticket.id}`);
      }
      return { checkpoint, results };
    },

    async startReview({ worktree, featureSlug, checkpoint }) {
      const reviewing = beginReview(checkpoint, now());
      return persistCheckpoint(worktree, featureSlug, reviewing, "start final review");
    },

    async finishReview({ worktree, featureSlug, checkpoint, findingsSummary }) {
      const integrating = completeReview(checkpoint, findingsSummary, now());
      return persistCheckpoint(worktree, featureSlug, integrating, "complete final review");
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
