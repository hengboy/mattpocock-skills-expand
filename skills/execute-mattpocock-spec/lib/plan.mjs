import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { planPath } from "./paths.mjs";
import { assertExecutionPlan } from "./validation.mjs";

function titleFrom(content, fallback) {
  return content.match(/^#\s+(.+)$/m)?.[1].trim() || fallback;
}

function workItemCountFrom(content) {
  return [...content.matchAll(/^\s*- \[[ xX]\]\s+.+$/gm)].length;
}

function blockedByFrom(content) {
  const value = content.match(/^(?:\*\*)?Blocked by:(?:\*\*)?\s*(.*)$/mi)?.[1] || "";
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

function relativePathWithin(worktree, path) {
  const relativePath = relative(worktree, path);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Local tracker file must be inside the main worktree: ${path}`);
  }
  return relativePath;
}

async function sourceRefWithin(worktree, path) {
  return relativePathWithin(worktree, await realpath(path));
}

const DIRECT_EXECUTION_MAX_CONTENT_LENGTH = 1000;
const DIRECT_EXECUTION_MAX_WORK_ITEMS = 2;
const COMPLEX_TICKET_PATTERN = /\b(?:database|migration|schema|auth(?:entication|orization)?|security|payment|billing|deploy(?:ment)?|release|api|breaking|performance|concurren(?:cy|t)|parallel|integrat(?:e|ion)|distributed|cache)\b|数据库|数据迁移|迁移|鉴权|认证|授权|安全|支付|账单|部署|发布|接口|兼容|性能|并发|集成|分布式|缓存/i;

function executionModeFor(tickets) {
  if (tickets.length !== 1) return "delegated";
  const [ticket] = tickets;
  const task = `${ticket.title}\n${ticket.content}`;
  if (ticket.content.length > DIRECT_EXECUTION_MAX_CONTENT_LENGTH) return "delegated";
  if (ticket.work_item_count > DIRECT_EXECUTION_MAX_WORK_ITEMS) return "delegated";
  return COMPLEX_TICKET_PATTERN.test(task) ? "delegated" : "coordinator";
}

function planTicketFrom({ content, work_item_count, ...ticket }) {
  return ticket;
}

export async function materializeLocalPlan({ mainWorktree, specPath, issuesDirectory, featureSlug, now = new Date().toISOString() }) {
  const mainRoot = await realpath(mainWorktree);
  const sourceSpecPath = resolve(specPath);
  const sourceIssuesDirectory = resolve(issuesDirectory);
  const spec = await readFile(sourceSpecPath, "utf8");
  const specRef = await sourceRefWithin(mainRoot, sourceSpecPath);
  const issueNames = await readdir(sourceIssuesDirectory).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const issueFiles = issueNames.filter((name) => /^\d+-.+\.md$/.test(name)).sort();
  const issueTickets = await Promise.all(issueFiles.map(async (name) => {
    const issuePath = join(sourceIssuesDirectory, name);
    const content = await readFile(issuePath, "utf8");
    const [, id, slug] = name.match(/^(\d+)-(.+)\.md$/);
    return {
      id,
      ref: await sourceRefWithin(mainRoot, issuePath),
      title: titleFrom(content, slug),
      blocked_by: blockedByFrom(content),
      work_item_count: workItemCountFrom(content),
      content,
    };
  }));
  const sourceTickets = issueTickets.length >= 1
    ? levelsFor(issueTickets)
    : [{
      id: "spec",
      ref: specRef,
      title: titleFrom(spec, basename(specPath, ".md")),
      level: 0,
      blocked_by: [],
      work_item_count: workItemCountFrom(spec),
      content: spec,
    }];
  const facts = {
    version: 3,
    created_at: now,
    execution_mode: executionModeFor(sourceTickets),
    spec: { ref: specRef, tracker: "local", feature_slug: featureSlug, title: titleFrom(spec, featureSlug) },
    tickets: sourceTickets.map(planTicketFrom),
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
  return relativePathWithin(await realpath(worktree), await realpath(path));
}

export async function assertLocalPlanInMainWorktree({ mainWorktree, plan }) {
  if (plan.spec.tracker !== "local") return;
  const mainRoot = await realpath(mainWorktree);
  await pathWithin(mainRoot, resolve(mainRoot, plan.spec.ref));
  await Promise.all(plan.tickets.map((ticket) => pathWithin(mainRoot, resolve(mainRoot, ticket.ref))));
}

export function createTicketReader({ mainWorktree, plan }) {
  return async function readTicket(ticketId) {
    if (plan.spec.tracker !== "local") {
      throw new Error(`Ticket source reading is unavailable for tracker: ${plan.spec.tracker}`);
    }
    const { issuePath } = await localTicketPath({ mainWorktree, plan, ticketId });
    return readFile(issuePath, "utf8");
  };
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
  const issuePath = resolve(await realpath(mainWorktree), ticket.ref);
  return { issuePath, relativePath: await pathWithin(mainWorktree, issuePath) };
}

export function verifyPlan(plan) {
  assertExecutionPlan(plan);
  if (plan.execution_mode === "coordinator" && plan.tickets.length !== 1) {
    throw new Error("Coordinator execution is only available for a single Ticket Plan");
  }
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
