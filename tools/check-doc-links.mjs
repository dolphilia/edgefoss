import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const markdownRoots = [resolve(repositoryRoot, "docs")];
const rootMarkdown = ["README.md", "CONTRIBUTING.md"]
  .map((name) => resolve(repositoryRoot, name))
  .filter(existsSync);

function collectMarkdown(path) {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory())
    return extname(path) === ".md" ? [path] : [];

  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    collectMarkdown(resolve(path, entry.name)),
  );
}

const files = [...markdownRoots.flatMap(collectMarkdown), ...rootMarkdown];
const failures = [];
const markdownLink = /!?\[[^\]]*\]\(([^)]+)\)/g;

for (const file of files) {
  const source = readFileSync(file, "utf8");

  for (const match of source.matchAll(markdownLink)) {
    const rawTarget = match[1]?.trim();
    if (
      rawTarget === undefined ||
      rawTarget.startsWith("#") ||
      /^[a-z][a-z\d+.-]*:/iu.test(rawTarget)
    ) {
      continue;
    }

    const withoutTitle = rawTarget.replace(/\s+["'][^"']*["']$/u, "");
    const withoutAnchor = withoutTitle.split("#", 1)[0] ?? "";
    const unwrapped = withoutAnchor.replace(/^<|>$/gu, "");

    let decoded;
    try {
      decoded = decodeURIComponent(unwrapped);
    } catch {
      failures.push(`${file}: invalid percent encoding in ${rawTarget}`);
      continue;
    }

    const target = resolve(dirname(file), decoded);
    if (!existsSync(target)) failures.push(`${file}: missing ${rawTarget}`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Checked ${files.length} Markdown files; local links are valid.`);
}
