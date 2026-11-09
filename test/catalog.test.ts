import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
mkdirSync(join("test", ".tmp-fixtures"), { recursive: true });
import {
  CatalogSource,
  loadCatalogConfigWithError,
  matchVendorWithFile,
  pickFile,
  scanCatalog,
  words,
  type CatalogVendor,
} from "../src/catalog.ts";

const CATALOG: CatalogVendor[] = [
  {
    name: "DeepSeek",
    path: "/catalog/DeepSeek",
    files: [
      { name: "deepseek v3.md", path: "/catalog/DeepSeek/v3.md", mtimeMs: 3 },
      { name: "deepseek v4.md", path: "/catalog/DeepSeek/v4.md", mtimeMs: 2 },
      { name: "deepseek-4-1.md", path: "/catalog/DeepSeek/4-1.md", mtimeMs: 1 },
    ],
  },
  {
    name: "Anthropic",
    path: "/catalog/Anthropic",
    files: [
      { name: "opus v1.md", path: "/catalog/Anthropic/opus.md", mtimeMs: 1 },
      { name: "sonnet v1.md", path: "/catalog/Anthropic/sonnet1.md", mtimeMs: 2 },
      { name: "Sonnet v2.md", path: "/catalog/Anthropic/sonnet2.md", mtimeMs: 3 },
    ],
  },
  {
    name: "OpenAI",
    path: "/catalog/OpenAI",
    files: [{ name: "gpt-oss-20b.md", path: "/catalog/OpenAI/gpt.md", mtimeMs: 1 }],
  },
  {
    name: "Moonshot AI",
    path: "/catalog/Moonshot AI",
    files: [
      { name: "kimi-k2.md", path: "/catalog/Moonshot AI/k2.md", mtimeMs: 1 },
      { name: "kimi-k3-agents.md", path: "/catalog/Moonshot AI/k3.md", mtimeMs: 2 },
    ],
  },
  {
    name: "Alibaba",
    path: "/catalog/Alibaba",
    files: [{ name: "qwen-3.7.md", path: "/catalog/Alibaba/qwen.md", mtimeMs: 1 }],
  },
  {
    name: "xAI",
    path: "/catalog/xAI",
    files: [
      { name: "Grok build.md", path: "/catalog/xAI/build.md", mtimeMs: 2 },
      { name: "grok-4.7.md", path: "/catalog/xAI/grok47.md", mtimeMs: 1 },
    ],
  },
  {
    name: "Google",
    path: "/catalog/Google",
    files: [
      { name: "Gemini-4-Argon.md", path: "/catalog/Google/gemini4.md", mtimeMs: 2 },
      { name: "gemma4.md", path: "/catalog/Google/gemma4.md", mtimeMs: 1 },
    ],
  },
  {
    name: "raghavraut",
    path: "/catalog/raghavraut",
    files: [{ name: "gemini-3.1-pro.md", path: "/catalog/raghavraut/gemini.md", mtimeMs: 1 }],
  },
  {
    name: "Zhipu AI",
    path: "/catalog/Zhipu AI",
    files: [
      { name: "glm-5-3-flash.md", path: "/catalog/Zhipu AI/glm53.md", mtimeMs: 1 },
      { name: "glm-5.2.md", path: "/catalog/Zhipu AI/glm52.md", mtimeMs: 2 },
    ],
  },
  {
    name: "Stealth Models",
    path: "/catalog/Stealth Models",
    files: [{ name: "spacebunny-agents.md", path: "/catalog/Stealth Models/sb.md", mtimeMs: 1 }],
  },
];

const model = (providerID: string, id: string, variant?: string) => ({ providerID, id, variant });

test("words lowercases, splits, and strips a leading version v", () => {
  assert.deepEqual(words("DeepSeek-v4.1 Flash"), ["deepseek", "4", "1", "flash"]);
  assert.deepEqual(words("Zhipu AI / GLM-5"), ["zhipu", "ai", "glm", "5"]);
});

