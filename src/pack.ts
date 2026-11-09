/**
 * opencode-purge — catalog packer.
 *
 * builder only; the CLI runner lives in scripts/pack.ts. Deterministic and
 * free of I/O beyond the catalog reads, so the manifest can be unit-tested:
 *
 *   entries   -> one item per prompt file, vendor/name/sha/size/content
 *   json      -> the single packed file: metadata block + entries, sorted
 *
 * Sorted orders and content hashes keep the output stable, so an unchanged
 * catalog repacks to a byte-identical file (the watch loop can skip writes).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { CatalogSource, type CatalogVendor } from "./catalog.ts";

export interface PackEntry {
  vendor: string;
  name: string;
  path: string;
  sha256: string;
  chars: number;
  content: string;
}

export interface Pack {
  meta: {
    source: string;
    version: string;
  };
  vendors: number;
  count: number;
  bytes: number;
  entries: PackEntry[];
}

/** Fence strong enough for any embedded prompt file: a content line that
 * starts with up to three spaces and N backticks can close a block of N
 * backticks (CommonMark), so the outer fence must exceed the longest such
 * fence. Tilde fences inside a backtick block are inert. */
function fenceFor(content: string): string {
  let length = 3;
  const fences = content.match(/^[ \t]{0,3}[`]{3,}|^[ \t]{0,3}[~]{3,}/gm) ?? [];
  for (const fence of fences) {
    if (fence.includes("`")) {
      const count = (fence.match(/`+$/)?.[0] ?? "").length;
      length = Math.max(length, count + 1);
    }
  }
  return "`".repeat(length);
}

function safeHeading(value: string): string {
  return value.replace(/#/g, "\\#").replace(/\|/g, "\\|").trim();
}

export function buildPack(root: string, options: { version?: string } = {}): Pack {
  const source = new CatalogSource(root);
  const vendors = source.refresh();
  const ordered = [...vendors].sort((a: CatalogVendor, b: CatalogVendor) =>
    a.name.localeCompare(b.name),
  );

  const entries: PackEntry[] = [];
  for (const vendor of ordered) {
    const files = [...vendor.files].sort((a, b) => a.name.localeCompare(b.name));
    for (const file of files) {
      // Hash exactly the bytes on disk: trimming would invalidate the SHA-256
      // and lose leading/trailing whitespace from the pack.
      const content = readFileSync(file.path, "utf8");
      entries.push({
        vendor: vendor.name,
        name: file.name,
        path: file.path,
        sha256: createHash("sha256").update(content).digest("hex"),
        chars: content.length,
        content,
      });
    }
  }

  const bytes = entries.reduce((sum, entry) => sum + entry.chars, 0);
  return {
    meta: {
      source: root,
      version: options.version ?? "1",
    },
    vendors: ordered.length,
    count: entries.length,
    bytes,
    entries,
  };
}

/** The whole folder inside one markdown document: header, table of contents,
 * then every prompt file fenced under a per-vendor/name heading. Deterministic
 * like the JSON pack — vendor order, file order, and fence width all derive
 * from the content itself. */
export function buildPackMarkdown(root: string, options: { version?: string } = {}): string {
  const pack = buildPack(root, options);
  const out: string[] = [
    "# Persona Catalog Pack",
    "",
    `Source: ${pack.meta.source} — ${pack.vendors} vendors, ${pack.count} files, ${pack.bytes.toLocaleString("en-US")} chars`,
    "",
    "| Vendor | File | Chars | SHA-256 |",
    "| --- | --- | ---: | --- |",
  ];
  for (const entry of pack.entries) {
    out.push(`| ${safeHeading(entry.vendor)} | ${safeHeading(entry.name)} | ${entry.chars.toLocaleString("en-US")} | \`${entry.sha256.slice(0, 12)}\` |`);
  }
  out.push("");
  let lastVendor = "";
  for (const entry of pack.entries) {
    if (entry.vendor !== lastVendor) {
      out.push(`## ${safeHeading(entry.vendor)}`, "");
      lastVendor = entry.vendor;
    }
    out.push(
      `### ${safeHeading(entry.name)}`,
      "",
      `\`${entry.path}\` — ${entry.chars.toLocaleString("en-US")} chars, sha256 \`${entry.sha256}\``,
      "",
      fenceFor(entry.content) + "markdown",
      entry.content,
      fenceFor(entry.content),
      "",
    );
  }
  return out.join("\n");
}
