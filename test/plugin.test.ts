import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PERSONA } from "../src/purge.ts";

// The plugin computes its default status path at import time, so the env
// override must exist before the module is evaluated (static imports hoist).
process.env.OPENCODE_PURGE_STATUS_FILE = join(tmpdir(), "opencode-purge-test-status.txt");
mkdirSync(join("test", ".tmp-fixtures"), { recursive: true });
const { default: plugin } = await import("../src/index.ts");

interface Part {
  type: "text";
  text: string;
  metadata?: Record<string, unknown>;
}

interface HookEvent {
  sessionID: string;
  system: Part[];
  model?: { providerID: string; id: string; variant?: string };
}

interface CommandLike {
  name: string;
  execute(input: {
    sessionID: string;
    prompt: { text: string };
    delivery: "steer" | "queue";
  }): Promise<void>;
}

function mainPrompt(): string {
  return [
    "You are an AI agent running in OpenCode, a coding agent harness. Help the user accomplish their goals using the tools you have available.",
    "",
    "# Harness",
    "- Responses are rendered as GitHub-flavored Markdown.",
    "- Prefer parallelizing independent tool calls.",
    "",
    "# Communication",
    "- Keep responses clear and concise.",
    "",
  ].join("\n");
}

function hostParts(): Part[] {
  return [
    { type: "text", text: mainPrompt() },
    { type: "text", text: "# Your Model\n- Name: Test Model" },
    {
      type: "text",
      text: "# Instructions\n- project rule",
      metadata: {
        experimental: {
          instructions: [
            { key: "core/date", text: "date" },
            { key: "core/environment", text: "cwd" },
          ],
        },
      },
    },
  ];
}

const pendingCleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  // Tests that abort at a failed note-assert before their inline cleanup
  // never reach it; the module-level sessions map therefore leaks state
  // into later tests. Every setup registers its disposer here, and the
  // queue is drained after each test regardless of failure.
  while (pendingCleanups.length > 0) {
    const dispose = pendingCleanups.pop();
    await dispose?.();
  }
});

function makeCtx(
  options: Record<string, unknown> = {},
  directory = "C:\\Work\\demo",
  sessionDirectory = directory,
  sessionModel?: { providerID: string; id: string; variant?: string },
) {
  const notes: string[] = [];
  const synthetics: Array<{ text: string }> = [];
  const commands = new Map<string, CommandLike>();
  let contextHook: ((event: HookEvent) => void) | undefined;
  let permissionHook:
    | ((evaluation: {
        sessionID: string;
        action: string;
        resources: string[];
        effect: "allow" | "deny" | "ask";
        message?: string;
      }) => void)
    | undefined;

  interface FakeEvaluation {
    sessionID: string;
    action: string;
    resources: string[];
    effect: "allow" | "deny" | "ask";
    message?: string;
  }

  const ctx = {
    options,
    location: { directory },
    command: {
      transform: async (callback: (editor: { add(definition: CommandLike): void }) => void) => {
        callback({
          add(definition) {
            commands.set(definition.name, definition);
          },
        });
        return { dispose: async () => {} };
      },
    },
    session: {
      get: async () => ({
        location: { directory: sessionDirectory },
        ...(sessionModel ? { model: sessionModel } : {}),
      }),
      hook: async (name: string, callback: (event: HookEvent) => void) => {
        assert.equal(name, "context");
        contextHook = callback;
        return { dispose: async () => {} };
      },
      synthetic: async (input: { text: string }) => {
        notes.push(input.text);
        synthetics.push(input);
      },
    },
    permission: {
      hook: async (name: string, callback: (evaluation: FakeEvaluation) => void) => {
        assert.equal(name, "evaluate");
        permissionHook = callback;
        return { dispose: async () => {} };
      },
    },
    event: {
      subscribe: () => (async function* empty() {})() as AsyncIterable<never>,
    },
  };

  return {
    ctx,
    notes,
    synthetics,
    command(name?: string): CommandLike {
      const definition = name ? commands.get(name) : commands.get("purge") ?? [...commands.values()][0];
      assert.ok(definition, `plugin did not register command "${name ?? "purge"}"`);
      return definition;
    },
    commandNames(): string[] {
      return [...commands.keys()];
    },
    hook(): (event: HookEvent) => void {
      assert.ok(contextHook, "plugin did not register a context hook");
      return contextHook;
    },
    evaluate(evaluation: FakeEvaluation) {
      assert.ok(permissionHook, "plugin did not register a permission hook");
      permissionHook(evaluation);
      return evaluation;
    },
    cleanup: undefined as unknown as (() => Promise<void>) | undefined,
  };
}

