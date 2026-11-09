/**
 * opencode-purge — pure prompt-surgery helpers.
 *
 * Everything in this file is free of I/O and of the OpenCode runtime so it can
 * be unit-tested. `src/index.ts` wires it into the V2 plugin API.
 *
 * The mechanism is ported from pi-purge (which itself credits dsh-purge):
 * instead of drowning out the harness identity, remove it.
 *
 *   append  -> persona prepended to the host prompt, host untouched
 *   replace -> persona prepended to the host prompt with the identity line and
 *              the OpenCode documentation block removed (fail-safe anchors)
 *   strict  -> persona + working directory only; the host prompt is discarded
 */

export type Mode = "append" | "replace" | "strict";

export const MODES: readonly Mode[] = ["append", "replace", "strict"];

/** Minimal structural shape of an OpenCode V2 system part. */
export interface TextPart {
  type: "text";
  text: string;
}

export interface CutReport {
  identity: boolean;
  docs: boolean;
  /** 0 means "no turn has been rewritten yet" (append mode never sets it). */
  at: number;
}

export const EMPTY_CUT: CutReport = { identity: false, docs: false, at: 0 };

export const EMBEDDED = "embedded";

/**
 * Bundled example persona. Deliberately minimal: a fresh install must work
 * without any external file, and the real persona belongs on disk.
 */
export const DEFAULT_PERSONA = [
  "# Persona (example)",
  "",
  "You are a helpful assistant running inside OpenCode. Answer the user's request",
  "directly and keep responses concise.",
  "",
  "This text is only a placeholder bundled with opencode-purge, so that a fresh",
  "install works immediately: /purge swaps the system prompt for this text plus",
  "the working directory, and /purge off restores OpenCode's own prompt.",
  "",
  "To run your own instructions instead:",
  "",
  "    /purge source /absolute/path/to/your-prompt.md",
  "",
  "and /purge source embedded comes back to this example.",
].join("\n");

/**
 * OpenCode ships a different prompt per model family (see its embedded
 * prompts). Each starts with an identity line. These patterns only match at
 * the beginning of a system part, so ordinary prose further down is safe.
 */
const IDENTITY_PATTERNS: readonly RegExp[] = [
  /^\s*You are an AI agent running in OpenCode\b[^\n]*/i,
  /^\s*You are an AI agent powered by OpenCode\b[^\n]*/i,
  /^\s*You are OpenCode,? an interactive general AI agent\b[^\n]*/i,
  /^\s*You are OpenCode,? an interactive CLI\b[^\n]*/i,
  /^\s*You are OpenCode,? you and the user\b[^\n]*/i,
  /^\s*You are OpenCode,? a coding agent\b[^\n]*/i,
  /^\s*You are opencode,? an interactive CLI\b[^\n]*/i,
  /^\s*You are a code reviewer\b[^\n]*/i,
  /^\s*You are a file search specialist\b[^\n]*/i,
];

/** Heading that starts an OpenCode documentation block, if a build ships one. */
const DOCS_HEADING = /^#{1,6}[ \t]*OpenCode documentation\b[^\n]*$/im;
/** Any following Markdown heading ends the block. */
const NEXT_HEADING = /^#{1,6}[ \t]+\S[^\n]*$/m;

/**
 * Remove a leading host-identity line.
 * Returns the input unchanged when the opener is not recognised, so a future
 * OpenCode wording degrades to "identity not matched" instead of mangling text.
 */
export function stripIdentityLine(text: string): { text: string; identity: boolean } {
  for (const pattern of IDENTITY_PATTERNS) {
    const match = pattern.exec(text);
    if (!match || match.index !== 0) continue;
    const rest = text.slice(match[0].length).replace(/^(?:[ \t]*\r?\n)+/, "");
    return { text: rest, identity: true };
  }
  return { text, identity: false };
}

