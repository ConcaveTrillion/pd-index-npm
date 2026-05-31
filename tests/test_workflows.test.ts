import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("release workflow calls index regeneration after publishing the GitHub Release", async () => {
  const workflow = await readFile(".github/workflows/release.yml", "utf8");
  const releaseCreate = workflow.indexOf("gh release create");
  const refreshIndex = workflow.indexOf("refresh-index:");

  assert.notEqual(releaseCreate, -1);
  assert.ok(refreshIndex > releaseCreate);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/regen\.yml/);
  assert.match(workflow, /pages: write/);
  assert.match(workflow, /id-token: write/);
});

test("regen workflow keeps external publisher dispatch event", async () => {
  const workflow = await readFile(".github/workflows/regen.yml", "utf8");

  assert.match(workflow, /^name: regen-and-deploy$/m);
  assert.match(workflow, /workflow_call:/);
  assert.match(workflow, /types: \[pd-npm-publish\]/);
});