async function setup(
  options: Record<string, unknown> = {},
  directory?: string,
  sessionDirectory?: string,
  sessionModel?: { providerID: string; id: string; variant?: string },
) {
  const mock = makeCtx(options, directory, sessionDirectory, sessionModel);
  let cleanup: (() => Promise<void>) | undefined;
  try {
    cleanup = (await plugin.setup(mock.ctx as unknown as Parameters<typeof plugin.setup>[0])) as
      | (() => Promise<void>)
      | undefined;
  } catch (error) {
    // Plugin setup failures must not strand state in the shared sessions map.
    if (!cleanup) throw error;
  }
  if (cleanup) pendingCleanups.push(cleanup as () => Promise<void>);
  return { ...mock, cleanup };
}

async function runCommand(mock: ReturnType<typeof makeCtx>, text: string, sessionID = "ses_a") {
  await mock.command().execute({
    sessionID,
    prompt: { text },
    delivery: "steer",
  });
}

/** Wait for an asynchronous follow-up note (network-shaped commands report
 * instantly, then finish in the background). */
async function waitForNote(mock: ReturnType<typeof makeCtx>, pattern: RegExp, timeoutMs = 5000): Promise<string> {
  const started = Date.now();
  for (;;) {
    const found = [...mock.notes].reverse().find((note) => pattern.test(note));
    if (found) return found;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`no note matching ${pattern} within ${timeoutMs}ms; notes: ${JSON.stringify(mock.notes)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function rewrite(
  mock: ReturnType<typeof makeCtx>,
  sessionID = "ses_a",
  parts = hostParts(),
  model = { providerID: "test", id: "gpt-5" },
): Part[] {
  const system = structuredClone(parts);
  mock.hook()({ sessionID, system, model });
  return system;
}

test("plugin is a V2 plugin definition with the expected id", () => {
  assert.equal(plugin.id, "opencode-purge");
  assert.equal(typeof plugin.setup, "function");
});

test("disabled by default: the hook returns the host prompt untouched", async () => {
  const mock = await setup();
  const original = hostParts();
  const system = rewrite(mock, "ses_a", original);
  assert.deepEqual(system, original);
  await runCommand(mock, "status");
  assert.match(mock.notes.at(-1) ?? "", /purge off/);
  await mock.cleanup?.();
});

test("strict (default) sends only the persona and the working directory", async () => {
  const mock = await setup();
  await runCommand(mock, "on");
  assert.match(mock.notes.at(-1) ?? "", /purge on — persona/);

  const system = rewrite(mock);
  assert.equal(system.length, 1);
  assert.equal(
    system[0]?.text,
    `${DEFAULT_PERSONA}\n\nCurrent working directory: C:/Work/demo`,
  );
  assert.ok(!system[0]?.text.includes("You are an AI agent running in OpenCode"));

  await runCommand(mock, "status");
  const status = mock.notes.at(-1) ?? "";
  assert.match(status, /purge on/);
  assert.match(status, /persona \+ cwd only/);
  assert.match(status, /last: identity cut/);
  assert.match(status, /host: 3 part\(s\), 363 chars/);
  await mock.cleanup?.();
});

test("replace keeps the host body, drops the identity, and preserves metadata", async () => {
  const mock = await setup();
  await runCommand(mock, "on");
  await runCommand(mock, "mode replace");

  const original = hostParts();
  const system = rewrite(mock, "ses_a", original);

  assert.equal(system.length, original.length + 1);
  assert.equal(system[0]?.text, DEFAULT_PERSONA);

  const main = system[1];
  assert.ok(main);
  assert.ok(!main.text.includes("You are an AI agent running in OpenCode"));
  assert.ok(main.text.includes("# Harness"));
  assert.ok(main.text.includes("# Communication"));

  assert.equal(system[2]?.text, "# Your Model\n- Name: Test Model");
  assert.deepEqual(system[3]?.metadata, original[2]?.metadata);

  await runCommand(mock, "status");
  assert.match(mock.notes.at(-1) ?? "", /persona \+ trimmed host/);
  await mock.cleanup?.();
});

test("append prepends the persona and leaves the host prompt intact", async () => {
  const mock = await setup();
  await runCommand(mock, "on");
  await runCommand(mock, "mode append");

  const original = hostParts();
  const system = rewrite(mock, "ses_a", original);
  assert.equal(system.length, original.length + 1);
  assert.equal(system[0]?.text, DEFAULT_PERSONA);
  assert.deepEqual(system.slice(1), original);
  await mock.cleanup?.();
});

test("off restores the stock prompt immediately", async () => {
  const mock = await setup();
  await runCommand(mock, "on");
  await runCommand(mock, "off");

  const original = hostParts();
  assert.deepEqual(rewrite(mock, "ses_a", original), original);
  assert.match(mock.notes.at(-1) ?? "", /prompt restored/);
  await mock.cleanup?.();
});

test("external source: load, reload, failed switch rolls back, embedded restores", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-purge-"));
  const file = join(dir, "persona.md");
  writeFileSync(file, "FILE PERSONA A", "utf8");

  try {
    const mock = await setup();
    await runCommand(mock, `source ${file}`);
    await runCommand(mock, "on");

    let system = rewrite(mock);
    assert.match(system[0]?.text ?? "", /^FILE PERSONA A\n\nCurrent working directory: C:\/Work\/demo$/);

    writeFileSync(file, "FILE PERSONA B", "utf8");
    await runCommand(mock, "reload");
    system = rewrite(mock);
    assert.match(system[0]?.text ?? "", /^FILE PERSONA B/);

    await runCommand(mock, `source ${join(dir, "missing.md")}`);
    assert.match(mock.notes.at(-1) ?? "", /source: switch failed/);
    system = rewrite(mock);
    assert.match(system[0]?.text ?? "", /^FILE PERSONA B/, "failed switch must roll back");

    await runCommand(mock, "source embedded");
    system = rewrite(mock);
    assert.ok(system[0]?.text.startsWith(DEFAULT_PERSONA));

    await mock.cleanup?.();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("strict uses the session directory, not just the plugin location", async () => {
  const mock = await setup({}, "C:\\PluginRoot", "C:\\SessionDir");
  await runCommand(mock, "on");
  const system = rewrite(mock);
  assert.equal(
    system[0]?.text,
    `${DEFAULT_PERSONA}\n\nCurrent working directory: C:/SessionDir`,
  );
  await mock.cleanup?.();
});

test("state is per session", async () => {
  const mock = await setup();
  await runCommand(mock, "on", "ses_a");

  const other = hostParts();
  assert.deepEqual(rewrite(mock, "ses_b", other), other);
  assert.equal(rewrite(mock, "ses_a").length, 1);
  await mock.cleanup?.();
});

test("options set the initial mode and source before the first turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-purge-"));
  const file = join(dir, "persona.md");
  writeFileSync(file, "OPTIONS PERSONA", "utf8");

  try {
    const mock = await setup({ mode: "append", source: file });
    await runCommand(mock, "on");
    const original = hostParts();
    const system = rewrite(mock, "ses_a", original);
    assert.equal(system.length, original.length + 1);
    assert.equal(system[0]?.text, "OPTIONS PERSONA");
    assert.deepEqual(system.slice(1), original);
    await mock.cleanup?.();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("notify:false suppresses synthetic messages but still purges", async () => {
  const mock = await setup({ notify: false });
  await runCommand(mock, "on");
  assert.equal(mock.notes.length, 0);
  assert.equal(rewrite(mock).length, 1);
  await mock.cleanup?.();
});

test("notify:false writes the quiet channel to statusFile instead of waking a turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "purge-status-"));
  const statusFile = join(dir, "status.txt");
  try {
    const mock = await setup({ notify: false, statusFile });
    await runCommand(mock, "on");
    assert.equal(mock.notes.length, 0);
    const written = readFileSync(statusFile, "utf8");
    assert.match(written, /purge on — /);
    assert.match(written, /\[ses_a\]/);

    await runCommand(mock, "status");
    assert.match(readFileSync(statusFile, "utf8"), /purge on/);
    await mock.cleanup?.();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanup clears in-memory state", async () => {
  const mock = await setup();
  await runCommand(mock, "on");
  assert.equal(rewrite(mock).length, 1);

  await mock.cleanup?.();
  const original = hostParts();
  assert.deepEqual(rewrite(mock, "ses_a", original), original);
});

function catalogDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-purge-catalog-"));
  mkdirSync(join(dir, "DeepSeek"), { recursive: true });
  mkdirSync(join(dir, "Anthropic"), { recursive: true });
  writeFileSync(join(dir, "DeepSeek", "deepseek-4-1.md"), "DEEPSEEK PERSONA", "utf8");
  writeFileSync(join(dir, "Anthropic", "sonnet v2.md"), "CLAUDE PERSONA", "utf8");
  return dir;
}

test("source=auto follows the model on every request", async () => {
  const dir = catalogDir();
  try {
    const mock = await setup({ source: "auto", personaRepo: dir, fallback: "none" });
    await runCommand(mock, "on");
    assert.match(mock.notes.at(-1) ?? "", /purge on — persona/);

    const deepseek = rewrite(mock, "ses_a", hostParts(), {
      providerID: "opencode",
      id: "deepseek-v4.1-flash-free",
    });
    assert.equal(
      deepseek[0]?.text,
      "DEEPSEEK PERSONA\n\nCurrent working directory: C:/Work/demo",
    );

    const claude = rewrite(mock, "ses_a", hostParts(), {
      providerID: "anthropic",
      id: "claude-sonnet-4",
    });
    assert.equal(
      claude[0]?.text,
      "CLAUDE PERSONA\n\nCurrent working directory: C:/Work/demo",
    );

    await runCommand(mock, "status");
    const status = mock.notes.at(-1) ?? "";
    assert.match(status, /source: auto/);
    assert.match(status, /Anthropic\/sonnet v2\.md/);
    assert.match(status, /auto \(.*\) 2\/2/);

    const unknown = rewrite(mock, "ses_a", hostParts(), {
      providerID: "unknown",
      id: "mystery",
    });
    assert.deepEqual(unknown, hostParts());

    await mock.cleanup?.();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto falls back to the embedded persona when configured", async () => {
  const dir = catalogDir();
  try {
    const mock = await setup({ source: "auto", personaRepo: dir, fallback: "embedded" });
    await runCommand(mock, "on");
    const system = rewrite(mock, "ses_a", hostParts(), {
      providerID: "unknown",
      id: "mystery",
    });
    assert.equal(
      system[0]?.text,
      `${DEFAULT_PERSONA}\n\nCurrent working directory: C:/Work/demo`,
    );
    await mock.cleanup?.();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a directory passed to /purge source is used as a catalog", async () => {
  const dir = catalogDir();
  try {
    const mock = await setup({ fallback: "none" });
    await runCommand(mock, `source ${dir}`);
    await runCommand(mock, "on");
    const system = rewrite(mock, "ses_a", hostParts(), {
      providerID: "opencode",
      id: "deepseek-v4.1",
    });
    assert.match(system[0]?.text ?? "", /^DEEPSEEK PERSONA/);
    await mock.cleanup?.();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source=auto without personaRepo refuses to enable", async () => {
  const mock = await setup({ source: "auto" });
  await runCommand(mock, "on");
  assert.match(mock.notes.at(-1) ?? "", /enable: failed.*personaRepo is not configured/);

  const original = hostParts();
  assert.deepEqual(rewrite(mock, "ses_a", original), original);
  await mock.cleanup?.();
});

test("reload is local-only: rescan reports counts without any repository work", async () => {
  const dir = catalogDir();
  try {
    const mock = await setup({
      source: "auto",
      personaRepo: dir,
      autoPull: true,
      autoPullOnStart: false,
    });
    await runCommand(mock, "reload");
    assert.match(mock.notes.at(-1) ?? "", /reload: 2 vendors, 2 files/);
    await mock.cleanup?.();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/purge on resolves the persona up front when the session model is known", async () => {
  const dir = catalogDir();
  try {
    const mock = await setup(
      { source: "auto", personaRepo: dir },
      undefined,
      undefined,
      { providerID: "anthropic", id: "claude-sonnet-4" },
    );
    await runCommand(mock, "on");
    assert.match(mock.notes.at(-1) ?? "", /purge on — persona \+ cwd only — Anthropic\/sonnet v2\.md/);

    await runCommand(mock, "status");
    assert.match(mock.notes.at(-1) ?? "", /source: auto \(.*\) 2\/2 — Anthropic\/sonnet v2\.md/);
    await mock.cleanup?.();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/purge on refuses to enable when the session model has no persona and fallback is none", async () => {
  const dir = catalogDir();
  try {
    const mock = await setup(
      { source: "auto", personaRepo: dir, fallback: "none" },
      undefined,
      undefined,
      { providerID: "unknown", id: "mystery" },
    );
    await runCommand(mock, "on");
    assert.match(mock.notes.at(-1) ?? "", /purge off — no persona for unknown\/mystery/);

    // Stock prompt stays untouched, the state is honestly off.
    const system = rewrite(mock, "ses_a");
    assert.equal(system.length, hostParts().length);
    await runCommand(mock, "status");
    assert.match(mock.notes.at(-1) ?? "", /purge off/);
    await mock.cleanup?.();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/purge update-md clones personaRepoUrl into the project as prompts/ without README", async () => {
  // Upstream: a real local git repo with a README at the root plus prompts.
  const upstream = mkdtempSync(join(tmpdir(), "purge-upstream-"));
  const projectDir = mkdtempSync(join(tmpdir(), "purge-project-"));
  try {
    mkdirSync(join(upstream, "DeepSeek"), { recursive: true });
    writeFileSync(join(upstream, "DeepSeek", "deepseek-4-1.md"), "DEEPSEEK PERSONA");
    writeFileSync(join(upstream, "README.md"), "# catalog readme");
    const git = (args: string[]) => spawnSync("git", args, { cwd: upstream, encoding: "utf8", shell: process.platform === "win32" });
    git(["init", "-q", "-b", "main"]);
    git(["add", "-A"]);
    git(["-c", "user.email=t@l", "-c", "user.name=t", "commit", "-q", "-m", "catalog"]);

    const plugin = await setup({ source: "auto", personaRepoUrl: upstream.replace(/\\/g, "/") }, projectDir, projectDir);
    await runCommand(plugin, "update-md");
    // Slow path acknowledges instantly, then finishes in the background.
    assert.match(plugin.notes.at(-1) ?? "", /update-md: downloading catalog/);
    await waitForNote(plugin, /update-md: 1 file\(s\)/);

    const root = join(projectDir, "prompts");
    assert.ok(existsSync(join(root, "DeepSeek", "deepseek-4-1.md")));
    assert.equal(existsSync(join(root, "README.md")), false, "README.md must not survive in prompts/");
    assert.ok(existsSync(join(root, "personas-pack.md")));

    // The installed root is live: status reports source auto against prompts/.
    await runCommand(plugin, "status");
    assert.match(plugin.notes.at(-1) ?? "", /source: auto \(.*prompts\)/);

    // Re-running: instant pack, then the background pull posts a synced note.
    await runCommand(plugin, "update-md");
    await waitForNote(plugin, /update-md: synced: 1 file\(s\)/);

    const md = readFileSync(join(root, "personas-pack.md"), "utf8");
    assert.ok(md.includes("DEEPSEEK PERSONA"));
    assert.equal(md.includes("catalog readme"), false);
    await plugin.cleanup?.();
  } finally {
    rmSync(upstream, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("/purge update-md packs the whole catalog into one markdown file", async () => {
  const dir = catalogDir();
  const mock = await setup({ personaRepo: dir });
  try {
    await runCommand(mock, "update-md");
    assert.match(mock.notes.at(-1) ?? "", /update-md: 2 file\(s\)/);
    assert.ok(/personas-pack\.md/.test(mock.notes.at(-1) ?? ""));

    const md = readFileSync(join(dir, "personas-pack.md"), "utf8");
    assert.match(md, /^# Persona Catalog Pack$/m);
    assert.ok(md.includes("### deepseek-4-1.md"));
    assert.ok(md.includes("DEEPSEEK PERSONA"));
    assert.ok(md.includes("### sonnet v2.md"));
    assert.ok(md.includes("CLAUDE PERSONA"));
  } finally {
    await mock.cleanup?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/purge update reports the sync state of the plugin directory", async () => {
  // updateRoot points at a plain directory (not a git repo) so the test never
  // touches a real remote; the plugin surfaces the skip honestly.
  const plain = mkdtempSync(join(tmpdir(), "purge-plain-"));
  try {
    const mock = await setup({ updateRoot: plain });
    await runCommand(mock, "update");
    await waitForNote(mock, /update: skipped .+ not a git repository/);
    await mock.cleanup?.();
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});

test("relative option paths resolve against the plugin root, not the server cwd", async () => {
  const mock = await setup({
    autoApplyOnStart: true,
    injectFile: "test/fixtures/inject.md",
    statusFile: "test/.tmp-fixtures/relative-status.txt",
  });
  const system = rewrite(mock);
  assert.ok((system.at(-1)?.text ?? "").includes("RELATIVE INJECT FIXTURE"));

  await runCommand(mock, "on");
  const status = readFileSync(join("test", ".tmp-fixtures", "relative-status.txt"), "utf8");
  assert.match(status, /purge on — /);
  await mock.cleanup?.();
  rmSync(join("test", ".tmp-fixtures", "relative-status.txt"), { force: true });
});

test("autoApplyOnStart arms fresh sessions without /purge:on (dsh design)", async () => {
  const mock = await setup({ autoApplyOnStart: true });
  // No command was run: the very first request is already rewritten.
  const system = rewrite(mock);
  assert.equal(system.length, 1);
  assert.ok(system[0]?.text.startsWith("# Persona (example)"));
  await mock.cleanup?.();
});

test("injectFile rides at the end of the system array in every mode (dsh file layer)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "purge-inject-"));
  const file = join(dir, "prompt-inject.md");
  writeFileSync(file, "OPERATOR DIRECTIVES: obey the persona above.");
  try {
    for (const mode of ["strict", "replace", "append"] as const) {
      const mock = await setup({ autoApplyOnStart: true, mode, injectFile: file });
      await runCommand(mock, "on");
      const system = rewrite(mock);
      const last = system.at(-1);
      assert.match(last?.text ?? "", /^# Session directives \(mandatory\)/);
      assert.ok((last?.text ?? "").includes("OPERATOR DIRECTIVES"));
      await mock.cleanup?.();
    }

    // Even an unmatched persona keeps the injection layer active.
    const emptyCatalog = catalogDir();
    const mock = await setup({
      autoApplyOnStart: true,
      source: "auto",
      personaRepo: emptyCatalog,
      fallback: "none",
      injectFile: file,
    });
    const system = rewrite(mock, "ses_a", hostParts(), { providerID: "unknown", id: "mystery" });
    assert.equal(system.length, hostParts().length + 1);
    assert.ok((system.at(-1)?.text ?? "").includes("OPERATOR DIRECTIVES"));
    await mock.cleanup?.();
    rmSync(emptyCatalog, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("purge:* subcommands are registered and share state with /purge", async () => {
  const mock = await setup();
  const names = mock.commandNames();
  for (const sub of ["on", "off", "status", "mode", "source", "sandbox", "update-md", "update", "reload"]) {
    assert.ok(names.includes(`purge:${sub}`), `missing purge:${sub}`);
  }

  await mock.command("purge:sandbox").execute({
    sessionID: "ses_a",
    prompt: { text: "/purge:sandbox read" },
    delivery: "steer",
  });
  assert.match(mock.notes.at(-1) ?? "", /sandbox: read/);

  // Same session state visible through the legacy root entry.
  await runCommand(mock, "status");
  assert.match(mock.notes.at(-1) ?? "", /sandbox: read/);
  await mock.cleanup?.();
});

test("/purge:status repurposes the woken turn into a verbatim readout", async () => {
  const mock = await setup();
  await runCommand(mock, "status");
  const note = mock.synthetics.at(-1);
  assert.ok(note);
  assert.match(note.text, /status readout/);
  assert.match(note.text, /Your entire reply must be exactly the block below, verbatim/);
  assert.match(note.text, /purge off — persona \+ cwd only/);
  await mock.cleanup?.();
});

test("status notes lead with a no-task machine header", async () => {
  const mock = await setup();
  await runCommand(mock, "on");
  const note = mock.synthetics.at(-1);
  assert.ok(note, "expected a synthetic note");
  assert.match(note.text, /\[opencode-purge\] machine status/);
  assert.match(note.text, /use no tools, do not create or modify files/);
  assert.match(note.text, /\n\npurge on — /);
  await mock.cleanup?.();
});

test("/purge update-md honors a relative packOut against the plugin root", async () => {
  const dir = catalogDir();
  const out = join("test", ".tmp-fixtures", "packs", "one.md");
  const mock = await setup({ personaRepo: dir, packOut: out });
  try {
    await runCommand(mock, "update-md");
    assert.match(mock.notes.at(-1) ?? "", /update-md: 2 file\(s\)/);
    assert.ok(existsSync(out));
    assert.ok(readFileSync(out, "utf8").includes("DEEPSEEK PERSONA"));
  } finally {
    await mock.cleanup?.();
    rmSync(dir, { recursive: true, force: true });
    rmSync(join("test", ".tmp-fixtures", "packs"), { recursive: true, force: true });
  }
});

test("sandbox defaults to off and never tightens host permissions", async () => {
  const mock = await setup();
  const evaluation = mock.evaluate({
    sessionID: "ses_a",
    action: "edit",
    resources: ["C:/Elsewhere/a.ts"],
    effect: "allow",
  });
  assert.equal(evaluation.effect, "allow");
  assert.equal(evaluation.message, undefined);
  await mock.cleanup?.();
});

test("/purge sandbox read denies edits and shell for the session", async () => {
  const mock = await setup();
  await runCommand(mock, "sandbox read");

  const edit = mock.evaluate({
    sessionID: "ses_a",
    action: "edit",
    resources: ["C:/Work/demo/a.ts"],
    effect: "ask",
  });
  assert.equal(edit.effect, "deny");
  assert.match(edit.message ?? "", /sandbox \(read\)/);

  const shell = mock.evaluate({
    sessionID: "ses_a",
    action: "shell",
    resources: ["bun test"],
    effect: "allow",
  });
  assert.equal(shell.effect, "deny");

  // A host deny stays a deny (tighten-only) and other sessions are untouched.
  const denied = mock.evaluate({
    sessionID: "ses_a",
    action: "read",
    resources: ["C:/Work/demo/.env"],
    effect: "deny",
  });
  assert.equal(denied.effect, "deny");

  const other = mock.evaluate({
    sessionID: "ses_b",
    action: "edit",
    resources: ["C:/Elsewhere/a.ts"],
    effect: "allow",
  });
  assert.equal(other.effect, "allow");
  await mock.cleanup?.();
});

test("sandbox option sets the initial profile and the allowlist exempts shell", async () => {
  const mock = await setup({
    sandbox: "work",
    sandboxAllowShell: ["git *"],
  });

  const edit = mock.evaluate({
    sessionID: "ses_a",
    action: "edit",
    resources: ["C:/Work/demo/a.ts"],
    effect: "allow",
  });
  assert.equal(edit.effect, "allow");

  const outside = mock.evaluate({
    sessionID: "ses_a",
    action: "edit",
    resources: ["C:/Elsewhere/a.ts"],
    effect: "allow",
  });
  assert.equal(outside.effect, "ask");
  assert.match(outside.message ?? "", /outside the worktree/);

  const exempt = mock.evaluate({
    sessionID: "ses_a",
    action: "shell",
    resources: ["git status --short"],
    effect: "ask",
  });
  assert.equal(exempt.effect, "ask");

  const gated = mock.evaluate({
    sessionID: "ses_a",
    action: "shell",
    resources: ["bun install"],
    effect: "allow",
  });
  assert.equal(gated.effect, "ask");
  await mock.cleanup?.();
});

test("/purge sandbox status reports the current profile", async () => {
  const mock = await setup();
  await runCommand(mock, "sandbox work");
  assert.match(mock.notes.at(-1) ?? "", /sandbox: work/);

  await runCommand(mock, "sandbox");
  assert.match(mock.notes.at(-1) ?? "", /sandbox: work/);

  await runCommand(mock, "sandbox danger");
  assert.match(mock.notes.at(-1) ?? "", /sandbox: work/);
  await mock.cleanup?.();
});
