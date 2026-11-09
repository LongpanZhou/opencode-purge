#!/usr/bin/env bun
/**
 * pack — build the catalog bundle.
 *
 *   bun scripts/pack.ts [root] [out.json] [--watch]
 *
 * The catalog root comes from argv[2] or the PERSONA_REPO environment
 * variable; output defaults to <project>/dist/personas-pack.json with a
 * .md twin. With --watch the script re-packs whenever the catalog changes —
 * which includes every autoPull refresh the plugin performs — writing only
 * when the rebuilt output differs.
 */

import { existsSync, mkdirSync, readFileSync, statSync, watch, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPack, buildPackMarkdown } from "../src/pack.ts";

const here = dirname(fileURLToPath(import.meta.url));
const watchMode = process.argv.includes("--watch");
const rootArg = process.argv[2] && process.argv[2] !== "--watch" ? process.argv[2] : "";
const rawRoot = rootArg || process.env.PERSONA_REPO?.trim() || "";

if (!rawRoot) {
  console.error("usage: bun scripts/pack.ts <catalog-root> [out.json] [--watch]");
  console.error("(or set the PERSONA_REPO environment variable to a catalog root)");
  process.exit(2);
}
const ROOT = resolve(rawRoot);
if (!existsSync(ROOT) || !statSync(ROOT).isDirectory()) {
  console.error(`catalog root is not a directory: ${ROOT}`);
  process.exit(2);
}
const OUT_JSON = resolve(
  process.argv[3] && process.argv[3] !== "--watch" ? process.argv[3] : join(here, "..", "dist", "personas-pack.json"),
);
const OUT_DIR = dirname(OUT_JSON).toLowerCase();

function packOnce(): void {
  const pack = buildPack(ROOT);
  const markdown = buildPackMarkdown(ROOT);
  const jsonBody = JSON.stringify(pack, null, 2);
  const mdPathDtwin = OUT_JSON.endsWith(".json") ? OUT_JSON.replace(/\.json$/i, ".md") : null;

  let jsonChanged = true;
  try {
    jsonChanged = readFileSync(OUT_JSON, "utf8") !== jsonBody;
  } catch {
    // First run: no pack yet.
  }
  if (jsonChanged) {
    mkdirSync(dirname(OUT_JSON), { recursive: true });
    writeFileSync(OUT_JSON, jsonBody, "utf8");
  }

  let mdChanged = false;
  if (mdPathDtwin) {
    mdChanged = (() => {
      try {
        if (readFileSync(mdPathDtwin, "utf8") === markdown) return false;
      } catch {
        // First run.
      }
      mkdirSync(dirname(mdPathDtwin), { recursive: true });
      writeFileSync(mdPathDtwin, markdown, "utf8");
      return true;
    })();
  }

  if (jsonChanged || mdChanged) {
    console.log(
      `packed ${pack.count} file(s) from ${pack.vendors} vendor(s) ` +
        `(${pack.bytes.toLocaleString("en-US")} chars) -> ${OUT_JSON}${mdChanged ? " + md" : ""}`,
    );
  }
}

packOnce();
if (!watchMode) process.exit(0);

console.log(`watching ${ROOT} for catalog changes...`);
let timer: ReturnType<typeof setTimeout> | null = null;
watch(ROOT, { recursive: true }, (_event, filename) => {
  // Ignore our own pack writes when the output lives inside the watched root
  // (e.g. a catalog that contains dist/); otherwise the watcher loops.
  if (filename) {
    const candidate = resolve(ROOT, String(filename));
    if (candidate.toLowerCase().startsWith(OUT_DIR)) return;
  }
  // The plugin's git pull rewrites many files in one second; coalesce.
  if (timer) clearTimeout(timer);
  timer = setTimeout(packOnce, 600);
});
