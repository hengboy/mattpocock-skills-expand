import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const skillDirectory = fileURLToPath(new URL("../", import.meta.url));
const requiredFiles = ["package.json", "package-lock.json"];

try {
  await Promise.all(requiredFiles.map((file) => access(new URL(`../${file}`, import.meta.url))));
  await import("../lib/validation.mjs");
  console.log("Runtime dependencies are available.");
} catch (error) {
  console.error(`Runtime dependency check failed: ${error.message}`);
  console.error(`Run \"npm ci --omit=dev\" in ${skillDirectory}, then rerun \"npm run check:runtime\".`);
  process.exitCode = 1;
}
