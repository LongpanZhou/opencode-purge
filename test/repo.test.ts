import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersonaRepo } from "../src/repo.ts";

let hasGit = true;
try {
  execFileSync("git", ["--version"], { stdio: "ignore" });
} catch {
  hasGit = false;
}

function git(cwd: string, ...args: string[]): string {
  return String(
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  ).trim();
}

test("PersonaRepo clones, pulls fast-forward updates, and skips dirty trees", { skip: !hasGit }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-purge-repo-"));
  try {
    git(dir, "init", "--bare", "remote.git");
    git(dir, "clone", "remote.git", "seed");

    const seed = join(dir, "seed");
    git(seed, "config", "user.email", "test@example.com");
    git(seed, "config", "user.name", "Test");
    writeFileSync(join(seed, "persona.md"), "one", "utf8");
    git(seed, "add", "persona.md");
    git(seed, "commit", "-m", "one");
    git(seed, "push", "origin", "HEAD");

    git(dir, "clone", "remote.git", "persona");
    const persona = join(dir, "persona");
    assert.equal(readFileSync(join(persona, "persona.md"), "utf8"), "one");

    writeFileSync(join(seed, "persona.md"), "two", "utf8");
    git(seed, "add", "persona.md");
    git(seed, "commit", "-m", "two");
    git(seed, "push", "origin", "HEAD");

    const repo = new PersonaRepo(persona, "", true);
    const pulled = await repo.sync();
    assert.equal(pulled.state, "ok", pulled.message);
    assert.equal(readFileSync(join(persona, "persona.md"), "utf8"), "two");

    writeFileSync(join(persona, "persona.md"), "local", "utf8");
    const dirty = await repo.sync();
    assert.equal(dirty.state, "skipped");
    assert.equal(readFileSync(join(persona, "persona.md"), "utf8"), "local");

    // A missing root with a URL is cloned instead.
    const fresh = new PersonaRepo(join(dir, "fresh"), join(dir, "remote.git"), true);
    const cloned = await fresh.sync();
    assert.equal(cloned.state, "ok", cloned.message);
    assert.equal(readFileSync(join(dir, "fresh", "persona.md"), "utf8"), "two");

    // A plain directory is never touched.
    const plain = join(dir, "plain");
    mkdirSync(plain);
    const skipped = await new PersonaRepo(plain, "", true).sync();
    assert.equal(skipped.state, "skipped");
    assert.match(skipped.message, /not a git repository/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PersonaRepo is inert when disabled", { skip: !hasGit }, async () => {
  const repo = new PersonaRepo("C:/does/not/exist", "https://example.invalid/repo.git", false);
  const status = await repo.sync();
  assert.equal(status.state, "idle");
});
