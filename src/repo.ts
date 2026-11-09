/**
 * opencode-purge — opt-in sync for the persona catalog repository.
 *
 * This never touches the OpenCode install. It only runs `git clone`/`git pull`
 * against the directory configured as `personaRepo`, and it refuses to pull
 * when tracked files have local changes (README.md is excluded — update-md
 * deletes it deliberately).
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type PullState = "idle" | "pulling" | "ok" | "skipped" | "error";

export interface RepoStatus {
  state: PullState;
  at: number;
  message: string;
}

const IDLE: RepoStatus = { state: "idle", at: 0, message: "" };

function run(
  command: string,
  args: string[],
  timeout: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = error as Error & { stdout?: string; stderr?: string };
          detail.stdout = String(stdout);
          detail.stderr = String(stderr);
          reject(detail);
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

export class PersonaRepo {
  status: RepoStatus = IDLE;
  private current: Promise<RepoStatus> | null = null;

  constructor(
    readonly root: string,
    readonly url: string,
    readonly enabled: boolean,
    private readonly kind = "personaRepo",
  ) {}

  /** Pull (or clone) once. Concurrent calls share one operation. */
  sync(): Promise<RepoStatus> {
    if (!this.enabled) return Promise.resolve(this.status);
    if (this.current) return this.current;

    this.current = this.pull().finally(() => {
      this.current = null;
    });
    return this.current;
  }

  private async pull(): Promise<RepoStatus> {
    this.status = { state: "pulling", at: Date.now(), message: "" };

    try {
      if (!existsSync(this.root)) {
        if (!this.url) throw new Error("personaRepo is missing and personaRepoUrl is empty");
        await run("git", ["clone", "--depth", "1", this.url, this.root], 120_000);
        this.status = {
          state: "ok",
          at: Date.now(),
          message: `cloned ${this.url}`,
        };
        return this.status;
      }

      if (!existsSync(join(this.root, ".git"))) {
        this.status = {
          state: "skipped",
          at: Date.now(),
          message: `${this.kind} is not a git repository`,
        };
        return this.status;
      }

      const dirty = await run(
        "git",
        ["-C", this.root, "status", "--porcelain", "--untracked-files=no", "--", ".", ":(exclude)README.md"],
        30_000,
      );
      if (dirty.stdout.trim().length > 0) {
        this.status = {
          state: "skipped",
          at: Date.now(),
          message: "tracked files have local changes",
        };
        return this.status;
      }

      const result = await run(
        "git",
        ["-C", this.root, "pull", "--ff-only", "--quiet"],
        120_000,
      );
      const lastLine =
        (result.stdout || result.stderr).trim().split(/\r?\n/).filter(Boolean).at(-1) ??
        "up to date";
      this.status = { state: "ok", at: Date.now(), message: lastLine };
      return this.status;
    } catch (error) {
      const detail =
        (error as { stderr?: string }).stderr ||
        (error as Error).message ||
        String(error);
      this.status = {
        state: "error",
        at: Date.now(),
        message: detail.trim().slice(0, 400),
      };
      return this.status;
    }
  }
}
