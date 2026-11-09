import { describe, expect } from "bun:test"
import { SystemPart } from "@opencode/ai/effect"
import { Agent } from "@opencode/core/agent"
import { Command } from "@opencode/core/command"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginHost } from "@opencode/core/plugin/host"
import { SessionSystemPrompt } from "@opencode/core/session/system-prompt"
import { Provider } from "@opencode/core/provider"
import { fromPromise } from "@opencode/plugin/promise/adapter"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Model } from "@opencode/schema/model"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"
import purger from "__PLUGIN_IMPORT__"

const it = testEffect(PluginTestLayer)

const makeHost = Effect.gen(function* () {
  const agents = yield* Agent.Service
  const plugins = yield* Plugin.Service
  yield* agents.transform((editor) => editor.update(Agent.ID.make("build"), () => {}))
  return yield* PluginHost.make(plugins, "test")
})

const sessionID = Session.ID.make("ses_opencode_purge")

const context = (system: SystemPart[]): SessionHooks["context"] => ({
  sessionID,
  agent: Agent.ID.make("build"),
  model: Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("gpt-5") }),
  system,
  messages: [],
  tools: {},
  options: {},
})

const parts = () => [
  SystemPart.make(SessionSystemPrompt.make([])),
  SystemPart.make("# Your Model\n- Name: Test Model"),
  {
    ...SystemPart.make("# Instructions\n- project rule"),
    metadata: { experimental: { instructions: [{ key: "core/date", text: "date" }] } },
  },
]

const run = (text: string) =>
  Effect.gen(function* () {
    const command = yield* Command.Service
    yield* command.execute({
      name: "purge",
      invocation: { sessionID, prompt: { text }, delivery: "steer" },
    })
  })

describe("opencode-purge in the real V2 plugin host", () => {
  it.effect("is disabled by default", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      const host = yield* makeHost
      yield* fromPromise(purger).effect(host)

      const system = parts()
      const event = context(system)
      yield* hooks.trigger("session", "context", event)
      expect(event.system.map((part) => part.text)).toEqual(system.map((part) => part.text))
    }),
  )

  it.effect("strict replaces the assembled prompt after /purge on", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      const host = yield* makeHost
      yield* fromPromise(purger).effect(host)
      yield* run("on")

      const event = context(parts())
      yield* hooks.trigger("session", "context", event)

      expect(event.system).toHaveLength(1)
      expect(event.system[0]?.text.startsWith("# Persona (example)")).toBe(true)
      expect(event.system[0]?.text).toContain("Current working directory:")
      expect(event.system[0]?.text).not.toContain("You are an AI agent running in OpenCode")
      expect(event.system[0]?.text).not.toContain("# Your Model")
    }),
  )

  it.effect("replace keeps the body and drops only the identity", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      const host = yield* makeHost
      yield* fromPromise(purger).effect(host)
      yield* run("on")
      yield* run("mode replace")

      const event = context(parts())
      yield* hooks.trigger("session", "context", event)

      expect(event.system).toHaveLength(4)
      expect(event.system[0]?.text.startsWith("# Persona (example)")).toBe(true)
      expect(event.system[1]?.text).not.toContain("You are an AI agent running in OpenCode")
      expect(event.system[1]?.text).toContain("# Harness")
      expect(event.system[2]?.text).toBe("# Your Model\n- Name: Test Model")
      expect(event.system[3]?.metadata).toEqual({
        experimental: { instructions: [{ key: "core/date", text: "date" }] },
      })
    }),
  )

  it.effect("off restores the assembled prompt", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      const host = yield* makeHost
      yield* fromPromise(purger).effect(host)
      yield* run("on")
      yield* run("off")

      const system = parts()
      const event = context(system)
      yield* hooks.trigger("session", "context", event)
      expect(event.system.map((part) => part.text)).toEqual(system.map((part) => part.text))
    }),
  )

  it.effect("sandbox read tightens through the permission hook", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      const host = yield* makeHost
      yield* fromPromise(purger).effect(host)
      yield* run("sandbox read")

      const shell = yield* hooks.trigger("permission", "evaluate", {
        sessionID,
        action: "shell",
        resources: ["bun test"],
        effect: "allow" as const,
      })
      expect(shell.effect).toBe("deny")
      expect(shell.message).toContain("sandbox (read)")

      const edit = yield* hooks.trigger("permission", "evaluate", {
        sessionID,
        action: "edit",
        resources: ["C:/Work/demo/a.ts"],
        effect: "ask" as const,
      })
      expect(edit.effect).toBe("deny")
    }),
  )

  it.effect("sandbox work keeps worktree edits and gates the shell", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      const host = yield* makeHost
      yield* fromPromise(purger).effect(host)
      yield* run("sandbox work")

      const edit = yield* hooks.trigger("permission", "evaluate", {
        sessionID,
        action: "edit",
        resources: ["src/a.ts"],
        effect: "allow" as const,
      })
      expect(edit.effect).toBe("allow")
      expect(edit.message).toBeUndefined()

      const shell = yield* hooks.trigger("permission", "evaluate", {
        sessionID,
        action: "shell",
        resources: ["bun install"],
        effect: "allow" as const,
      })
      expect(shell.effect).toBe("ask")

      // A host deny is final even in the name of sandboxing.
      const denied = yield* hooks.trigger("permission", "evaluate", {
        sessionID,
        action: "edit",
        resources: ["src/a.ts"],
        effect: "deny" as const,
      })
      expect(denied.effect).toBe("deny")
    }),
  )
})
