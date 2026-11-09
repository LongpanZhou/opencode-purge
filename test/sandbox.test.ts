import test from "node:test";
import assert from "node:assert/strict";
import {
  isEffect,
  isSandboxProfile,
  matches,
  sandboxDecision,
  sandboxLabel,
  tighten,
} from "../src/sandbox.ts";

test("isSandboxProfile only accepts the three profiles", () => {
  for (const profile of ["off", "read", "work"]) {
    assert.equal(isSandboxProfile(profile), true);
    assert.equal(isSandboxProfile(profile.toUpperCase()), false);
  }
  assert.equal(isSandboxProfile("danger"), false);
});

test("sandboxLabel describes every profile", () => {
  assert.match(sandboxLabel("off"), /untouched/);
  assert.match(sandboxLabel("read"), /read-only/);
  assert.match(sandboxLabel("work"), /worktree/);
});

test("tighten keeps the stricter effect", () => {
  assert.equal(tighten("allow", "ask"), "ask");
  assert.equal(tighten("ask", "allow"), "ask");
  assert.equal(tighten("ask", "deny"), "deny");
  assert.equal(tighten("deny", "allow"), "deny");
  assert.equal(tighten("allow", "allow"), "allow");
});

test("isEffect is exact", () => {
  assert.equal(isEffect("allow"), true);
  assert.equal(isEffect("ask"), true);
  assert.equal(isEffect("deny"), true);
  assert.equal(isEffect("Allow"), false);
  assert.equal(isEffect(""), false);
});

test("matches uses whole-value wildcards like the host", () => {
  assert.equal(matches("git status *", "git status --short"), true);
  assert.equal(matches("git status *", "git status"), true);
  assert.equal(matches("git status *", "git statusx"), false);
  assert.equal(matches("rm *", "rm -rf /tmp/x"), true);
  // `*` spans path separators on whole values, so a bare `*.env` rule
  // covers nested .env files too (matching OpenCode's own examples).
  assert.equal(matches("*.env", ".env"), true);
  assert.equal(matches("*.env", "config/.env"), true);
  assert.equal(matches("config/*.env", "deep/config/.env"), false);
  assert.equal(matches("c:*", "C:/Work/demo"), true);
  assert.equal(matches("c:*", "c:anything"), true);
  assert.equal(matches("c:/*", "Work"), false);
  assert.equal(matches("c:?andom", "c:Kandom"), true);
  assert.equal(matches("GIT *", "git status"), true);
});

test("sandbox off never tightens", () => {
  const decision = sandboxDecision("off", { action: "shell", resources: ["rm -rf /"], cwd: "" });
  assert.equal(decision.effect, "allow");
});

test("read profile is read-only", () => {
  const cwd = "C:/Work/demo";
  assert.equal(sandboxDecision("read", { action: "edit", resources: ["C:/Work/demo/a.ts"], cwd }, ).effect, "deny");
  assert.equal(sandboxDecision("read", { action: "edit", resources: ["C:/Elsewhere/a.ts"], cwd }).effect, "deny");
  assert.equal(sandboxDecision("read", { action: "shell", resources: ["bun test"], cwd }).effect, "deny");
  assert.equal(sandboxDecision("read", { action: "read", resources: ["C:/Work/demo/a.ts"], cwd }).effect, "allow");
  assert.equal(sandboxDecision("read", { action: "glob", resources: ["*"], cwd }).effect, "allow");
  assert.equal(sandboxDecision("read", { action: "webfetch", resources: ["https://example.com"], cwd }).effect, "ask");
  assert.equal(sandboxDecision("read", { action: "subagent", resources: ["explore"], cwd }).effect, "ask");
  assert.equal(sandboxDecision("read", { action: "custom_tool", resources: ["*"], cwd }).effect, "ask");
});

