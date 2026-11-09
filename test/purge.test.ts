import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_PERSONA,
  EMPTY_CUT,
  composeSystem,
  isMode,
  normalizeCwd,
  parseCommand,
  stripDocsSection,
  stripIdentityLine,
} from "../src/purge.ts";

/**
 * Point OPENCODE_SRC at a clone of https://github.com/anomalyco/opencode to
 * run the anchor tests against the real V2 prompt files:
 *
 *   OPENCODE_SRC=/path/to/opencode bun test
 *
 * Without it, only the synthetic tests run.
 */
const SRC = process.env.OPENCODE_SRC?.trim() || "";

function realPrompt(relative: string): string | null {
  if (!SRC) return null;
  const file = join(SRC, relative);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

const IDENTITY_FILES = [
  "packages/core/src/session/runner/prompt/system.txt",
  "packages/core/src/plugin/system-prompt/gpt.txt",
  "packages/core/src/plugin/system-prompt/gpt-astra.txt",
  "packages/core/src/plugin/system-prompt/kimi.txt",
  "packages/core/src/plugin/system-prompt/meta.txt",
  "packages/core/src/plugin/system-prompt/trinity.txt",
];

for (const relative of IDENTITY_FILES) {
  test(`stripIdentityLine removes the real V2 identity in ${relative}`, { skip: !SRC }, () => {
    const prompt = realPrompt(relative);
    assert.ok(prompt, `missing fixture under OPENCODE_SRC: ${relative}`);
    const result = stripIdentityLine(prompt);
    assert.equal(result.identity, true);
    assert.ok(!result.text.trimStart().startsWith("You are"), "identity line still present");
  });
}

test("the Claude style fragment is not treated as identity", { skip: !SRC }, () => {
  const prompt = realPrompt("packages/core/src/plugin/system-prompt/anthropic.txt");
  assert.ok(prompt);
  const result = stripIdentityLine(prompt);
  assert.equal(result.identity, false);
  assert.equal(result.text, prompt);
});

test("parseCommand handles every documented form", () => {
  assert.deepEqual(parseCommand(""), { cmd: "", arg: "" });
  assert.deepEqual(parseCommand("/purge"), { cmd: "", arg: "" });
  assert.deepEqual(parseCommand("on"), { cmd: "on", arg: "" });
  assert.deepEqual(parseCommand("/purge mode replace"), { cmd: "mode", arg: "replace" });
  assert.deepEqual(parseCommand("purge source C:/prompts/me.md"), {
    cmd: "source",
    arg: "C:/prompts/me.md",
  });
  assert.deepEqual(parseCommand("/purge reload"), { cmd: "reload", arg: "" });
});

test("isMode only accepts the three modes", () => {
  assert.equal(isMode("append"), true);
  assert.equal(isMode("replace"), true);
  assert.equal(isMode("strict"), true);
  assert.equal(isMode("Strict"), false);
  assert.equal(isMode("nope"), false);
});

test("normalizeCwd uses forward slashes", () => {
  assert.equal(normalizeCwd("C:\\Work\\demo"), "C:/Work/demo");
});

function hostParts() {
  const main = [
    "You are an AI agent running in OpenCode, a coding agent harness. Help the user accomplish their goals using the tools you have available.",
    "",
    "# Harness",
    "- Responses are rendered as GitHub-flavored Markdown.",
    "${OPENCODE_TOOL_GUIDANCE}",
    "",
    "# Communication",
    "- Keep responses clear and concise.",
    "",
  ].join("\n");

  return [
    { type: "text" as const, text: main },
    { type: "text" as const, text: "# Your Model\n- Name: Test Model" },
    {
      type: "text" as const,
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

test("append prepends the persona and leaves host parts untouched", () => {
  const parts = hostParts();
  const result = composeSystem(parts, {
    mode: "append",
    persona: "PERSONA",
    cwd: "C:\\Work\\demo",
    now: 1,
  });

  assert.equal(result.parts.length, parts.length + 1);
  assert.deepEqual(result.parts[0], { type: "text", text: "PERSONA" });
  assert.deepEqual(result.parts.slice(1), parts);
  assert.deepEqual(result.cut, EMPTY_CUT);
});

test("replace removes identity and keeps harness, model, and instruction parts", () => {
  const parts = hostParts();
  const result = composeSystem(parts, {
    mode: "replace",
    persona: "PERSONA",
    cwd: "C:\\Work\\demo",
    now: 42,
  });

  assert.equal(result.parts.length, parts.length + 1);
  const [persona, main, model, instructions] = result.parts as Array<{
    type: string;
    text: string;
    metadata?: unknown;
  }>;

  assert.ok(persona);
  assert.ok(main);
  assert.ok(model);
  assert.ok(instructions);

  assert.equal(persona.text, "PERSONA");
  assert.ok(!main.text.includes("You are an AI agent running in OpenCode"));
  assert.ok(main.text.includes("# Harness"));
  assert.ok(main.text.includes("${OPENCODE_TOOL_GUIDANCE}"));
  assert.equal(model.text, "# Your Model\n- Name: Test Model");
  assert.deepEqual(instructions.metadata, parts[2]?.metadata);
  assert.deepEqual(result.cut, { identity: true, docs: false, at: 42 });
});

test("strict sends only the persona and the working directory", () => {
  const parts = hostParts();
  const result = composeSystem(parts, {
    mode: "strict",
    persona: "PERSONA",
    cwd: "C:\\Work\\demo",
    now: 7,
  });

  assert.equal(result.parts.length, 1);
  assert.equal(
    (result.parts[0] as { text: string }).text,
    "PERSONA\n\nCurrent working directory: C:/Work/demo",
  );
  assert.deepEqual(result.cut, { identity: true, docs: false, at: 7 });
});

test("an unrecognised prompt is left byte-for-byte unchanged in replace mode", () => {
  const parts = [{ type: "text" as const, text: "# Custom\nNo host identity here." }];
  const result = composeSystem(parts, {
    mode: "replace",
    persona: "PERSONA",
    cwd: "C:/Work/demo",
    now: 1,
  });

  assert.equal(result.parts.length, 2);
  assert.equal((result.parts[1] as { text: string }).text, parts[0]?.text);
  assert.equal(result.cut.identity, false);
  assert.equal(result.cut.docs, false);
});

test("docs section is cut only when both anchors exist", () => {
  const complete = [
    "# Prompt",
    "",
    "# OpenCode documentation",
    "Internal docs that should not reach the model.",
    "",
    "# Next section",
    "kept",
  ].join("\n");

  const cut = stripDocsSection(complete);
  assert.equal(cut.docs, true);
  assert.ok(!cut.text.includes("Internal docs"));
  assert.ok(cut.text.includes("# Next section"));

  const unterminated = "# OpenCode documentation\nno end anchor";
  const safe = stripDocsSection(unterminated);
  assert.equal(safe.docs, false);
  assert.equal(safe.text, unterminated);
});

test("empty persona never changes the prompt", () => {
  const parts = hostParts();
  const result = composeSystem(parts, { mode: "strict", persona: "   ", cwd: "C:/x" });
  assert.deepEqual(result.parts, parts);
  assert.deepEqual(result.cut, EMPTY_CUT);
});

test("the bundled persona is non-empty", () => {
  assert.ok(DEFAULT_PERSONA.trim().length > 0);
  assert.ok(DEFAULT_PERSONA.includes("/purge source"));
});
