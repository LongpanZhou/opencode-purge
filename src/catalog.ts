/**
 * opencode-purge — persona catalog matching.
 *
 * A catalog is a directory of vendor folders (DeepSeek, Anthropic, OpenAI, ...)
 * each containing prompt files. Given the model ref OpenCode reports for a
 * request, we pick the vendor folder and the closest file inside it.
 *
 * Everything here is deterministic and file-system-light so it can be tested
 * with a synthetic catalog.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";

export interface ModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

export interface CatalogFile {
  name: string;
  path: string;
  mtimeMs: number;
}

export interface CatalogVendor {
  name: string;
  path: string;
  files: CatalogFile[];
}

export interface CatalogMatch {
  vendor: CatalogVendor;
  file: CatalogFile;
}

const TEXT_FILE = /\.(md|txt)$/i;

/** Filler words that should not count against a file name. */
const STOP_WORDS = new Set(["a", "an", "and", "for", "of", "the", "with"]);

/** Structural words that carry no vendor identity; a vendor folder whose only
 * shared word is generic would otherwise absorb unrelated model refs. */
const GENERIC_WORDS = new Set(["agent", "agents", "model", "models", "router", "assistant", "prompt", "prompts", "config", "preferences", "v2", "preview"]);

/**
 * Model/provider words that identify a vendor. The key is the vendor identity,
 * not necessarily the directory name; directory names are matched separately.
 */
const MODEL_ALIASES: Record<string, readonly string[]> = {
  deepseek: ["deepseek", "deepseekai", "deepseek-ai"],
  openai: ["openai", "gpt", "chatgpt", "codex", "o1", "o3", "o4"],
  anthropic: ["anthropic", "claude", "sonnet", "opus", "haiku"],
  google: ["google", "gemini", "gemma", "vertex", "bard"],
  meta: ["meta", "llama", "muse"],
  mistral: ["mistral", "mixtral", "codestral", "magistral"],
  moonshot: ["moonshot", "moonshotai", "kimi"],
  alibaba: ["alibaba", "qwen", "tongyi", "dashscope"],
  xai: ["xai", "grok"],
  zhipu: ["zhipu", "zhipuai", "glm", "chatglm", "bigmodel"],
  tencent: ["tencent", "hunyuan", "hy4"],
  meituan: ["meituan", "longcat"],
  xiaomi: ["xiaomi", "mimo"],
  stepfun: ["stepfun", "step"],
  nvidia: ["nvidia", "nemotron"],
};

/**
 * Extra words for directories whose names are author handles or collections
 * rather than vendor names. These come from the shape of a prompt catalog, not
 * from any single model.
 */
const DIR_ALIASES: Record<string, readonly string[]> = {
  "0x8d jailbreaks": ["bigpickle", "big-pickle", "big pickle"],
  "darkyharrry": ["jaibreak", "jailbreak-master", "jailbreak"],
  "modemnakata": ["nemotron"],
  "raghavraut": ["gemini"],
  "stealth models": ["spacebunny", "beam", "crouton", "unified"],
};

export function words(value: string): string[] {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((word) => word.replace(/^v(?=\d)/, ""));
}

/** Vendor identity must not hinge on a shared version digit. */
function identityWord(word: string): boolean {
  return word.length >= 3 && !/^\d+$/.test(word);
}

/** All identity words for a model ref. */
export function modelWords(model: ModelRef, config = BUILTIN_CONFIG): string[] {
  const out = new Set<string>(
    words(`${model.providerID} ${model.id} ${model.variant ?? ""}`),
  );
  for (const [key, aliases] of Object.entries(config.modelAliases)) {
    // Alias values may be multi-word ("gpt-oss"); compare token-wise.
    const aliasWords = aliases.flatMap(words);
    if (aliasWords.some((alias) => out.has(alias))) {
      out.add(key);
    }
  }
  return [...out];
}

function vendorWords(vendor: CatalogVendor, config: CatalogConfigData): string[] {
  const key = vendor.name.toLowerCase();
  return [
    ...words(vendor.name),
    ...(config.dirAliases[key] ?? []).flatMap(words),
  ].filter((word) => !config.generics.includes(word));
}

export function scoreVendor(
  vendor: CatalogVendor,
  model: ModelRef,
  config = BUILTIN_CONFIG,
): number {
  const modelSet = modelWords(model, config);
  let score = 0;
  for (const vendorWord of vendorWords(vendor, config)) {
    if (!identityWord(vendorWord)) continue;
    for (const modelWord of modelSet) {
      if (!identityWord(modelWord)) continue;
      if (vendorWord === modelWord) score = Math.max(score, 10);
    }
  }
  return score;
}

