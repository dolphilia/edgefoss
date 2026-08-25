import { randomBytes } from "node:crypto";

if (process.argv.length !== 2) {
  throw new Error("usage: pnpm run auth:generate-owner-token");
}

process.stdout.write(
  `efoss_owner_v0_${randomBytes(32).toString("base64url")}\n`,
);
