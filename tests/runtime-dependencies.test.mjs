import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const sourceSkill = new URL("../skills/execute-mattpocock-spec/", import.meta.url);

async function runNode(cwd, environment = process.env) {
  return run(process.execPath, ["--input-type=module", "--eval", 'await import("./lib/validation.mjs")'], {
    cwd,
    env: environment,
  });
}

async function runRuntimeCheck(cwd) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  return run(npm, ["run", "check:runtime"], { cwd });
}

test("runtime preflight installs locked dependencies when validation cannot load", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "execute-skill-runtime-"));
  const skill = join(directory, "execute-mattpocock-spec");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(sourceSkill, skill, { recursive: true });
  await rm(join(skill, "node_modules"), { recursive: true, force: true });

  const { stderr } = await runRuntimeCheck(skill);
  assert.equal(stderr, "");
  const ajvFormats = JSON.parse(await readFile(join(skill, "node_modules", "ajv-formats", "package.json"), "utf8"));
  assert.equal(ajvFormats.version, "3.0.1");
});

test("does not install dependencies when the validation module already loads", async () => {
  const { stderr } = await runNode(new URL("../skills/execute-mattpocock-spec/", import.meta.url).pathname, { ...process.env, PATH: "" });
  assert.equal(stderr, "");
});