/** Score a file name against the model id. Coverage matters more than the raw
 * number of hits: a long name with repeated version fragments must not beat a
 * compact exact match like `deepseek-4-1` for `deepseek-v4.1`. The squashed
 * forms pair compact names ("kimik3.1") with delimited ids ("kimi-k3.1"). */
function squash(value: string): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function scoreFile(file: CatalogFile, model: ModelRef): number {
  const modelSet = words(`${model.id} ${model.variant ?? ""}`);
  const fileBase = basename(file.name, extname(file.name));
  const fileSet = [...new Set(words(fileBase))];
  if (modelSet.length === 0 || fileSet.length === 0) return 0;

  // Compact-vs-delimited pairs tokenize differently ("kimik3.1" vs
  // "kimi-k3.1"); identical squashed names are a full-coverage match.
  if (squash(fileBase) === squash(model.id) || squash(fileBase) === squash(`${model.id}${model.variant ?? ""}`)) {
    return 100;
  }

  const used = new Set<string>();
  let matched = 0;
  for (const modelWord of [...new Set(modelSet)]) {
    let best = 0;
    let usedWord = "";
    for (const fileWord of fileSet) {
      if (fileWord === modelWord) {
        best = 1;
        usedWord = fileWord;
        break;
      }
    }
    if (best > 0) {
      matched += best;
      used.add(usedWord);
    }
  }

  const extra = fileSet.filter((word) => !used.has(word) && !STOP_WORDS.has(word)).length;
  const coverage = matched / new Set(modelSet).size;
  return Math.round(coverage * 100 + matched * 5 - extra * 3);
}

function versionOf(name: string): number[] {
  const first = basename(name, extname(name)).toLowerCase().match(/\d+(?:[.-]\d+)*/)?.[0];
  if (!first) return []; // Number("") is 0, not NaN, so an empty match must short-circuit.
  return first
    .split(/[.-]/)
    .map((part) => Number(part))
    .filter((part) => Number.isFinite(part));
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) return left - right;
  }
  return 0;
}

/** Best version-compatible file for a model, or null when every candidate
 * contradicts the version the model declared. A model that names a version
 * must never receive a persona for a different major (a v4 prompt injected
 * for a 3.1 model reads as a successful match but serves the wrong spec). */
function gatedScored(files: readonly CatalogFile[], model: ModelRef, allowNewest: boolean): Array<{ file: CatalogFile; score: number }> {
  const scored = files
    .map((file) => ({ file, score: scoreFile(file, model) }))
    .filter((entry) => entry.score > 0);

  // An exact (squashed) name match is the identity answer: "glm-5.2" must
  // beat "glm-zcode-5.2" for a plain glm-5.2 model, and "kimik3.1" must beat
  // the token-rich "-agents" variant.
  const modelSquashes = [squash(model.id), squash(`${model.id}${model.variant ?? ""}`)];
  const exact = scored.filter((entry) =>
    modelSquashes.includes(squash(basename(entry.file.name, extname(entry.file.name)))),
  );
  if (exact.length > 0) return exact;

  const modelVersion = versionOf(model.id);
  if (modelVersion.length > 0) {
    const compatible = scored.filter(
      (entry) => versionOf(entry.file.name)[0] === modelVersion[0],
    );
    // Prefer a matching major, but never veto the folder: persona revision
    // numbers ("Sonnet v2") legitimately trail model majors ("claude-sonnet-4").
    if (compatible.length > 0) return compatible;
    return scored.length > 0 ? scored : [];
  }

  if (scored.length === 0 && allowNewest) {
    const newest = [...files].sort(
      (a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name),
    )[0];
    return newest ? [{ file: newest, score: 0 }] : [];
  }
  return scored;
}

/**
 * Pick the closest file for the model. Ties are deterministic: a higher
 * version in the file name wins, then the simpler name, then lexical order.
 * The newest file is only used when the model carries no version at all and
 * nothing scores.
 */
export function pickFile(
  files: readonly CatalogFile[],
  model: ModelRef,
  allowNewest = true,
): CatalogFile | null {
  if (files.length === 0) return null;

  const entries = gatedScored(files, model, allowNewest);
  if (entries.length === 0) return null;

  const bestScore = Math.max(...entries.map((entry) => entry.score));

  return (
    entries
      .filter((entry) => entry.score === bestScore)
      .map((entry) => entry.file)
      .sort(
        (a, b) =>
          compareVersions(versionOf(b.name), versionOf(a.name)) ||
          a.name.length - b.name.length ||
          a.name.localeCompare(b.name) ||
          b.mtimeMs - a.mtimeMs,
      )[0] ?? null
  );
}

