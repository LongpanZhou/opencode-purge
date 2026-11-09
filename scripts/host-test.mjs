#!/usr/bin/env node
/**
 * Run the plugin against a real clone of https://github.com/anomalyco/opencode.
 *
 *   OPENCODE_SRC=/path/to/opencode node scripts/host-test.mjs
 *   node scripts/host-test.mjs /path/to/opencode
 *
 * The script copies test/host/opencode-purge.template.ts into the clone's
 * packages/core/test/plugin, points its import at this repository, runs it
 * with Bun, and removes it again (pass --keep to leave it in place).
 *
 * The clone must have its dependencies installed:
 *
 *   cd /path/to/opencode && bun install --frozen-lockfile
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = (process.env.OPENCODE_SRC || process.argv[2] || "").trim();
const keep = process.argv.includes("--keep");

if (!src) {
  console.error("usage: OPENCODE_SRC=/path/to/opencode node scripts/host-test.mjs [--keep]");
  process.exit(2);
}

const core = join(resolve(src), "packages", "core");
const destination = join(core, "test", "plugin", "opencode-purge.host.test.ts");

if (!existsSync(join(core, "package.json"))) {
  console.error(`not an OpenCode clone: ${core}`);
  process.exit(2);
}
if (!existsSync(join(core, "..", "..", "node_modules"))) {
  console.error(`dependencies are not installed in ${resolve(src)}`);
  console.error(`run: cd ${resolve(src)} && bun install --frozen-lockfile`);
  process.exit(2);
}

let specifier = relative(dirname(destination), join(repo, "src", "index.ts")).split(sep).join("/");
if (!specifier.startsWith(".")) specifier = `./${specifier}`;

const template = readFileSync(join(repo, "test", "host", "opencode-purge.template.ts"), "utf8");
writeFileSync(destination, template.replaceAll("__PLUGIN_IMPORT__", specifier), "utf8");
console.log(`host test: ${destination}`);
console.log(`plugin    : ${specifier}`);

try {
  const result = spawnSync("bun", ["test", "test/plugin/opencode-purge.host.test.ts"], {
    cwd: core,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  process.exitCode = result.status ?? 1;
} finally {
  if (!keep) rmSync(destination, { force: true });
}
