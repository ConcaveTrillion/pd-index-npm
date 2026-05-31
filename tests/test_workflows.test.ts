import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("release workflow dispatches index regeneration after publishing the GitHub Release", async () => {
  const workflow = await readFile(".github/workflows/release.yml", "utf8");
  const releaseCreate = workflow.indexOf("gh release create");
  const dispatch = workflow.indexOf("repos/${GITHUB_REPOSITORY}/dispatches");

  assert.notEqual(releaseCreate, -1);
  assert.ok(dispatch > releaseCreate);
  assert.match(workflow, /event_type=pd-npm-publish/);
  assert.match(workflow, /client_payload\[released_repository\]/);
  assert.match(workflow, /client_payload\[released_tag\]/);
});