/**
 * Vendor scoring alone can tie (two folders sharing a "gemini" alias word),
 * so the winner is decided by its best version-compatible file. An unmatched
 * vendor is only returned when folder identity scored, and the file gate can
 * still veto it (a matched vendor whose files all contradict the model's
 * version yields null, letting the `none` fallback keep the stock prompt).
 */
export function matchVendorWithFile(
  vendors: readonly CatalogVendor[],
  model: ModelRef,
  config = BUILTIN_CONFIG,
): CatalogMatch | null {
  let bestVendor: CatalogVendor | null = null;
  let bestVendorScore = 0;
  let bestFile: CatalogFile | null = null;
  let bestFileScore = -1;

  for (const vendor of vendors) {
    const score = scoreVendor(vendor, model, config);
    if (score < bestVendorScore) continue;
    const best = pickFile(vendor.files, model, false);
    const fileScore = best ? scoreFile(best, model) : -1;
    if (score > bestVendorScore || (score === bestVendorScore && fileScore > bestFileScore)) {
      bestVendor = vendor;
      bestVendorScore = score;
      bestFile = best;
      bestFileScore = fileScore;
    }
  }

  if (!bestVendor || bestVendorScore <= 0 || !bestFile) return null;
  return { vendor: bestVendor, file: bestFile };
}

/** Built-in identity vocabularies extendable per catalog by catalog.json:
 * alias arrays append, generics append, and `models` pins exact model refs
 * straight to a vendor/file pair ahead of any scoring. */
export interface CatalogConfigData {
  modelAliases: Record<string, string[]>;
  dirAliases: Record<string, string[]>;
  generics: string[];
  models: Record<string, string>;
}

const BUILTIN_CONFIG: CatalogConfigData = {
  modelAliases: MODEL_ALIASES as Record<string, string[]>,
  dirAliases: DIR_ALIASES as Record<string, string[]>,
  generics: [...GENERIC_WORDS],
  models: {},
};

/** Read <root>/catalog.json when present; user values append (never replace)
 * the built-ins, so a partial file cannot silence derived vendor keys.
 * Parse failures are surfaced through the second tuple member instead of
 * being silently treated as "no file". */
