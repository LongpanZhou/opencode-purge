#!/usr/bin/env bun
/**
 * Diagnostic: what does this catalog actually resolve, and why?
 *
 *   bun scripts/diag-resolve.ts                          # default matrix, root from PERSONA_REPO
 *   bun scripts/diag-resolve.ts <catalog-root>
 *   bun scripts/diag-resolve.ts <catalog-root> anthropic/claude-sonnet-4 opencode-go/deepseek-v4.1-flash#max
 *
 * Resolution uses the same CatalogSource the plugin uses (pins → cache →
 * alias index → scorer), so it reports what /purge on will pick. Exits 1 when
 * any requested ref resolves to nothing — usable as a pre-commit gate for
 * catalog.json changes. `--why` prints vendor scores for misses.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  CatalogSource,
  loadCatalogConfigWithError,
  scoreVendor,
  scoreFile,
  pickFile,
  type ModelRef,
} from "../src/catalog.ts";

const args = process.argv.slice(2);
const why = args.includes("--why");
const positional = args.filter((arg) => arg !== "--why");
const root = positional[0] ?? process.env.PERSONA_REPO?.trim() ?? "";

if (!root) {
  console.error("usage: bun scripts/diag-resolve.ts <catalog-root> [provider/id[#variant] ...] [--why]");
  process.exit(2);
}

const DEFAULT_REFS = [
  "opencode-go/deepseek-v4.1-flash#max",
  "opencode/deepseek-v4.1-flash-free",
  "anthropic/claude-sonnet-4",
  "moonshotai/kimi-k3.1",
  "google/gemini-3.1-pro",
  "zhipu/glm-5.2",
  "xai/grok-4",
  "alibaba/qwen-3.8",
];

function parseRef(span: string): ModelRef | null {
  const [head, variant] = span.split("#") as [string, string | undefined];
  const slash = head.indexOf("/");
  if (slash <= 0 || slash === head.length - 1) return null;
  return {
    providerID: head.slice(0, slash),
    id: head.slice(slash + 1),
    ...(variant ? { variant } : {}),
  };
}

const spans = positional.slice(1).filter((arg) => arg.includes("/"));
const refs = (spans.length > 0 ? spans : DEFAULT_REFS).map(parseRef).filter((ref): ref is ModelRef => ref !== null);
if (refs.length === 0) {
  console.error("no valid provider/id refs given");
  process.exit(2);
}

const source = new CatalogSource(root);
const vendors = source.refresh();
const files = vendors.reduce((count, vendor) => count + vendor.files.length, 0);
console.log(`catalog: ${root}`);
console.log(`vendors: ${vendors.length}, files: ${files}`);
const tableFile = join(root, "catalog.json");
if (!existsSync(tableFile)) {
  console.log(`lookup table: absent (built-ins only)`);
} else {
  const loaded = loadCatalogConfigWithError(root);
  if (loaded.error) {
    console.error(`lookup table: INVALID catalog.json — ${loaded.error}`);
    console.error("resolution below uses built-ins only; fix the JSON before trusting results.");
    process.exit(2);
  }
  console.log(`lookup table: catalog.json present and valid`);
}
console.log("");

let misses = 0;
for (const ref of refs) {
  const label = `${ref.providerID}/${ref.id}${ref.variant ? `#${ref.variant}` : ""}`;
  const hit = source.resolve(ref);
  console.log(`${label.padEnd(44)} -> ${hit ? `${hit.vendor.name}/${hit.file.name}` : "NO MATCH"}`);
  if (hit) continue;
  misses += 1;
  if (!why) continue;
  const ranked = vendors
    .map((vendor) => ({ vendor, score: scoreVendor(vendor, ref) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  if (ranked.length === 0) {
    console.log("   no vendor identity word matched — consider catalog.json modelAliases or a models pin");
    continue;
  }
  for (const { vendor, score } of ranked) {
    const best = pickFile(vendor.files, ref, false);
    const fileScore = best ? scoreFile(best, ref) : -1;
    console.log(`   vendor ${vendor.name} (${score}) best file ${best?.name ?? "—"} (${fileScore})`);
  }
}

if (misses > 0) process.exit(1);
