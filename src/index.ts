/**
 * opencode-purge — a V2-only OpenCode plugin.
 *
 * Port of pi-purge's mechanism to OpenCode's supported plugin seam:
 * `ctx.session.hook("context")` hands us the assembled system parts right
 * before model dispatch, so we can replace them without touching the
 * executable, the install, or any file on disk.
 *
 * Scope is the session. Nothing is persisted: OpenCode restarting or the
 * plugin reloading returns every session to stock behaviour.
 *
 * Additions beyond pi-purge:
 *  - `source: "auto"` matches the active model to a file in a persona catalog,
 *    with `autoPull` git sync and a data-driven `catalog.json` lookup table.
 *  - `autoApplyOnStart` arms sessions without `/purge:on` (dsh-style).
 *  - `injectFile` appends mandatory operator directives as the last system
 *    part on every rewritten request (dsh file layer).
 *  - `/purge sandbox` caps tool permissions per session; tighten-only.
 *  - `/purge update-md` / `bun run pack` build the single-file catalog pack.
 *  - Status goes to a file always, and to chat when `notify` is on.
 */

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Plugin } from "@opencode/plugin";
import {
  CatalogSource,
  type CatalogFile,
  type ModelRef,
} from "./catalog.ts";
import {
  DEFAULT_PERSONA,
  EMBEDDED,
  EMPTY_CUT,
  composeSystem,
  isMode,
  normalizeCwd,
  parseCommand,
  type CutReport,
  type Mode,
} from "./purge.ts";
import { PersonaRepo, type RepoStatus } from "./repo.ts";
import { buildPack, buildPackMarkdown } from "./pack.ts";
import {
  isEffect,
  isSandboxProfile,
  sandboxDecision,
  sandboxLabel,
  tighten,
  type SandboxProfile,
} from "./sandbox.ts";

// NOTE: strip the trailing separator instead of dirname() — on Windows,
// dirname("…/opencode-purge/") returns the PARENT ("C:\Users\27175").
const PLUGIN_ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]+$/, "");
// Self-contained: the status channel lives inside the project unless the
// operator points it elsewhere (option or env).
const DEFAULT_STATUS_FILE =
  process.env.OPENCODE_PURGE_STATUS_FILE?.trim() ||
  join(PLUGIN_ROOT, ".state", "purge-status.txt");
const ENV_SOURCE = process.env.OPENCODE_PURGE_SOURCE?.trim() || "";

/** Option paths may be absolute or relative to the plugin root, so the whole
 * setup can live inside the project checkout. */
function resolveOptionPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return isAbsolute(trimmed) ? trimmed : join(PLUGIN_ROOT, trimmed);
}

/** True when `path` is the plugin checkout or inside it (case-insensitive on
 * Windows; harmless elsewhere). */
function isInsidePlugin(path: string): boolean {
  const root = PLUGIN_ROOT.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const target = path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return target === root || target.startsWith(`${root}/`);
}

/** Destructive cleanup (README strip) is limited to managed locations: the
 * plugin checkout and conventional `prompts` catalog folders. */
function isManagedCatalog(path: string): boolean {
  return isInsidePlugin(path) || basename(path).toLowerCase() === "prompts";
}

interface HostSnapshot {
  parts: number;
  bytes: number;
}

interface PersonaMatch {
  text: string;
  label: string;
  chars: number;
}

