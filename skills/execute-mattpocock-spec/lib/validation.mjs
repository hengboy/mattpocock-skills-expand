import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

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