test("work profile allows worktree edits and gates the rest", () => {
  const cwd = "C:/Work/demo";
  assert.equal(sandboxDecision("work", { action: "edit", resources: ["C:/Work/demo/a.ts"], cwd }).effect, "allow");
  assert.equal(sandboxDecision("work", { action: "edit", resources: ["src/a.ts"], cwd }).effect, "allow");
  assert.equal(sandboxDecision("work", { action: "edit", resources: ["C:/Elsewhere/a.ts"], cwd }).effect, "ask");
  assert.equal(sandboxDecision("work", { action: "shell", resources: ["bun test"], cwd }).effect, "ask");
  assert.equal(sandboxDecision("work", { action: "websearch", resources: ["query"], cwd }).effect, "ask");
  assert.equal(sandboxDecision("work", { action: "question", resources: ["*"], cwd }).effect, "allow");
  assert.equal(sandboxDecision("work", { action: "custom_tool", resources: ["*"], cwd }).effect, "ask");
});

test("work profile gates absolute paths strictly when cwd is unknown", () => {
  assert.equal(
    sandboxDecision("work", { action: "edit", resources: ["C:/Elsewhere/a.ts"], cwd: "" }).effect,
    "ask",
  );
});

test("the shell allowlist may skip an ask but never a deny", () => {
  const cwd = "C:/Work/demo";
  const options = { allowShell: ["git *", "bun *"] };
  assert.equal(sandboxDecision("work", { action: "shell", resources: ["git status --short"], cwd }, options).effect, "allow");
  assert.equal(sandboxDecision("work", { action: "shell", resources: ["bun test"], cwd }, options).effect, "allow");
  assert.equal(sandboxDecision("work", { action: "shell", resources: ["pip install x"], cwd }, options).effect, "ask");

  // read denies shell outright — the allowlist cannot upgrade a deny.
  const readOptions = { allowShell: ["git *"] };
  assert.equal(sandboxDecision("read", { action: "shell", resources: ["git status"], cwd }, readOptions).effect, "deny");
  assert.equal(sandboxDecision("read", { action: "shell", resources: ["rm x"], cwd }, readOptions).effect, "deny");
});

test("empty resources fall back to the action rule, not the profile default", () => {
  assert.equal(sandboxDecision("read", { action: "edit", resources: [], cwd: "C:/Work/demo" }).effect, "deny");
  assert.equal(sandboxDecision("read", { action: "shell", resources: [], cwd: "C:/Work/demo" }).effect, "deny");
  assert.equal(sandboxDecision("work", { action: "shell", resources: [], cwd: "C:/Work/demo" }).effect, "ask");
});

test("relative paths that climb out of the worktree count as outside", () => {
  assert.equal(sandboxDecision("work", { action: "edit", resources: ["../outside/file"], cwd: "C:/Work/demo" }).effect, "ask");
  assert.equal(sandboxDecision("work", { action: "edit", resources: ["src/../../x"], cwd: "C:/Work/demo" }).effect, "ask");
  assert.equal(sandboxDecision("work", { action: "edit", resources: ["src/a.ts"], cwd: "C:/Work/demo" }).effect, "allow");
});

test("write and patch share the edit rules", () => {
  assert.equal(sandboxDecision("read", { action: "write", resources: ["C:/Work/demo/a.ts"], cwd: "C:/Work/demo" }).effect, "deny");
  assert.equal(sandboxDecision("read", { action: "patch", resources: ["C:/Work/demo/a.ts"], cwd: "C:/Work/demo" }).effect, "deny");
  assert.equal(sandboxDecision("work", { action: "write", resources: ["C:/Work/demo/a.ts"], cwd: "C:/Work/demo" }).effect, "allow");
});

test("compound resources aggregate to the strictest decision", () => {
  const cwd = "C:/Work/demo";
  const decision = sandboxDecision(
    "work",
    { action: "edit", resources: ["src/a.ts", "C:/Elsewhere/a.ts"], cwd },
  );
  assert.equal(decision.effect, "ask");
  assert.match(decision.message ?? "", /outside the worktree/);

  const shell = sandboxDecision(
    "work",
    { action: "shell", resources: ["git status", "curl example.com"], cwd },
  );
  assert.equal(shell.effect, "ask");
});

test("tightened decisions carry a message", () => {
  const decision = sandboxDecision("read", { action: "shell", resources: ["ls"], cwd: "" });
  assert.notEqual(decision.message, undefined);

  const allowed = sandboxDecision("work", { action: "edit", resources: ["src/a.ts"], cwd: "C:/Work/demo" });
  assert.equal(allowed.message, undefined);
});
