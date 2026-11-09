/**
 * opencode-purge — pure sandbox-profile helpers.
 *
 * Free of I/O and of the OpenCode runtime, like purge.ts, so permission
 * decisions can be unit-tested without a host.
 *
 * A sandbox profile is a CEILING, not a grant: the evaluate hook only ever
 * tightens the effect the host already computed (allow < ask < deny), per
 * session, and restores stock behaviour when the profile is `off`.
 *
 *   off   -> host rules stay exactly as configured
 *   read  -> read-only session; edits and shell are denied outright
 *   work  -> edits inside the worktree, shell and network ask for approval
 *
 * An optional shell allowlist (`sandboxAllowShell` options entry) exempts
 * command patterns from an `ask`, but can never widen a host `deny`.
 */

export type SandboxProfile = "off" | "read" | "work";

export type Effect = "allow" | "deny" | "ask";

export const SANDBOX_PROFILES: readonly SandboxProfile[] = ["off", "read", "work"];

export const SANDBOX_LABELS: Record<SandboxProfile, string> = {
  off: "off — host permission rules, untouched",
  read: "read — read-only: edits and shell denied, network asks",
  work: "work — edits limited to the worktree, shell and network ask for approval",
};

export interface SandboxCheck {
  action: string;
  resources: readonly string[];
  cwd: string;
}

export interface SandboxDecision {
  effect: Effect;
  message?: string;
}

const STRENGTH: Record<Effect, number> = { allow: 0, ask: 1, deny: 2 };

/** Combine two effects into the stricter one (deny > ask > allow). */
export function tighten(current: Effect, proposed: Effect): Effect {
  return STRENGTH[proposed] > STRENGTH[current] ? proposed : current;
}

export function isEffect(value: string): value is Effect {
  return value === "allow" || value === "deny" || value === "ask";
}

export function isSandboxProfile(value: string): value is SandboxProfile {
  return (SANDBOX_PROFILES as readonly string[]).includes(value);
}

export function sandboxLabel(profile: SandboxProfile): string {
  return SANDBOX_LABELS[profile];
}

/** Whole-value wildcard match: `*` spans everything, `?` exactly one char. */
export function matches(pattern: string, value: string): boolean {
  const raw = String(pattern ?? "").trim();
  const target = String(value ?? "").trim();
  if (!raw) return false;

  // A shell pattern ending in " *" matches the bare command word and any
  // continuation that starts with a space, mirroring OpenCode's shell prefix
  // rule ("git status *" matches "git status" and "git status --short", but
  // not "git statusx").
  let body = raw;
  let wordBoundary = false;
  if (body.endsWith(" *")) {
    body = body.slice(0, -2);
    wordBoundary = true;
  }

  let regex = "";
  for (const character of body) {
    if (character === "*") regex += "[\\s\\S]*";
    else if (character === "?") regex += ".";
    else regex += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  // A trailing wildcard already spans spaces, so only the space boundary form
  // needs the tail extension.
  const matcher = new RegExp(`^${regex}${wordBoundary ? "(?:[\\s][\\s\\S]*)?" : ""}$`, "i");
  return matcher.test(target);
}

function isInsideWorktree(resource: string, cwd: string): boolean {
  if (!cwd) return false;
  const path = resource.replace(/\\/g, "/");
  const root = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!path || !root) return false;
  if (path.startsWith("~/") || /^[a-zA-Z]:\//.test(path)) {
    return path === root || path.startsWith(`${root}/`);
  }
  // Workspace-relative paths are inside only if they never climb out.
  if (path.startsWith("/")) return false;
  return !path.split("/").includes("..");
}

const READ_ONLY_ACTIONS = new Set([
  "read",
  "glob",
  "grep",
  "question",
  "opencode_list_mcp_resources",
]);

const NETWORK_ACTIONS = new Set(["webfetch", "websearch"]);