test("catalog.json can pin exact model refs for every session", () => {
  const dir = mkdtempSync(join("test", ".tmp-fixtures", "catalog-json-"));
  try {
    mkdirSync(join(dir, "Alpha"), { recursive: true });
    writeFileSync(join(dir, "Alpha", "a-v1.md"), "ALPHA ONE");
    writeFileSync(
      join(dir, "catalog.json"),
      JSON.stringify({ models: { "myprov/never-heard-of-it": "Alpha/a-v1.md" } }),
    );
    const source = new CatalogSource(dir);
    const hit = source.resolve(model("myprov", "never-heard-of-it"));
    assert.equal(hit?.vendor.name, "Alpha");
    assert.equal(hit?.file.name, "a-v1.md");

    // Absent refs remain unmatched; pins are exact, not prefixes.
    assert.equal(source.resolve(model("myprov", "never-heard-of-it-2")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid catalog.json is reported, not silently ignored", () => {
  const dir = mkdtempSync(join("test", ".tmp-fixtures", "catalog-json-bad-"));
  try {
    writeFileSync(join(dir, "catalog.json"), "{ not json");
    const loaded = loadCatalogConfigWithError(dir);
    assert.ok(loaded.error, "expected a parse error");
    assert.deepEqual(loaded.config.models, {}); // built-ins only
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catalog.json accepts unique bare-file pins and rejects ambiguous ones", () => {
  const dir = mkdtempSync(join("test", ".tmp-fixtures", "catalog-json-bare-"));
  try {
    mkdirSync(join(dir, "Alpha"), { recursive: true });
    mkdirSync(join(dir, "Beta"), { recursive: true });
    writeFileSync(join(dir, "Alpha", "shared.md"), "A");
    writeFileSync(join(dir, "Beta", "shared.md"), "B");

    writeFileSync(join(dir, "catalog.json"), JSON.stringify({ models: { "p/bare": "shared.md" } }));
    // "shared.md" exists twice: the pin is ambiguous and must not resolve.
    assert.equal(new CatalogSource(dir).resolve(model("p", "bare")), null);

    writeFileSync(join(dir, "catalog.json"), JSON.stringify({ models: { "p/bare": "Alpha/shared.md" } }));
    const hit = new CatalogSource(dir).resolve(model("p", "bare"));
    assert.equal(hit?.vendor.name, "Alpha");
    assert.equal(hit?.file.name, "shared.md");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catalog.json multi-word modelAliases match token-wise", () => {
  const dir = mkdtempSync(join("test", ".tmp-fixtures", "catalog-json-alias-"));
  try {
    mkdirSync(join(dir, "Alpha"), { recursive: true });
    writeFileSync(join(dir, "Alpha", "beta-oss.md"), "ALPHA");
    writeFileSync(
      join(dir, "catalog.json"),
      JSON.stringify({ modelAliases: { alpha: ["Beta-OSS"] } }),
    );
    const hit = new CatalogSource(dir).resolve(model("weird-provider", "beta-oss-1"));
    assert.equal(hit?.vendor.name, "Alpha");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catalog.json edits apply on refresh without a restart", () => {
  const dir = mkdtempSync(join("test", ".tmp-fixtures", "catalog-json-reload-"));
  try {
    mkdirSync(join(dir, "Alpha"), { recursive: true });
    writeFileSync(join(dir, "Alpha", "model.md"), "ALPHA");
    const source = new CatalogSource(dir);
    assert.equal(source.resolve(model("p", "fresh")), null);

    writeFileSync(join(dir, "catalog.json"), JSON.stringify({ models: { "p/fresh": "Alpha/model.md" } }));
    source.refresh();
    assert.equal(source.resolve(model("p", "fresh"))?.vendor.name, "Alpha");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vendor matching follows provider and model names", () => {
  const cases: Array<[string, string, string]> = [
    ["opencode", "deepseek-v4.1-flash-free", "DeepSeek"],
    ["anthropic", "claude-sonnet-4", "Anthropic"],
    ["openai", "gpt-5", "OpenAI"],
    ["moonshotai", "kimi-k2", "Moonshot AI"],
    ["alibaba", "qwen-3.7", "Alibaba"],
    ["xai", "grok-4", "xAI"],
    ["zhipuai", "glm-5", "Zhipu AI"],
    ["glm-gateway", "glm-5.3", "Zhipu AI"],
    ["google", "gemini-3.1-pro", "raghavraut"],
    ["spacebunny", "agents", "Stealth Models"],
  ];
  for (const [providerID, id, expected] of cases) {
    assert.equal(matchVendorWithFile(CATALOG, model(providerID, id))?.vendor.name, expected, `${providerID}/${id}`);
  }
  assert.equal(matchVendorWithFile(CATALOG, model("unknown", "mystery")), null);
});

test("file selection prefers the closest version, then the newest", () => {
  const deepseek = CATALOG[0];
  assert.ok(deepseek);
  assert.equal(
    pickFile(deepseek.files, model("opencode", "deepseek-v4.1-flash"))?.name,
    "deepseek-4-1.md",
  );
  assert.equal(
    pickFile(deepseek.files, model("opencode", "deepseek-v3"))?.name,
    "deepseek v3.md",
  );

  const anthropic = CATALOG[1];
  assert.ok(anthropic);
  assert.equal(
    pickFile(anthropic.files, model("anthropic", "claude-sonnet-4"))?.name,
    "Sonnet v2.md",
  );

  const zhipu = CATALOG.find((vendor) => vendor.name === "Zhipu AI");
  assert.ok(zhipu);
  assert.equal(
    pickFile(zhipu.files, model("glm-gateway", "glm-5.3", "default"))?.name,
    "glm-5-3-flash.md",
  );

  // Nothing matches: newest wins unless disabled (versionless model only).
  assert.equal(
    pickFile(deepseek.files, model("x", "nothing"))?.name,
    "deepseek v3.md",
  );
  assert.equal(pickFile(deepseek.files, model("x", "nothing"), false), null);
});

test("compact file names match delimited model ids through their squashed form", () => {
  const moonshot: CatalogVendor = {
    name: "Moonshot AI",
    path: "/catalog/Moonshot AI",
    files: [
      { name: "kimi-k2.md", path: "/catalog/Moonshot AI/k2.md", mtimeMs: 1 },
      { name: "kimi-k3-agents.md", path: "/catalog/Moonshot AI/k3.md", mtimeMs: 2 },
      { name: "kimik3.1.md", path: "/catalog/Moonshot AI/k31.md", mtimeMs: 3 },
    ],
  };
  assert.equal(
    pickFile(moonshot.files, model("moonshotai", "kimi-k3.1"))?.name,
    "kimik3.1.md",
  );

  // The exact name outranks a token-rich variant even when coverage favors it.
  const zhipu: CatalogVendor = {
    name: "Zhipu AI",
    path: "/catalog/Zhipu AI",
    files: [
      { name: "glm-5.2.md", path: "/catalog/Zhipu AI/glm52.md", mtimeMs: 1 },
      { name: "glm-zcode-5.2.md", path: "/catalog/Zhipu AI/zcode52.md", mtimeMs: 2 },
    ],
  };
  assert.equal(pickFile(zhipu.files, model("zhipu", "glm-5.2"))?.name, "glm-5.2.md");
});

test("generic words no longer carry vendor identity", () => {
  // "models"/"model"/"router"/"agent" are structural, not vendor identity:
  // an unmatched model id must reach the none-fallback, not the folder
  // that merely contains a generic word.
  assert.equal(matchVendorWithFile(CATALOG, model("anything", "some-model-router")), null);
  assert.equal(matchVendorWithFile(CATALOG, model("anything", "fine-model")), null);
  assert.equal(matchVendorWithFile(CATALOG, model("anything", "zzz-foo")), null);
});

test("vendor ties are broken by the best version-compatible file", () => {
  // "google" and "raghavraut" both carry the "gemini" identity word; the
  // folder that actually contains the matching file must win so that a
  // gemini-3.1 model resolves to a 3.1 persona, not the v4 file in Google.
  const ref = model("google", "gemini-3.1-pro");
  assert.equal(pickFile(CATALOG.find((v) => v.name === "Google")!.files, ref, false)?.name, "Gemini-4-Argon.md");

  const resolved = matchVendorWithFile(CATALOG, ref);
  assert.equal(resolved?.vendor.name, "raghavraut");
  assert.equal(resolved?.file.name, "gemini-3.1-pro.md");
});

test("CatalogSource resolves both vendor and file", () => {
  const source = new CatalogSource("/nonexistent");
  assert.equal(source.resolve(model("opencode", "deepseek-v4")), null);

  // Use the real catalog when available.
  const root = process.env.PERSONA_REPO?.trim();
  if (!root) return;
  const real = new CatalogSource(root);
  const resolve = (providerID: string, id: string) => real.resolve(model(providerID, id));

  assert.equal(resolve("opencode", "deepseek-v4.1-flash-free")?.vendor.name, "DeepSeek");
  assert.equal(resolve("anthropic", "claude-sonnet-4")?.vendor.name, "Anthropic");
  assert.equal(resolve("openai", "gpt-5")?.vendor.name, "OpenAI");
  assert.equal(resolve("moonshotai", "kimi-k2")?.vendor.name, "Moonshot AI");
  assert.equal(resolve("alibaba", "qwen-3.7")?.vendor.name, "Alibaba");
  assert.equal(resolve("xai", "grok-4")?.vendor.name, "xAI");
  assert.equal(resolve("zhipuai", "glm-5")?.vendor.name, "Zhipu AI");
  assert.equal(resolve("unknown", "mystery"), null);
});

test("scanCatalog sees the real repository layout", { skip: !process.env.PERSONA_REPO }, () => {
  const root = process.env.PERSONA_REPO!.trim();
  // README.md is deliberately stripped by update-md; presence of vendor
  // folders is the actual layout contract.
  assert.ok(existsSync(root), "PERSONA_REPO should point at the clone root");
  const vendors = scanCatalog(root);
  assert.ok(vendors.length >= 15, `expected vendor folders, got ${vendors.length}`);
  const files = vendors.reduce((count, vendor) => count + vendor.files.length, 0);
  assert.ok(files >= 40, `expected prompt files, got ${files}`);
  assert.ok(vendors.some((vendor) => vendor.name === "Stealth Models"));
  assert.ok(vendors.every((vendor) => vendor.files.every((file) => /\.(md|txt)$/i.test(file.name))));
});