interface PurgeState {
  enabled: boolean;
  mode: Mode;
  source: string;
  body: string;
  loadError: string;
  cwd: string;
  sandbox: SandboxProfile;
  lastCut: CutReport;
  lastHost: HostSnapshot | null;
  lastPersona: PersonaMatch | null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDirectory(path: string): boolean {
  try {
    return path.length > 0 && existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function createState(
  initialMode: Mode,
  initialSource: string,
  cwd: string,
  initialSandbox: SandboxProfile,
): PurgeState {
  return {
    enabled: false,
    mode: initialMode,
    source: initialSource,
    body: "",
    loadError: "",
    cwd,
    sandbox: initialSandbox,
    lastCut: { ...EMPTY_CUT },
    lastHost: null,
    lastPersona: null,
  };
}

/** Read the experimental instruction-source list for `/purge status`. */
function instructionKeys(parts: readonly { metadata?: Record<string, unknown> }[]): string[] {
  const keys = new Set<string>();
  for (const part of parts) {
    const experimental = part.metadata?.experimental;
    if (!experimental || typeof experimental !== "object") continue;
    const instructions = (experimental as { instructions?: unknown }).instructions;
    if (!Array.isArray(instructions)) continue;
    for (const item of instructions) {
      if (item && typeof item === "object" && typeof (item as { key?: unknown }).key === "string") {
        keys.add((item as { key: string }).key);
      }
    }
  }
  return [...keys];
}

function snapshot(
  parts: readonly { type: "text"; text: string }[],
): HostSnapshot {
  let bytes = 0;
  for (const part of parts) bytes += part.text.length;
  return { parts: parts.length, bytes };
}

function modeLabel(mode: Mode): string {
  switch (mode) {
    case "strict":
      return "persona + cwd only";
    case "replace":
      return "persona + trimmed host";
    case "append":
      return "persona + full host";
  }
}

function describeCut(cut: CutReport): string {
  if (cut.at === 0) return "no rewrite yet";
  return `${cut.identity ? "identity cut" : "identity kept"} / ${cut.docs ? "docs cut" : "docs kept"}`;
}

function bodyLength(text: string): string {
  return text.length.toLocaleString("en-US");
}

function modelLabel(model: ModelRef): string {
  const provider = model.providerID || "?";
  const id = model.id || "?";
  return `${provider}/${id}${model.variant ? `#${model.variant}` : ""}`;
}

function repoLine(status: RepoStatus): string {
  const when = status.at
    ? new Date(status.at).toLocaleTimeString("en-US", { hour12: false })
    : "";
  return `${status.state}${when ? ` at ${when}` : ""}${status.message ? ` — ${status.message}` : ""}`;
}

function usage(): string {
  return [
    "/purge                 toggle",
    "/purge on | off",
    "/purge status",
    "/purge mode append|replace|strict",
    "/purge source <path|directory|auto|embedded>",
    "/purge sandbox off|read|work",
    "/purge update-md | update | reload",
  ].join("\n");
}

/** Consume an unknown session.deleted payload defensively. */
function sessionIdOf(event: unknown): string | undefined {
  const value = event as
    | { sessionID?: unknown; data?: { sessionID?: unknown }; properties?: { sessionID?: unknown } }
    | undefined;
  const candidates = [value?.sessionID, value?.data?.sessionID, value?.properties?.sessionID];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return undefined;
}

export default Plugin.define({
  id: "opencode-purge",
  async setup(ctx) {
    const options = (ctx.options ?? {}) as Record<string, unknown>;
    const optionMode = String(options.mode ?? "").toLowerCase();
    const initialMode: Mode = isMode(optionMode) ? optionMode : "strict";
    const optionSourceRaw = typeof options.source === "string" ? options.source.trim() : "";
    const optionSource =
      optionSourceRaw.toLowerCase() === "auto"
        ? "auto"
        : optionSourceRaw.toLowerCase() === EMBEDDED
          ? EMBEDDED
          : optionSourceRaw;
    const initialSource = optionSource || ENV_SOURCE || EMBEDDED;
    const notifyEnabled = options.notify !== false;

    let personaRepoRoot = resolveOptionPath(
      typeof options.personaRepo === "string" ? options.personaRepo : "",
    );
    const personaRepoUrl =
      typeof options.personaRepoUrl === "string" ? options.personaRepoUrl.trim() : "";
    const autoPull = options.autoPull === true;
    const autoPullOnStart = options.autoPullOnStart !== false;
    const pullMinutes = Number(options.autoPullIntervalMinutes ?? 0);
    const fallbackRaw = typeof options.fallback === "string" ? options.fallback.trim() : "none";
    const personaFallback =
      fallbackRaw === "" || fallbackRaw === "none"
        ? "none"
        : fallbackRaw.toLowerCase() === "embedded"
          ? "embedded"
          : resolveOptionPath(fallbackRaw);

    const optionSandbox = String(options.sandbox ?? "").toLowerCase();
    const initialSandbox: SandboxProfile = isSandboxProfile(optionSandbox) ? optionSandbox : "off";
    // dsh-purge design: sessions start armed instead of requiring /purge:on.
    const autoApplyOnStart = options.autoApplyOnStart === true;
    // dsh-purge's file layer (opt-in): a markdown file injected as mandatory
    // session directives on every rewritten request. A missing file is a no-op.
    // Relative paths resolve against the plugin root (repo checkout).
    const injectFile = resolveOptionPath(
      typeof options.injectFile === "string" ? options.injectFile : "",
    );
    const allowShell = Array.isArray(options.sandboxAllowShell)
      ? options.sandboxAllowShell.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
    // packOut relative values resolve against the plugin root so the pack
    // never lands inside a catalog's vendor scan.
    const packOutOption = resolveOptionPath(
      typeof options.packOut === "string" ? options.packOut : "",
    );
    const statusFileOption = resolveOptionPath(
      typeof options.statusFile === "string" ? options.statusFile : "",
    );
    const updateRootOption = resolveOptionPath(
      typeof options.updateRoot === "string" ? options.updateRoot : "",
    );
    const selfRepo = new PersonaRepo(
      updateRootOption || PLUGIN_ROOT,
      "",
      true,
      "plugin directory",
    );

    let cwd = "";
    try {
      cwd = normalizeCwd(ctx.location?.directory ?? "");
    } catch {
      cwd = "";
    }
    if (!cwd) cwd = normalizeCwd(process.cwd());

    // Per-instance session state: a duplicate plugin instance must never see
    // or arm this one's sessions (double-inject hazard).
    const sessions = new Map<string, PurgeState>();
    let contextErrorWarned = false;
    const catalogs = new Map<string, CatalogSource>();
    const personaCache = new Map<string, { mtimeMs: number; text: string }>();
    const fallbackCache = new Map<string, { mtimeMs: number; text: string }>();

    let repo =
      personaRepoRoot.length > 0
        ? new PersonaRepo(personaRepoRoot, personaRepoUrl, autoPull)
        : null;

    const catalogFor = (root: string): CatalogSource => {
      let catalog = catalogs.get(root);
      if (!catalog) {
        catalog = new CatalogSource(root);
        catalogs.set(root, catalog);
      }
      return catalog;
    };

    const catalogRootFor = (state: PurgeState): string | null => {
      if (state.source === "auto") return personaRepoRoot || null;
      if (state.source !== EMBEDDED && isDirectory(state.source)) return state.source;
      return null;
    };

    const isCatalog = (state: PurgeState): boolean => catalogRootFor(state) !== null || state.source === "auto";

    const readCatalogFile = (file: CatalogFile): string => {
      const hit = personaCache.get(file.path);
      if (hit && hit.mtimeMs === file.mtimeMs) return hit.text;
      try {
        const text = readFileSync(file.path, "utf8").trim();
        personaCache.set(file.path, { mtimeMs: file.mtimeMs, text });
        return text;
      } catch {
        // Deleted or unreadable between scan and read: treat as no match.
        return "";
      }
    };

    const readFallbackFile = (path: string): string => {
      try {
        const mtimeMs = statSync(path).mtimeMs;
        const hit = fallbackCache.get(path);
        if (hit && hit.mtimeMs === mtimeMs) return hit.text;
        const text = readFileSync(path, "utf8").trim();
        fallbackCache.set(path, { mtimeMs, text });
        return text;
      } catch {
        return "";
      }
    };

    /** dsh-style file layer: `injectFile` content is appended as mandatory
     * session directives on every rewritten request (mtime-cached). */
    const readInjected = (): string => (injectFile ? readFallbackFile(injectFile) : "");

    const fallbackPersona = (): PersonaMatch | null => {
      if (personaFallback === "none") return null;
      if (personaFallback === "embedded") {
        return {
          text: DEFAULT_PERSONA,
          label: "embedded (fallback)",
          chars: DEFAULT_PERSONA.length,
        };
      }
      const text = readFallbackFile(personaFallback);
      if (!text) return null;
      return {
        text,
        label: `${personaFallback} (fallback)`,
        chars: text.length,
      };
    };

    const resolvePersona = (state: PurgeState, model: ModelRef): PersonaMatch | null => {
      const root = catalogRootFor(state);
      if (root) {
        const match = catalogFor(root).resolve(model);
        if (match) {
          const text = readCatalogFile(match.file);
          if (text) {
            return {
              text,
              label: `${match.vendor.name}/${match.file.name}`,
              chars: text.length,
            };
          }
        }
        return fallbackPersona();
      }

      if (!state.body) return null;
      return {
        text: state.body,
        label: state.source === EMBEDDED ? "embedded" : state.source,
        chars: state.body.length,
      };
    };

    const loadState = (state: PurgeState): boolean => {
      const root = catalogRootFor(state);
      if (state.source === "auto" && !root) {
        state.body = "";
        state.loadError = "personaRepo is not configured";
        return false;
      }
      if (root) {
        if (!isDirectory(root)) {
          state.body = "";
          state.loadError = `persona catalog not found: ${root}`;
          return false;
        }
        const vendors = catalogFor(root).refresh();
        if (vendors.length === 0) {
          // An empty catalog is only fatal without a fallback: with one, the
          // session can still run on it.
          if (personaFallback === "none") {
            state.body = "";
            state.loadError = `no persona files in ${root}`;
            return false;
          }
          state.body = "";
          state.loadError = "";
          return true;
        }
        state.body = "";
        state.loadError = "";
        return true;
      }

      if (state.source === EMBEDDED) {
        state.body = DEFAULT_PERSONA;
        state.loadError = state.body.length > 0 ? "" : "embedded persona is empty";
        return state.body.length > 0;
      }

      try {
        if (!existsSync(state.source)) throw new Error(`file not found: ${state.source}`);
        const text = readFileSync(state.source, "utf8").trim();
        if (text.length === 0) throw new Error(`file is empty: ${state.source}`);
        state.body = text;
        state.loadError = "";
        return true;
      } catch (error) {
        state.body = "";
        state.loadError = errorText(error);
        return false;
      }
    };

    const stateFor = (sessionID: string): PurgeState => {
      let state = sessions.get(sessionID);
      if (!state) {
        state = createState(initialMode, initialSource, cwd, initialSandbox);
        sessions.set(sessionID, state);
        const loaded = loadState(state);
        if (autoApplyOnStart && loaded) state.enabled = true;
      }
      return state;
    };

    const describe = (state: PurgeState): string => {
      const lines: string[] = [`purge ${state.enabled ? "on" : "off"} — ${modeLabel(state.mode)}`];

      if (isCatalog(state)) {
        const root = catalogRootFor(state) ?? "unset";
        const listing = catalogRootFor(state) ? catalogFor(root).list() : [];
        const files = listing.reduce((count, vendor) => count + vendor.files.length, 0);
        const match = state.lastPersona;
        const kind = state.source === "auto" ? "auto" : state.source;
        lines.push(
          `source: ${kind} (${root}) ${listing.length}/${files} — ${
            match ? `${match.label} (${bodyLength(match.text)})` : state.loadError ? `broken (${state.loadError})` : "waiting"
          }`,
        );
      } else {
        lines.push(
          `source: ${state.source === EMBEDDED ? "embedded" : state.source}` +
            (state.loadError ? ` (${state.loadError})` : state.body ? ` — ${bodyLength(state.body)} chars` : ""),
        );
      }

      if (state.lastCut.at) lines.push(`last: ${describeCut(state.lastCut)}`);
      if (state.lastHost) lines.push(`host: ${state.lastHost.parts} part(s), ${state.lastHost.bytes} chars`);
      lines.push(`sandbox: ${sandboxLabel(state.sandbox)}${allowShell.length > 0 ? `; allowShell ${allowShell.length}` : ""}`);
      if (repo?.enabled) lines.push(`repo: ${repoLine(repo.status)}`);

      return lines.join("\n");
    };

    /** Read the session's selected model so /purge on can resolve the persona
     * up front. Older hosts or early sessions expose nothing — callers fall
     * back to per-request matching then. */
    const sessionModel = async (sessionID: string): Promise<ModelRef | null> => {
      try {
        const record = (await ctx.session.get({ sessionID })) as {
          model?: { providerID?: unknown; id?: unknown; variant?: unknown };
        };
        const providerID = typeof record.model?.providerID === "string" ? record.model.providerID : "";
        const id = typeof record.model?.id === "string" ? record.model.id : "";
        if (!providerID || !id) return null;
        return {
          providerID,
          id,
          ...(typeof record.model?.variant === "string" && record.model.variant ? { variant: record.model.variant } : {}),
        };
      } catch {
        return null;
      }
    };

    /** Use the session's own directory when the host exposes it. */
    const resolveCwd = async (sessionID: string): Promise<string> => {
      try {
        const info = await ctx.session.get({ sessionID });
        const record = info as {
          location?: { directory?: unknown };
          directory?: unknown;
        };
        const directory = record.location?.directory ?? record.directory;
        if (typeof directory === "string" && directory.trim()) return normalizeCwd(directory);
      } catch {
        // Fall back to the plugin location below.
      }
      return cwd;
    };

    const NOTIFY_HEADER =
      "[opencode-purge] machine status. There is no task here: use no tools, do not create or modify files, and do not reply; wait for the operator's next message.";
    const DISPLAY_HEADER =
      "[opencode-purge] status readout. Your entire reply must be exactly the block below, verbatim — no preamble, no extra words, no tools.";

    /** Status channel matrix:
     *  - statusFile: always written (silent, zero model turns), the reliable one
     *  - chat note (`notify: true`): visible; the host wakes one short turn.
     *    `display` mode repurposes that turn to render the readout verbatim
     *    (used by /purge:status); otherwise the note tells the turn to stand down. */
    const notify = async (
      sessionID: string,
      text: string,
      mode: "status" | "display" = "status",
    ): Promise<void> => {
      try {
        const file = statusFileOption || DEFAULT_STATUS_FILE;
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `${new Date().toISOString()} [${sessionID}]\n${text}\n`, "utf8");
      } catch {
        // A read-only config directory must not block the toggle.
      }
      if (!notifyEnabled) return;
      try {
        await ctx.session.synthetic({
          sessionID,
          text: mode === "display" ? `${DISPLAY_HEADER}\n\n${text}` : `${NOTIFY_HEADER}\n\n${text}`,
          description: "opencode-purge",
        });
      } catch {
        // A missing session or an older host must not block the toggle itself.
      }
    };

    const refreshCatalog = (): void => {
      if (personaRepoRoot) catalogFor(personaRepoRoot).refresh();
    };

    const timers: Array<ReturnType<typeof setInterval>> = [];
    if (repo?.enabled && autoPullOnStart) {
      void repo.sync().then(refreshCatalog);
    }
    if (repo?.enabled && Number.isFinite(pullMinutes) && pullMinutes > 0) {
      const timer = setInterval(() => {
        void repo?.sync().then(refreshCatalog);
      }, pullMinutes * 60_000);
      timer.unref?.();
      timers.push(timer);
    }

    /** The catalog upstream ships its own README; the prompts folder is meant
     * to hold prompts only. Called on every pack path. */
    const stripReadme = (root: string): void => {
      const readme = join(root, "README.md");
      if (!existsSync(readme)) return;
      try {
        unlinkSync(readme);
      } catch {
        // A locked file must not block packing.
      }
    };

    /** Pack `<root>` into one markdown file and report; `prefix` lets the
     * async path distinguish its completion note. */
    const finishPack = async (sessionID: string, root: string, prefix = "update-md"): Promise<void> => {
      // Only strip the upstream README from managed catalogs; a user-supplied
      // catalog folder keeps its own files.
      if (isManagedCatalog(root)) stripReadme(root);
      const out = packOutOption || join(root, "personas-pack.md");
      try {
        const markdown = buildPackMarkdown(root);
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, markdown, "utf8");
        const files = buildPack(root).count;
        await notify(sessionID, `${prefix}: ${files} file(s) — ${out}`);
      } catch (error) {
        await notify(sessionID, `${prefix}: failed — ${errorText(error)}`);
      }
    };

    /** One executor for every entry point; `text` carries just the tokens
     * after the command name ("/purge on" → "on", colon form assembled the
     * same way). */
    const runPurge = async (sessionID: string, rawText: string): Promise<void> => {
      const state = stateFor(sessionID);
      const { cmd, arg } = parseCommand(rawText);
      const turnOn = async (): Promise<void> => {
        if (!loadState(state)) {
          state.enabled = false;
          await notify(sessionID, `enable: failed — ${state.loadError}`);
          return;
        }

        // Both lookups are independent host round-trips: run them together,
        // and skip the model call entirely when no catalog is in play.
        const [resolvedCwd, model] = await Promise.all([
          resolveCwd(sessionID),
          isCatalog(state) ? sessionModel(sessionID) : Promise.resolve(null),
        ]);
        state.cwd = resolvedCwd;

        // Resolve the persona NOW when the host tells us the session model:
        // enabling must never stand in for a request that would ship the
        // stock prompt, and the note can name the exact file instead of
        // promising "matched per request".
        let planned = "";
        if (model) {
          const persona = resolvePersona(state, model);
          if (!persona) {
            state.enabled = false;
            await notify(
              sessionID,
              `purge off — no persona for ${modelLabel(model)} (fallback: ${personaFallback === "none" ? "none" : personaFallback})`,
            );
            return;
          }
          state.lastPersona = persona;
          planned = ` — ${persona.label}`;
        }

        state.enabled = true;
        if (isCatalog(state) && repo?.enabled) {
          void repo.sync().then(refreshCatalog);
        }
        if (!planned && !isCatalog(state) && state.source !== EMBEDDED) planned = ` — ${state.source}`;
        await notify(
          sessionID,
          `purge on — ${modeLabel(state.mode)}${planned || (isCatalog(state) ? "; matched per request" : "")}`,
        );
        return;
      };

      const turnOff = async (): Promise<void> => {
        state.enabled = false;
        await notify(sessionID, "purge off — OpenCode prompt restored");
      };

      switch (cmd) {
        case "":
          if (state.enabled) await turnOff();
          else await turnOn();
          return;
        case "on":
        case "enable":
          await turnOn();
          return;
        case "off":
        case "disable":
          await turnOff();
          return;
        case "status":
          if (!isCatalog(state) && state.body.length === 0) loadState(state);
          await notify(sessionID, describe(state), "display");
          return;
        case "mode": {
          const wanted = arg.toLowerCase();
          if (!isMode(wanted)) {
            await notify(sessionID, `mode: ${state.mode}\n${usage()}`);
            return;
          }
          state.mode = wanted;
          await notify(sessionID, `mode: ${wanted} — ${modeLabel(wanted)}`);
          return;
        }
        case "source": {
          if (!arg) {
            const current = state.source === EMBEDDED ? "embedded" : state.source;
            await notify(sessionID, `source: ${current} — /purge source <path|auto|embedded>`);
            return;
          }
          const previous = state.source;
          const next = arg.replace(/^["']|["']$/g, "");
          state.source =
            next.toLowerCase() === EMBEDDED
              ? EMBEDDED
              : next.toLowerCase() === "auto"
                ? "auto"
                : next;
          if (!loadState(state)) {
            const reason = state.loadError;
            state.source = previous;
            loadState(state);
            await notify(sessionID, `source: switch failed — ${reason}`);
            return;
          }
          await notify(
            sessionID,
            isCatalog(state)
              ? `source: auto — matched per request${state.loadError ? ` (${state.loadError})` : ""}`
              : `source: ${state.source} — ${bodyLength(state.body)} chars`,
          );
          return;
        }
        case "sandbox": {
          const wanted = arg.toLowerCase();
          if (!isSandboxProfile(wanted)) {
            await notify(sessionID, `sandbox: ${state.sandbox}\n${usage()}`);
            return;
          }
          state.sandbox = wanted;
          await notify(sessionID, `sandbox: ${wanted} — ${sandboxLabel(wanted)}`);
          return;
        }
        case "update-md": {
          // Fast path: an existing catalog (configured, or downloaded earlier
          // in this process) packs instantly; a missing catalog is cloned in
          // the background.
          const root = catalogRootFor(state) ?? personaRepoRoot;
          if (root && isDirectory(root)) {
            await finishPack(sessionID, root);
            if (personaRepoUrl) {
              const mirror = repo?.enabled ? repo : new PersonaRepo(root, personaRepoUrl, true);
              void mirror
                .sync()
                .then(async (sync) => {
                  if (sync.state === "error") {
                    await notify(sessionID, `update-md: sync failed — ${sync.message}`);
                    return;
                  }
                  if (sync.state === "skipped") {
                    await notify(sessionID, `update-md: sync skipped — ${sync.message}`);
                    return;
                  }
                  catalogFor(root).refresh();
                  await finishPack(sessionID, root, "update-md: synced");
                })
                .catch(async (error) => {
                  await notify(sessionID, `update-md: sync failed — ${errorText(error)}`);
                });
            }
            return;
          }
          if (!personaRepoUrl) {
            await notify(sessionID, "update-md: no personaRepo and no personaRepoUrl configured");
            return;
          }
          const target = join(ctx.location?.directory || cwd, "prompts");
          await notify(sessionID, `update-md: downloading catalog → ${target}`);
          void (async () => {
            try {
              const mirror = new PersonaRepo(target, personaRepoUrl, true);
              const sync = await mirror.sync();
              if (sync.state === "error") {
                await notify(sessionID, `update-md: clone failed — ${sync.message}`);
                return;
              }
              personaRepoRoot = target;
              if (!repo || repo.root !== target) {
                repo = new PersonaRepo(target, personaRepoUrl, autoPull);
              }
              loadState(stateFor(sessionID));
              await finishPack(sessionID, target, "update-md");
            } catch (error) {
              await notify(sessionID, `update-md: failed — ${errorText(error)}`);
            }
          })();
          return;
        }
        case "update": {
          // Git pull is inherently network-slow: report immediately, then
          // post the outcome as a follow-up note when it lands.
          await notify(sessionID, "update: pulling plugin repository…");
          void selfRepo
            .sync()
            .then(async (status) => {
              const hint =
                status.state === "ok" && status.message !== "up to date"
                  ? " — restart OpenCode to reload the changed source"
                  : "";
              await notify(sessionID, `update: ${repoLine(status)}${hint}`);
            })
            .catch(async (error) => {
              await notify(sessionID, `update: failed — ${errorText(error)}`);
            });
          return;
        }
        case "reload": {
          // Local-only by design: rescan the configured catalog or re-read
          // the persona file. Network refresh lives in `/purge update` and
          // the autoPull schedules — a reload must stay instant.
          if (isCatalog(state)) {
            const root = catalogRootFor(state);
            if (!root) {
              await notify(sessionID, "reload: personaRepo is not configured");
              return;
            }
            const vendors = catalogFor(root).refresh();
            const files = vendors.reduce((count, vendor) => count + vendor.files.length, 0);
            await notify(sessionID, `reload: ${vendors.length} vendors, ${files} files`);
            return;
          }
          if (state.source === EMBEDDED) {
            await notify(sessionID, "reload: embedded needs none");
            return;
          }
          if (!loadState(state)) {
            await notify(sessionID, `reload: failed — ${state.loadError}`);
            return;
          }
          await notify(sessionID, `reload: ${bodyLength(state.body)} chars from ${state.source}`);
          return;
        }
        default:
          await notify(sessionID, `unknown "${cmd}"\n${usage()}`);
          return;
      }
    };

    const commandRegistration = await ctx.command.transform((editor) => {
      editor.add({
        name: "purge",
        description:
          "Swap OpenCode's system prompt for this session: persona only (strict), persona + trimmed host prompt (replace), or persona plus host prompt (append). With source=auto, the persona is matched to the active model. /purge sandbox off|read|work caps tool permissions for this session: read is read-only, work asks before shell and network. /purge update-md rebuilds the one-file catalog pack.",
        execute: async (input) => runPurge(input.sessionID, input.prompt?.text ?? ""),
      });
    });

    const PURGE_SUBCOMMANDS: Array<{ name: string; description: string }> = [
      { name: "on", description: "purge: enable for this session" },
      { name: "off", description: "purge: disable and restore OpenCode's prompt" },
      { name: "status", description: "purge: state, source, sandbox in one line each" },
      { name: "mode", description: "purge: prompt mode append|replace|strict" },
      { name: "source", description: "purge: persona file, catalog dir, auto, or embedded" },
      { name: "sandbox", description: "purge: permission ceiling off|read|work" },
      { name: "update-md", description: "purge: pack the catalog folder into one .md" },
      { name: "update", description: "purge: git pull this plugin's own repo" },
      { name: "reload", description: "purge: re-scan catalog / re-read persona" },
    ];

    const subcommandRegistration = await ctx.command.transform((editor) => {
      for (const sub of PURGE_SUBCOMMANDS) {
        editor.add({
          name: `purge:${sub.name}`,
          description: sub.description,
          execute: async (input) => {
            const raw = input.prompt?.text ?? "";
            const prefix = new RegExp(`^/purge:${sub.name}\\b\\s*`, "i");
            const rest = raw.replace(prefix, "").trim();
            await runPurge(input.sessionID, `${sub.name}${rest ? ` ${rest}` : ""}`);
          },
        });
      }
    });

    const permissionHook = await ctx.permission.hook("evaluate", (evaluation) => {
      const sessionID = String(evaluation.sessionID ?? "");
      const state = stateFor(sessionID);
      if (state.sandbox === "off") return;
      if (!isEffect(evaluation.effect)) return;

      const decision = sandboxDecision(
        state.sandbox,
        {
          action: String(evaluation.action ?? ""),
          resources: Array.isArray(evaluation.resources) ? evaluation.resources : [],
          cwd: state.cwd || cwd,
        },
        { allowShell },
      );

      const next = tighten(evaluation.effect, decision.effect);
      if (next !== evaluation.effect) {
        evaluation.effect = next;
        if (decision.message) evaluation.message = decision.message;
      }
    });

    const contextHook = await ctx.session.hook("context", (event) => {
      // stateFor (not sessions.get): with autoApplyOnStart, a fresh session is
      // armed here on its very first request, dsh-style.
      const state = stateFor(event.sessionID);
      if (!state.enabled) return;

      // A failing rewrite must never break the model request: keep the exact
      // host parts and restore them if anything below throws.
      const hostBefore = [...(event.system ?? [])];
      try {
        const model: ModelRef = {
          providerID: String(event.model?.providerID ?? ""),
          id: String(event.model?.id ?? ""),
          ...(event.model?.variant ? { variant: String(event.model.variant) } : {}),
        };
        const persona = resolvePersona(state, model);
        state.lastPersona = persona;
        const host = event.system ?? [];
        state.lastHost = snapshot(host);

        if (persona) {
          const result = composeSystem(host, {
            mode: state.mode,
            persona: persona.text,
            cwd: state.cwd || cwd,
          });
          event.system.splice(0, event.system.length, ...(result.parts as typeof event.system));
          // pi-purge only records a cut in replace/strict; append leaves the
          // previous report in place, so /purge status stays honest about it.
          if (state.mode !== "append") state.lastCut = result.cut;
        }

        // dsh-style injection layer: authoritative directives ride at the END
        // of the system array (highest recency) in every mode, including append
        // and unmatched-persona sessions.
        const injected = readInjected();
        if (injected) {
          event.system.push({
            type: "text",
            text: `# Session directives (mandatory)\n\n${injected}`,
          } as (typeof event.system)[number]);
        }
      } catch (error) {
        event.system.splice(0, event.system.length, ...(hostBefore as typeof event.system));
        state.lastPersona = null;
        if (!contextErrorWarned) {
          contextErrorWarned = true;
          console.warn(`[opencode-purge] rewrite failed; host prompt left untouched: ${errorText(error)}`);
        }
      }
    });

    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: ["session.deleted"],
          signal: controller.signal,
        })) {
          const sessionID = sessionIdOf(event);
          if (sessionID) sessions.delete(sessionID);
        }
      } catch {
        // Aborted during shutdown, or the event stream is unavailable.
      }
    })();

    return async () => {
      controller.abort();
      for (const timer of timers) clearInterval(timer);
      sessions.clear();
      catalogs.clear();
      personaCache.clear();
      fallbackCache.clear();
      try {
        await permissionHook.dispose();
      } catch {
        // Already disposed by the host.
      }
      try {
        await contextHook.dispose();
      } catch {
        // Already disposed by the host.
      }
      try {
        await commandRegistration.dispose();
      } catch {
        // Already disposed by the host.
      }
      try {
        await subcommandRegistration.dispose();
      } catch {
        // Already disposed by the host.
      }
    };
  },
});
