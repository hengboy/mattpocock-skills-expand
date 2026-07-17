import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function git(cwd, args) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
    return stdout.trim();
  } catch (error) {
    const detail = error.stderr?.trim() || error.message;
    throw new Error(`git ${args.join(" ")} failed: ${detail}`, { cause: error });
  }
}

export async function gitSucceeds(cwd, args) {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

export async function repoRoot(cwd) {
  return git(cwd, ["rev-parse", "--show-toplevel"]);
}

export async function currentHead(cwd) {
  return git(cwd, ["rev-parse", "HEAD"]);
}

export async function isAncestor(cwd, ancestor, descendant = "HEAD") {
  return gitSucceeds(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
}
