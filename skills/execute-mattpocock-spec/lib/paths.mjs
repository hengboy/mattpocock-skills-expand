import { join } from "node:path";

function assertFeatureSlug(featureSlug) {
  if (typeof featureSlug !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(featureSlug)) {
    throw new Error("featureSlug must contain only lowercase letters, numbers, and hyphens");
  }
}

export function executionDirectory(featureSlug) {
  assertFeatureSlug(featureSlug);
  return join(".scratch", featureSlug);
}

export function planPath(featureSlug) {
  return join(executionDirectory(featureSlug), "plan.json");
}

export function checkpointPath(featureSlug) {
  return join(executionDirectory(featureSlug), "checkpoint.json");
}
