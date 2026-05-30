import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createLinter } from "actionlint";

const workflowDir = ".github/workflows";
const args = process.argv.slice(2);

async function defaultWorkflowFiles() {
  const entries = await readdir(workflowDir);
  return entries
    .filter((entry) => entry.endsWith(".yml") || entry.endsWith(".yaml"))
    .map((entry) => join(workflowDir, entry));
}

const files = args.length > 0 ? args : await defaultWorkflowFiles();
const lint = await createLinter();
let failureCount = 0;

for (const file of files) {
  const input = await readFile(file, "utf8");
  const results = lint(input, file);
  for (const result of results) {
    failureCount += 1;
    console.error(
      `${result.file}:${result.line}:${result.column}: ${result.message} [${result.kind}]`,
    );
  }
}

if (failureCount > 0) {
  process.exit(1);
}
