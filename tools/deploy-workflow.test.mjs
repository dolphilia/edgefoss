import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowPath = ".github/workflows/deploy-staging-worker.yml";
const workerConfigPath = "apps/worker/wrangler.jsonc";
const resourceManifestPath = "infra/cloud-resources.json";

test("staging deployment workflow is manual, main-only, and least privilege", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /^\s*workflow_dispatch:\s*$/mu);
  assert.doesNotMatch(workflow, /^\s*(push|pull_request|schedule):/mu);
  assert.match(workflow, /^permissions:\s*\n\s+contents: read$/mu);
  assert.match(workflow, /GITHUB_REF.*refs\/heads\/main/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.match(workflow, /pnpm check/u);
  assert.match(workflow, /deploy --dry-run --env staging/u);
  assert.match(
    workflow,
    /cloudflare\/wrangler-action@[0-9a-f]{40} # v4\.0\.0/u,
  );
  assert.match(workflow, /command: deploy --env staging/u);
  assert.match(workflow, /secrets\.CLOUDFLARE_API_TOKEN/u);
  assert.match(workflow, /secrets\.CLOUDFLARE_ACCOUNT_ID/u);
  assert.match(workflow, /Require the U3 credentials/u);
  assert.match(workflow, /audit-worker-health\.mjs/u);
  assert.match(workflow, /audit-worker-public-sync\.mjs/u);
  assert.match(workflow, /audit-worker-public-transfer\.mjs/u);
  assert.doesNotMatch(workflow, /cloud:smoke-public-inventory/u);
  assert.doesNotMatch(workflow, /cloud:provision|--env production/u);
});

test("staging Queue activation exactly matches the manifest and leaves production disconnected", async () => {
  const [configText, manifestText] = await Promise.all([
    readFile(workerConfigPath, "utf8"),
    readFile(resourceManifestPath, "utf8"),
  ]);
  const config = JSON.parse(configText.replace(/,\s*([}\]])/gu, "$1"));
  const manifest = JSON.parse(manifestText);
  const stagingQueue = manifest.environments.staging.queue;

  assert.deepEqual(config.env.staging.queues, {
    producers: [
      {
        binding: stagingQueue.binding,
        queue: stagingQueue.name,
      },
    ],
    consumers: [
      {
        queue: stagingQueue.name,
        max_batch_size: stagingQueue.consumer.maxBatchSize,
        max_batch_timeout: stagingQueue.consumer.maxBatchTimeoutSeconds,
        max_retries: stagingQueue.consumer.maxRetries,
        dead_letter_queue: stagingQueue.deadLetterQueue.name,
      },
    ],
  });
  assert.deepEqual(config.env.production.queues, {
    producers: [],
    consumers: [],
  });
});
