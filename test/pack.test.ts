import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildPack, buildPackMarkdown } from "../src/pack.ts";

function catalogDir(): string {
  const dir = join(MODULE_TMP, "pack-fixture");
  rmSync(dir, { recursive: true, force: true });
  for (const [vendor, [file, content]] of [
    ["Alpha", ["a-v2.md", "alpha v2\ncontent"]],
    ["Alpha", ["a-v1.md", "alpha v1"]],
    ["Beta", ["b.txt", "beta"]],
  ] as Array<[string, [string, string]]>) {
    mkdirSync(join(dir, vendor), { recursive: true });
    writeFileSync(join(dir, vendor, file), content);
  }
  return dir;
}

const MODULE_TMP = join("test", ".tmp-fixtures");

test("buildPack packs every file into one deterministic manifest", () => {
  const dir = catalogDir();
  try {
    const pack = buildPack(dir);
    assert.equal(pack.vendors, 2);
    assert.equal(pack.count, 3);
    assert.deepEqual(pack.entries.map((entry) => `${entry.vendor}/${entry.name}`), [
      "Alpha/a-v1.md",
      "Alpha/a-v2.md",
      "Beta/b.txt",
    ]);
    assert.equal(pack.entries[1]!.content, "alpha v2\ncontent");
    assert.match(pack.entries[2]!.sha256, /^[0-9a-f]{64}$/);
    assert.equal(pack.bytes, pack.entries.reduce((sum, entry) => sum + entry.chars, 0));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildPack output is byte-stable for an unchanged catalog", () => {
  const dir = catalogDir();
  try {
    const first = buildPack(dir);
    const second = buildPack(dir);
    assert.deepEqual(first, second);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildPackMarkdown embeds the whole folder in one file", () => {
  const dir = catalogDir();
  try {
    const md = buildPackMarkdown(dir);
    assert.match(md, /^# Persona Catalog Pack$/m);
    assert.ok(md.includes("| Vendor | File | Chars | SHA-256 |"));
    for (const heading of ["## Alpha", "## Beta", "### a-v1.md", "### a-v2.md", "### b.txt"]) {
      assert.ok(md.includes(heading), heading);
    }
    assert.ok(md.includes("alpha v1"));
    assert.ok(md.includes(`sha256 `));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("embedded prompt files keep their fences unbroken", () => {
  const dir = join("test", ".tmp-fixtures", "pack-fence");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "Alpha"), { recursive: true });
  const tricky =
    "# prompt with code block\n\n```markdown\n```json\n{}```\n```\n\n   ```\n   indented fence, still block-level\n   ```\n\ntext ~~~ fence";
  writeFileSync(join(dir, "Alpha", "tricky.md"), tricky);
  try {
    const md = buildPackMarkdown(dir);
    // The outer fence must be longer than any backtick fence inside the content.
    const start = md.indexOf("```markdown\n# prompt with code block");
    assert.notEqual(start, -1);
    const closing = md.slice(start).indexOf("\n````");
    assert.notEqual(closing, -1);
    assert.ok(md.includes("text ~~~ fence"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