/**
 * Remove an "OpenCode documentation" section.
 * Both the start and the end anchor must exist. If the block is unterminated,
 * the text is left alone rather than cutting to the end of the prompt.
 */
export function stripDocsSection(text: string): { text: string; docs: boolean } {
  const start = DOCS_HEADING.exec(text);
  if (!start) return { text, docs: false };

  const afterHeading = start.index + start[0].length;
  const rest = text.slice(afterHeading);
  const end = NEXT_HEADING.exec(rest);
  if (!end) return { text, docs: false };

  const cutStart = start.index;
  const cutEnd = afterHeading + end.index;
  const out = `${text.slice(0, cutStart)}${text.slice(cutEnd)}`.replace(/\n{3,}/g, "\n\n");
  return { text: out, docs: true };
}

/** Apply both anchors to every system part and report what actually matched. */
export function stripHostFraming<T extends TextPart>(
  parts: readonly T[],
): { parts: T[]; cut: { identity: boolean; docs: boolean } } {
  let identity = false;
  let docs = false;

  const out: T[] = [];
  for (const part of parts) {
    let text = part.text;
    const identityCut = stripIdentityLine(text);
    text = identityCut.text;
    identity ||= identityCut.identity;

    const docsCut = stripDocsSection(text);
    text = docsCut.text;
    docs ||= docsCut.docs;

    if (text.trim().length === 0) continue;
    out.push(text === part.text ? part : ({ ...part, text } as T));
  }

  return { parts: out, cut: { identity, docs } };
}

export function normalizeCwd(cwd: string): string {
  return String(cwd ?? "").replace(/\\/g, "/");
}

/** persona + the one line that remains in strict mode, exactly like pi-purge. */
export function strictPrompt(persona: string, cwd: string): string {
  const body = persona.trim();
  const dir = normalizeCwd(cwd);
  return dir ? `${body}\n\nCurrent working directory: ${dir}` : body;
}

export interface ComposeOptions {
  mode: Mode;
  persona: string;
  cwd: string;
  /** Injectable clock for deterministic tests. */
  now?: number;
}

export interface ComposeResult<T extends TextPart> {
  parts: Array<T | TextPart>;
  cut: CutReport;
}

/**
 * Build the system parts for one model request.
 *
 * - The input array is never mutated.
 * - `append` does not touch host text and leaves the cut report empty, matching
 *   pi-purge (whose status then says "no turn has run yet").
 * - `replace` reports which anchors matched.
 * - `strict` reports the anchors found in the host prompt but discards it.
 */
export function composeSystem<T extends TextPart>(
  parts: readonly T[],
  options: ComposeOptions,
): ComposeResult<T> {
  const persona = String(options.persona ?? "").trim();
  const now = options.now ?? Date.now();

  if (!persona) {
    return { parts: [...parts], cut: { identity: false, docs: false, at: 0 } };
  }

  if (options.mode === "append") {
    return {
      parts: [{ type: "text", text: persona }, ...parts],
      cut: { identity: false, docs: false, at: 0 },
    };
  }

  const framed = stripHostFraming(parts);
  const cut: CutReport = { ...framed.cut, at: now };

  if (options.mode === "strict") {
    return {
      parts: [{ type: "text", text: strictPrompt(persona, options.cwd) }],
      cut,
    };
  }

  return {
    parts: [{ type: "text", text: persona }, ...framed.parts],
    cut,
  };
}

/** Parse the text a `/purge ...` command receives. */
export function parseCommand(text: string): { cmd: string; arg: string } {
  const raw = String(text ?? "").trim();
  const stripped = raw
    .replace(/^\/purge\b/i, "")
    .replace(/^purge\b/i, "")
    .trim();
  const [cmd = "", ...rest] = stripped.split(/\s+/).filter(Boolean);
  return { cmd: cmd.toLowerCase(), arg: rest.join(" ") };
}

export function isMode(value: string): value is Mode {
  return (MODES as readonly string[]).includes(value);
}
