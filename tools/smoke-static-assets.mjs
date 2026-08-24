import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "edgefoss-static-smoke-"));
const site = join(temporaryRoot, "site");
const config = join(repositoryRoot, "apps/static-site/wrangler.jsonc");
const wrangler = join(repositoryRoot, "node_modules/.bin/wrangler");
const childEnvironment = {
  ...process.env,
  WRANGLER_LOG_PATH: join(temporaryRoot, "wrangler.log"),
};

function run(command, commandArguments) {
  return new Promise((accept, reject) => {
    const child = spawn(command, commandArguments, {
      cwd: repositoryRoot,
      env: childEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        accept({ stdout, stderr });
      } else {
        reject(
          new Error(
            `${command} failed (code=${code}, signal=${signal})\n${stdout}${stderr}`,
          ),
        );
      }
    });
  });
}

function availablePort() {
  return new Promise((accept, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate a local smoke port"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else accept(address.port);
      });
    });
  });
}

function expect(condition, message) {
  if (!condition) throw new Error(`static assets smoke failed: ${message}`);
}

async function generatedFiles(root, current = root) {
  const files = [];
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await generatedFiles(root, path)));
    else files.push(path.slice(root.length + 1).replaceAll("\\", "/"));
  }
  return files;
}

async function waitForServer(url, processOutput) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (processOutput.exited) {
      throw new Error(
        `wrangler dev exited before serving requests\n${processOutput.stdout}${processOutput.stderr}`,
      );
    }
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // The server is still starting.
    }
    await new Promise((accept) => setTimeout(accept, 100));
  }
  throw new Error(
    `wrangler dev did not become ready\n${processOutput.stdout}${processOutput.stderr}`,
  );
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((accept) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      accept();
    });
    child.kill("SIGTERM");
  });
}

let developmentServer;
try {
  await run("cargo", [
    "run",
    "--quiet",
    "-p",
    "ef-testkit",
    "--bin",
    "ef-static-fixture",
    "--",
    "--output",
    site,
  ]);
  for (const environment of ["", "staging", "production"]) {
    await run(wrangler, [
      "deploy",
      "--config",
      config,
      `--env=${environment}`,
      "--assets",
      site,
      "--dry-run",
      "--outdir",
      join(temporaryRoot, `dry-run-${environment || "root"}`),
    ]);
  }

  const port = await availablePort();
  const processOutput = { exited: false, stdout: "", stderr: "" };
  developmentServer = spawn(
    wrangler,
    [
      "dev",
      "--config",
      config,
      "--env=",
      "--assets",
      site,
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--show-interactive-dev-session=false",
      "--log-level",
      "error",
    ],
    {
      cwd: repositoryRoot,
      env: childEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  developmentServer.stdout.setEncoding("utf8").on("data", (chunk) => {
    processOutput.stdout += chunk;
  });
  developmentServer.stderr.setEncoding("utf8").on("data", (chunk) => {
    processOutput.stderr += chunk;
  });
  developmentServer.once("exit", () => {
    processOutput.exited = true;
  });

  const origin = `http://127.0.0.1:${port}`;
  const index = await waitForServer(`${origin}/`, processOutput);
  const indexBody = await index.text();
  expect(index.status === 200, "index status is not 200");
  expect(
    indexBody.includes("EdgeFossil static smoke"),
    "index is not generated fixture output",
  );
  expect(
    index.headers
      .get("content-security-policy")
      ?.includes("default-src 'none'"),
    "generated Content-Security-Policy is missing",
  );
  expect(
    index.headers.get("x-content-type-options") === "nosniff",
    "generated nosniff header is missing",
  );

  const history = await fetch(`${origin}/history/page-0001.html`);
  const historyBody = await history.text();
  expect(history.status === 200, "history status is not 200");
  expect(
    historyBody.includes("public static smoke"),
    "public history is missing",
  );
  expect(
    !historyBody.includes("members-smoke-secret"),
    "members content leaked into history",
  );

  const files = await fetch(`${origin}/files/page-0001.html`);
  const filesBody = await files.text();
  expect(files.status === 200, "files status is not 200");
  expect(filesBody.includes("README.md"), "public file metadata is missing");
  expect(
    filesBody.includes("../content/chunk-0001.html#blob-"),
    "public file content link is missing",
  );
  expect(
    !filesBody.includes("local-smoke-secret"),
    "local content leaked into files",
  );

  const content = await fetch(`${origin}/content/chunk-0001.html`);
  const contentBody = await content.text();
  expect(content.status === 200, "content chunk status is not 200");
  expect(
    contentBody.includes("public smoke content"),
    "public file content is missing",
  );
  expect(
    !contentBody.includes("members-smoke-secret") &&
      !contentBody.includes("local-smoke-secret"),
    "restricted content leaked into content chunk",
  );

  const manifestResponse = await fetch(`${origin}/edgefossil-site.json`);
  const manifest = await manifestResponse.json();
  expect(manifestResponse.status === 200, "site manifest status is not 200");
  expect(
    manifest.source?.realm === "public",
    "site manifest realm is not public",
  );
  expect(
    manifest.payloads?.delivery === "bounded-static-chunks",
    "bounded payload delivery is missing",
  );
  expect(
    manifest.payloads?.inline_text_objects === 1,
    "inline object count differs",
  );
  expect(
    manifest.payloads?.chunks?.length === 1,
    "content chunk count differs",
  );

  const missing = await fetch(`${origin}/definitely-missing`);
  const missingBody = await missing.text();
  expect(missing.status === 404, "missing asset does not return 404");
  expect(
    missingBody.includes("404 · Not found"),
    "generated 404 page is not served",
  );
  expect(
    missingBody === (await readFile(join(site, "404.html"), "utf8")),
    "served 404 body differs from generated bytes",
  );

  const internalHeaders = await fetch(`${origin}/_headers`);
  expect(
    internalHeaders.status === 404,
    "_headers is exposed as a public asset",
  );

  const servedFiles = (await generatedFiles(site)).filter(
    (path) => path !== "_headers" && path !== "404.html",
  );
  for (const path of servedFiles) {
    const urlPath = path.split("/").map(encodeURIComponent).join("/");
    const response = await fetch(`${origin}/${urlPath}`);
    const actual = Buffer.from(await response.arrayBuffer());
    const expected = await readFile(join(site, path));
    expect(response.status === 200, `generated asset is not served: ${path}`);
    expect(actual.equals(expected), `served bytes differ: ${path}`);
  }

  const generatedManifest = JSON.parse(
    await readFile(join(site, "edgefossil-site.json"), "utf8"),
  );
  expect(
    generatedManifest.source.semantic_root === manifest.source.semantic_root,
    "served semantic root differs from generated output",
  );
  console.log(
    `Static assets smoke passed; files=${servedFiles.length}, status=200/404, worker_script=absent, semantic_root=${manifest.source.semantic_root}`,
  );
} finally {
  if (developmentServer !== undefined) await stop(developmentServer);
  await rm(temporaryRoot, { recursive: true, force: true });
}
