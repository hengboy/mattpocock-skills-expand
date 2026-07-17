import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

async function loadRuntimeDependencies() {
  return Promise.all([import("ajv/dist/2020.js"), import("ajv-formats")]);
}

function installRuntimeDependencies() {
  const skillDirectory = fileURLToPath(new URL("../", import.meta.url));
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  execFileSync(npm, ["ci", "--omit=dev"], { cwd: skillDirectory, stdio: "inherit" });
}

let runtime;
try {
  runtime = await loadRuntimeDependencies();
} catch (error) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND" && error?.code !== "MODULE_NOT_FOUND") throw error;
  installRuntimeDependencies();
  runtime = await Promise.all([
    import(new URL("../node_modules/ajv/dist/2020.js", import.meta.url).href),
    import(new URL("../node_modules/ajv-formats/dist/index.js", import.meta.url).href),
  ]);
}

const [{ default: Ajv2020 }, { default: addFormats }] = runtime;
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

async function schema(name) {
  return JSON.parse(await readFile(new URL(`../${name}`, import.meta.url), "utf8"));
}

const [planSchema, checkpointSchema, completionSchema] = await Promise.all([
  schema("execution-plan-schema.json"),
  schema("checkpoint-schema.json"),
  schema("completion-result-schema.json"),
]);

const validatePlan = ajv.compile(planSchema);
const validateCheckpoint = ajv.compile(checkpointSchema);
const validateCompletion = ajv.compile(completionSchema);

function assertValid(validate, name, value) {
  if (!validate(value)) throw new Error(`${name} violates schema: ${ajv.errorsText(validate.errors)}`);
  return value;
}

export const assertExecutionPlan = (plan) => assertValid(validatePlan, "Execution Plan", plan);
export const assertCheckpoint = (checkpoint) => assertValid(validateCheckpoint, "Checkpoint", checkpoint);
export const assertCompletionResult = (result) => assertValid(validateCompletion, "Completion Result", result);