/** Every action that mutates files shares the edit branch semantics. */
const EDIT_ACTIONS = new Set(["edit", "write", "patch"]);

const blocked = (effect: Effect): string => (effect === "deny" ? "is denied" : "requires approval");

/** Base effect per action for each profile; anything unlisted uses `defaultEffect`. */
interface ProfileSpec {
  defaultEffect: Effect;
  editWithin: Effect;
  editOutside: Effect;
  byAction: Partial<Record<string, Effect>>;
}

const PROFILE_SPECS: Record<Exclude<SandboxProfile, "off">, ProfileSpec> = {
  read: {
    defaultEffect: "ask",
    editWithin: "deny",
    editOutside: "deny",
    byAction: {
      edit: "deny",
      write: "deny",
      patch: "deny",
      shell: "deny",
      execute: "deny",
      external_directory: "deny",
      skill: "ask",
      subagent: "ask",
    },
  },
  work: {
    defaultEffect: "ask",
    editWithin: "allow",
    editOutside: "ask",
    byAction: {},
  },
};

function strongest(current: Effect, candidate: Effect): Effect {
  return tighten(current, candidate);
}

/**
 * Decide the sandbox effect for one permission evaluation.
 * Compound resources (a shell line with several subcommands, a patch touching
 * several files) aggregate to the strictest resource-level decision.
 */
export function sandboxDecision(
  profile: SandboxProfile,
  check: SandboxCheck,
  options: { allowShell?: readonly string[] } = {},
): SandboxDecision {
  if (profile === "off") return { effect: "allow" };

  const spec = PROFILE_SPECS[profile];
  const cwd = check.cwd.replace(/\\/g, "/");

  if (check.resources.length === 0) {
    // No resource to inspect: the action's own rule applies, never the laxer
    // profile default (a read-profile edit without a path is still a deny).
    const effect = spec.byAction[check.action] ?? spec.defaultEffect;
    return {
      effect,
      message: `opencode-purge sandbox (${profile}): ${check.action} ${blocked(effect)}`,
    };
  }

  let effect: Effect = "allow";
  let reason = "";
  for (const resource of check.resources) {
    let candidate: Effect = spec.defaultEffect;
    let message = "";

    if (EDIT_ACTIONS.has(check.action)) {
      const inside = isInsideWorktree(resource, cwd);
      candidate = inside ? spec.editWithin : spec.editOutside;
      if (candidate !== "allow") {
        message = inside
          ? `opencode-purge sandbox (${profile}): edit requires approval`
          : `opencode-purge sandbox (${profile}): ${resource} is outside the worktree`;
      }
    } else if (check.action === "shell" && options.allowShell?.length) {
      const base = spec.byAction.shell ?? spec.defaultEffect;
      // The allowlist may only skip an `ask`; a profile `deny` is final.
      const exempt = base !== "deny" && options.allowShell.some((pattern) => matches(pattern, resource));
      if (exempt) {
        candidate = "allow";
      } else {
        candidate = base;
        message = `opencode-purge sandbox (${profile}): shell ${blocked(candidate)} — ${resource}`;
      }
    } else if (READ_ONLY_ACTIONS.has(check.action)) {
      candidate = "allow";
    } else if (NETWORK_ACTIONS.has(check.action)) {
      candidate = "ask";
      message = `opencode-purge sandbox (${profile}): network access requires approval — ${resource}`;
    } else if (spec.byAction[check.action] !== undefined) {
      const listed = spec.byAction[check.action] as Effect;
      candidate = listed;
      if (listed !== "allow") {
        message = `opencode-purge sandbox (${profile}): ${check.action} ${blocked(listed)}`;
      }
    }

    if (STRENGTH[candidate] > STRENGTH[effect]) {
      effect = candidate;
      reason = message;
    }
  }

  return { effect, message: effect === "allow" ? undefined : reason || `opencode-purge sandbox (${profile})` };
}
