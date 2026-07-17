import { access, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { git, gitSucceeds, repoRoot } from "./git.mjs";

function parseWorktrees(output) {
  const entries = [];
  let current = {};
  for (const line of output.split("\n")) {
    if (!line) {
      if (current.worktree) entries.push(current);
      current = {};
      continue;
    }
    const [key, ...rest] = line.split(" ");
    current[key] = rest.join(" ");
  }
  if (current.worktree) entries.push(current);
  return entries;
}

export async function findFeatureWorktree(repository, branch) {
  const target = `refs/heads/${branch}`;
  const entries = parseWorktrees(await git(repository, ["worktree", "list", "--porcelain"]));
  return entries.find((entry) => entry.branch === target)?.worktree || null;
}

export async function worktreeIsClean(worktree) {
  return (await git(worktree, ["status", "--porcelain"])) === "";
}

async function prepareNewWorktreePath(path) {
  const target = resolve(path);
  try {
    await access(target);
    throw new Error(`Worktree path already exists: ${target}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(dirname(target), { recursive: true });
  return target;
}

export async function ensureFeatureWorktree({ repository, branch, path }) {
  const root = await repoRoot(repository);
  const existing = await findFeatureWorktree(root, branch);
  if (existing) return { worktree: existing, created: false };
  if (!await gitSucceeds(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])) {
    throw new Error(`Feature branch ${branch} does not exist`);
  }
  const target = await prepareNewWorktreePath(path);
  await git(root, ["worktree", "add", target, branch]);
  return { worktree: target, created: true };
}

export async function createFeatureWorktree({ repository, branch, baseline, path }) {
  const root = await repoRoot(repository);
  const target = await prepareNewWorktreePath(path);
  await git(root, ["worktree", "add", "-b", branch, target, baseline]);
  return target;
}

export async function removeFeatureWorktree({ repository, worktree }) {
  const root = await repoRoot(repository);
  if (!await worktreeIsClean(worktree)) throw new Error(`Feature worktree is not clean: ${worktree}`);
  await git(root, ["worktree", "remove", worktree]);
}

export async function findMainWorktree(repository) {
  return findFeatureWorktree(repository, "main");
}
