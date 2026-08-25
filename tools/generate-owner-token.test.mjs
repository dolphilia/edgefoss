import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import test from "node:test";

function generateToken() {
  const result = spawnSync(
    process.execPath,
    ["tools/generate-owner-token.mjs"],
    {
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("owner token generator emits independent 256-bit base64url tokens", () => {
  const first = generateToken();
  const second = generateToken();

  assert.match(first, /^efoss_owner_v0_[A-Za-z0-9_-]{43}$/);
  assert.match(second, /^efoss_owner_v0_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
});
