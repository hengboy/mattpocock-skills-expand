import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import { planPath } from "./paths.mjs";
import { assertExecutionPlan } from "./validation.mjs";

function titleFrom(content, fallback) {
  return content.match(/^#\s+(.+)$/m)?.[1].trim() || fallback;
}

function acceptanceFrom(content) {
  return [...content.matchAll(/^\s*- \[[ xX]\]\s+(.+)$/gm)].map((match) => match[1]);
}

function blockedByFrom(content) {
  const value = content.match(/^Blocked by:\s*(.*)$/mi)?.[1] || "";
  return [...new Set(value.match(/\b\d+\b/g) || [])];
}

function levelsFor(tickets) {
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const resolving = new Set();
  const resolved = new Map();

  function level(ticket) {
    if (resolved.has(ticket.id)) return resolved.get(ticket.id);
    if (resolving.has(ticket.id)) throw new Error(`Ticket dependency cycle includes ${ticket.id}`);
    resolving.add(ticket.id);
    const blockerLevels = ticket.blocked_by.map((id) => {
      const blocker = byId.get(id);
      if (!blocker) throw new Error(`Ticket ${ticket.id} references unknown blocker ${id}`);
      return level(blocker);
    });
    resolving.delete(ticket.id);
    const result = blockerLevels.length === 0 ? 0 : Math.max(...blockerLevels) + 1;
    resolved.set(ticket.id, result);
    return result;
  }

  return tickets.map((ticket) => ({ ...ticket, level: level(ticket) }));
}

function revisionFor(facts) {
  return createHash("sha256").update(JSON.stringify(facts)).digest("hex");
}

export async function materializeLocalPlan({ specPath, issuesDirectory, featureSlug, now = new Date().toISOString() }) {
  const spec = await readFile(specPath, "utf8");
  const issueNames = await readdir(issuesDirectory).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const issueFiles = issueNames.filter((name) => /^\d+-.+\.md$/.test(name)).sort();
  const issueTickets = await Promise.all(issueFiles.map(async (name) => {
    const content = await readFile(join(issuesDirectory, name), "utf8");
    const [, id, slug] = name.match(/^(\d+)-(.+)\.md$/);
    return {
      id,
      title: titleFrom(content, slug),
      blocked_by: blockedByFrom(content),
      acceptance: acceptanceFrom(content),
      content,
    };
  }));
  const tickets = issueTickets.length >= 1
    ? levelsFor(issueTickets)
    : [{
      id: "spec",
      title: titleFrom(spec, basename(specPath, ".md")),
      level: 0,
      blocked_by: [],
      acceptance: acceptanceFrom(spec),
      content: spec,
    }];
  const facts = {
    version: 1,
    created_at: now,
    spec: { ref: specPath, issues_directory: issuesDirectory, tracker: "local", feature_slug: featureSlug, title: titleFrom(spec, featureSlug), content: spec },
    tickets,
  };
  return { ...facts, revision: revisionFor(facts) };
}

export async function writePlan(worktree, plan) {
  verifyPlan(plan);
  const path = join(worktree, planPath(plan.spec.feature_slug));
  await mkdir(join(worktree, ".scratch", plan.spec.feature_slug), { recursive: true });
  await writeFile(path, `${JSON.stringify(plan, null, 2)}\n`);
  return path;
}

export async function readPlan(worktree, featureSlug) {
  return verifyPlan(JSON.parse(await readFile(join(worktree, planPath(featureSlug)), "utf8")));
}

async function pathWithin(worktree, path) {
  const relativePath = relative(await realpath(worktree), await realpath(path));
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Local tracker file must be inside the main worktree: ${path}`);
  }
  return relativePath;
}

export async function assertLocalPlanInMainWorktree({ mainWorktree, plan }) {
  if (plan.spec.tracker !== "local") return;
  await pathWithin(mainWorktree, plan.spec.ref);
  if (plan.tickets.some((ticket) => ticket.id !== "spec")) {
    if (!plan.spec.issues_directory) throw new Error("Local Execution Plan does not identify its issues directory");
    await pathWithin(mainWorktree, plan.spec.issues_directory);
  }
}

export async function checkLocalTicketBoxes({ mainWorktree, plan, ticketId }) {
  if (plan.spec.tracker !== "local") return [];
  const { issuePath, relativePath } = await localTicketPath({ mainWorktree, plan, ticketId });
  const content = await readFile(issuePath, "utf8");
  const updated = content.replace(/^(\s*-\s*)\[ \]/gm, "$1[x]");
  if (updated === content) return [];
  await writeFile(issuePath, updated);
  return [relativePath];
}

export async function localTicketPaths({ mainWorktree, plan }) {
  if (plan.spec.tracker !== "local") return [];
  return Promise.all(plan.tickets.map(async ({ id: ticketId }) => {
    const { relativePath } = await localTicketPath({ mainWorktree, plan, ticketId });
    return relativePath;
  }));
}

async function localTicketPath({ mainWorktree, plan, ticketId }) {
  const ticket = plan.tickets.find((candidate) => candidate.id === ticketId);
  if (!ticket) throw new Error(`Unknown Plan Ticket: ${ticketId}`);
  let issuePath;
  if (ticketId === "spec") {
    issuePath = plan.spec.ref;
  } else {
    if (!plan.spec.issues_directory) throw new Error("Local Execution Plan does not identify its issues directory");
    const issueNames = await readdir(plan.spec.issues_directory);
    const issueName = issueNames.find((name) => name.match(new RegExp(`^${ticketId.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}-.*\\.md$`)));
    if (!issueName) throw new Error(`Local Issue file is missing for Ticket ${ticketId}`);
    issuePath = join(plan.spec.issues_directory, issueName);
  }
  return { issuePath, relativePath: await pathWithin(mainWorktree, issuePath) };
}

export function verifyPlan(plan) {
  assertExecutionPlan(plan);
  const { revision, ...facts } = plan;
  if (revisionFor(facts) !== revision) throw new Error("Execution Plan revision does not match its immutable facts");
  return plan;
}

export function createTrackerMaterializer(adapters = {}) {
  return async function materialize(input) {
    if (input.tracker === "local") return materializeLocalPlan(input);
    const adapter = adapters[input.tracker];
    if (!adapter) throw new Error(`Tracker ${input.tracker} is blocked: no materialization adapter is configured`);
    return adapter(input);
  };
}