export function loadCatalogConfigWithError(root: string): { config: CatalogConfigData; error: string | null } {
  if (!root) return { config: BUILTIN_CONFIG, error: null };
  let raw: string;
  try {
    raw = readFileSync(join(root, "catalog.json"), "utf8");
  } catch {
    return { config: BUILTIN_CONFIG, error: null }; // absent: built-ins only
  }
  try {
    const user = JSON.parse(raw) as Partial<CatalogConfigData> | null;
    const modelAliases: Record<string, string[]> = { ...BUILTIN_CONFIG.modelAliases };
    const dirAliases: Record<string, string[]> = { ...BUILTIN_CONFIG.dirAliases };
    const generics = [...BUILTIN_CONFIG.generics];
    const models: Record<string, string> = { ...BUILTIN_CONFIG.models };
    if (user) {
      for (const [key, aliases] of Object.entries(user.modelAliases ?? {})) {
        if (typeof key === "string" && Array.isArray(aliases)) {
          const vendorKey = key.toLowerCase();
          const added = aliases.filter((a) => typeof a === "string").map((a) => a.toLowerCase());
          modelAliases[vendorKey] = [...new Set([...(modelAliases[vendorKey] ?? []), ...added])];
        }
      }
      for (const [dir, aliases] of Object.entries(user.dirAliases ?? {})) {
        if (typeof dir === "string" && Array.isArray(aliases)) {
          const dirKey = dir.toLowerCase();
          const added = aliases.filter((a) => typeof a === "string").map((a) => a.toLowerCase());
          dirAliases[dirKey] = [...new Set([...(dirAliases[dirKey] ?? []), ...added])];
        }
      }
      for (const generic of user.generics ?? []) {
        if (typeof generic === "string" && generic.length > 0) generics.push(generic.toLowerCase());
      }
      for (const [modelKey, target] of Object.entries(user.models ?? {})) {
        // Targets may be "Vendor/file.md" or a unique bare "file.md".
        if (typeof modelKey === "string" && typeof target === "string" && target.trim().length > 0) {
          models[modelKey.toLowerCase()] = target.trim();
        }
      }
    }
    return { config: { modelAliases, dirAliases, generics, models }, error: null };
  } catch (error) {
    return { config: BUILTIN_CONFIG, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Scan a catalog directory. Hidden directories and nested folders are skipped. */
export function scanCatalog(root: string): CatalogVendor[] {
  if (!root || !existsSync(root)) return [];

  const vendors: CatalogVendor[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const directory = join(root, entry.name);
    try {
      const files: CatalogFile[] = [];
      for (const child of readdirSync(directory, { withFileTypes: true })) {
        if (!child.isFile() || !TEXT_FILE.test(child.name)) continue;
        const path = join(directory, child.name);
        try {
          files.push({ name: child.name, path, mtimeMs: statSync(path).mtimeMs });
        } catch {
          // A file vanishing mid-scan must not abort the whole catalog.
        }
      }
      if (files.length > 0) vendors.push({ name: entry.name, path: directory, files });
    } catch {
      // An unreadable vendor folder is skipped, not fatal.
    }
  }
  return vendors;
}

/** Catalog cache: rescans at most every 10 seconds; catalog.json is read once
 * per instance. Resolution fast paths, in order: the `models` pin map (one
 * object lookup), a per-instance resolve cache (positive results; cleared by
 * refresh), then an inverted alias index built during the scan, and only as a
 * last resort the full scorer. */
export class CatalogSource {
  private loadedAt = 0;
  private vendors: CatalogVendor[] = [];
  private config: CatalogConfigData = BUILTIN_CONFIG;
  private configError: string | null = null;
  private aliasIndex = new Map<string, CatalogVendor[]>();
  private readonly resolveCache = new Map<string, CatalogMatch>();

  constructor(readonly root: string) {
    this.reloadConfig();
  }

  /** Re-read catalog.json (edits apply on the next refresh, no restart). */
  private reloadConfig(): void {
    const loaded = loadCatalogConfigWithError(this.root);
    this.config = loaded.config;
    if (loaded.error && loaded.error !== this.configError) {
      console.warn(`[opencode-purge] invalid catalog.json in ${this.root}: ${loaded.error} (built-ins only)`);
    }
    this.configError = loaded.error;
  }

  list(): CatalogVendor[] {
    if (Date.now() - this.loadedAt > 10_000) this.refresh();
    return this.vendors;
  }

  refresh(): CatalogVendor[] {
    this.reloadConfig();
    this.vendors = scanCatalog(this.root);
    this.loadedAt = Date.now();
    this.aliasIndex = new Map();
    for (const vendor of this.vendors) {
      for (const word of new Set(vendorWords(vendor, this.config))) {
        const bucket = this.aliasIndex.get(word);
        if (bucket) bucket.push(vendor);
        else this.aliasIndex.set(word, [vendor]);
      }
    }
    this.resolveCache.clear();
    return this.vendors;
  }

  /** Pinned matches: `provider/id#variant`, then `provider/id`, then bare `id`,
   * each resolved to a vendor/file pair; a bare file name must be unique. */
  private pinned(model: ModelRef): CatalogMatch | null {
    const keys = [
      `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`,
      `${model.providerID}/${model.id}`,
      model.id,
    ];
    for (const key of keys) {
      const value = this.config.models[key.toLowerCase()];
      if (!value) continue;
      const slash = value.indexOf("/");
      const namedVendor = slash >= 0 ? value.slice(0, slash) : null;
      const fileName = slash >= 0 ? value.slice(slash + 1) : value;
      const matches: CatalogMatch[] = [];
      for (const vendor of this.vendors) {
        if (namedVendor && vendor.name.toLowerCase() !== namedVendor.toLowerCase()) continue;
        for (const file of vendor.files) {
          if (file.name.toLowerCase() === fileName.toLowerCase()) matches.push({ vendor, file });
        }
      }
      if (matches.length === 1) return matches[0]!;
    }
    return null;
  }

  /** Index candidates by the vendor identity words present in the model ref;
   * scoring then runs over that shortlist instead of every folder. */
  private indexed(model: ModelRef): CatalogMatch | null {
    const seen = new Set<CatalogVendor>();
    let bestVendor: CatalogVendor | null = null;
    let bestFile: CatalogFile | null = null;
    let bestScore = -1;
    for (const word of modelWords(model, this.config)) {
      for (const vendor of this.aliasIndex.get(word) ?? []) {
        if (seen.has(vendor)) continue;
        seen.add(vendor);
        const file = pickFile(vendor.files, model, false);
        const score = file ? scoreFile(file, model) : -1;
        if (score > bestScore) {
          bestVendor = vendor;
          bestFile = file;
          bestScore = score;
        }
      }
    }
    if (!bestVendor || !bestFile || bestScore <= 0) return null;
    return { vendor: bestVendor, file: bestFile };
  }

  resolve(model: ModelRef): CatalogMatch | null {
    const key = `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`.toLowerCase();
    const hit = this.resolveCache.get(key);
    if (hit) return hit;

    // Ensure a scan before consulting pins/index — both read this.vendors.
    const vendors = this.list();
    const viaPins = this.pinned(model);
    const match = viaPins ?? this.indexed(model) ?? matchVendorWithFile(vendors, model, this.config);
    if (match) this.resolveCache.set(key, match);
    return match;
  }
}
