<div align="center">

# opencode-purge

**Swap OpenCode's system prompt for a prompt file of your choice — per session.**

</div>

> [!NOTE]
> Not every model has a matching prompt, and not 100% of safeguards will be passed.

---

## Concept

OpenCode builds a system prompt (identity, tool guidance, project instructions) before every model call. This plugin intercepts that moment and swaps the prompt for a file **you** control:

```
your prompt file  ─┐
OpenCode prompt   ─┼─▶  /purge:on  ─▶  model request
your rules file   ─┘
```

Nothing inside OpenCode is modified. The swap lives in memory, applies to **one session**, and disappears on restart.

---

## Install

**1.** Clone and install:

```bash
git clone https://github.com/LongpanZhou/opencode-purge.git
cd opencode-purge && bun install
```

**2.** Register the plugin — in `opencode.jsonc` (global *or* one project, never both):

```jsonc
{
  "plugins": [
    {
      "package": "C:/path/to/opencode-purge",
      "options": {
        "mode": "replace",
        "source": "auto",
        "personaRepo": "C:/path/to/prompts",
        "personaRepoUrl": "https://github.com/you/prompts",
        "autoPull": true,
        "fallback": "none",
        "injectFile": "prompt-inject.md"
      }
    }
  ]
}
```

**3.** Restart OpenCode.

---

## Commands

| Command | What it does |
| --- | --- |
| `/purge:on` | Applies your prompt to this session. Reports which file matched. |
| `/purge:off` | Restores OpenCode's original prompt immediately. |
| `/purge:status` | Shows state, matched file, sandbox and last rewrite — rendered into chat. |
| `/purge:mode <m>` | Switches composition: `append`, `replace`, or `strict`. |
| `/purge:source <s>` | Changes where the prompt comes from: file, folder, `auto`, or `embedded`. |
| `/purge:sandbox <p>` | Caps tool permissions: `off`, `read`, or `work`. |
| `/purge:update-md` | Syncs the prompt folder from GitHub and packs it into one `.md`. |
| `/purge:update` | Pulls this plugin's own git repo. |
| `/purge:reload` | Rescans the prompt folder (local only, instant). |

`/purge <command>` also works, and the palette autocompletes everything after `/purge:`.

---

## Configuration

Every option is optional; these are the ones that change behavior.

| Option | Default | What it does |
| --- | --- | --- |
| `mode` | `strict` | `append` = persona + full host prompt · `replace` = persona + host prompt without the identity line · `strict` = persona + working directory only |
| `source` | `embedded` | `embedded`, a file path, a folder of prompts, or `auto` (match the model) |
| `personaRepo` | — | Folder with one subfolder per vendor, one prompt file per model |
| `personaRepoUrl` | — | Git URL used to clone/update that folder |
| `autoPull` | `false` | Pull the folder on server start (and on the interval below) |
| `autoPullOnStart` | `true` | Do one sync when the plugin loads (when `autoPull` is on) |
| `autoPullIntervalMinutes` | `0` | Repeat the sync every N minutes; `0` = only on start |
| `fallback` | `none` | What happens when no file matches: `none` refuses, `embedded` uses the example, or a file path |
| `autoApplyOnStart` | `false` | Arm every new session without typing `/purge:on` |
| `injectFile` | — | A markdown file appended last as mandatory rules |
| `notify` | `true` | Post status notes in chat; `false` = silent, file only |
| `statusFile` | `.state/purge-status.txt` | Where command results are always written |
| `sandbox` | `off` | Initial permission ceiling: `off`, `read`, `work` |
| `sandboxAllowShell` | `[]` | Shell patterns exempt from the sandbox's approval prompt |
| `packOut` | `<catalog>/personas-pack.md` | Where `update-md` writes the pack || `updateRoot` | this checkout | What `/purge:update` pulls |

Relative `injectFile`, `statusFile`, `packOut`, `updateRoot`, and a non-`embedded` `fallback` resolve against the plugin folder. `OPENCODE_PURGE_SOURCE` and `OPENCODE_PURGE_STATUS_FILE` override those two defaults.

---

## How the prompt is built

Each model request is assembled from up to **three layers**, in this order:

| Layer | What it is | Why it's there |
| --- | --- | --- |
| **1. Your prompt** | The file matched to the current model (e.g. `DeepSeek/deepseek-4-1.md`). Injected in full. | This is the persona: voice, rules, behavior. |
| **2. OpenCode's prompt** | The harness prompt — tool guidance, environment, project instructions. | Keeps the agent effective: tools, conventions, context. |
| **3. Your rules** | `prompt-inject.md`, appended **last** as `# Session directives (mandatory)`. | Standing orders with the highest recency; applied even when layer 1 finds nothing. |

How each layer behaves depends on `mode`:

- **`replace`** (recommended) — layer 1, plus layer 2 with its `You are OpenCode…` identity line (and any `OpenCode documentation` block) removed, plus layer 3.
- **`append`** — layer 1, the complete layer 2 (identity included), plus layer 3.
- **`strict`** — layer 1 and the working directory only; layer 2 is dropped entirely, plus layer 3.

Layer 3 is independent: it is added in every mode, and if `prompt-inject.md` is missing or empty it is simply skipped.

Tool definitions travel outside these layers, so tools keep working in every mode — even `strict`.

### Model matching

`source: "auto"` looks up the model (`providerID/id`) in `personaRepo`:

```
prompts/
├── DeepSeek/deepseek-4-1.md
├── Anthropic/Sonnet v2.md
└── ...
```

An optional `prompts/catalog.json` can add aliases or pin exact models to files. No match + `fallback: "none"` = `/purge:on` refuses to enable (when the host reports the session model).

---

## Maintenance

`/purge:update-md` keeps the prompt folder current:

- pulls the latest files from `personaRepoUrl`,
- removes the project-managed clone's `README.md`,
- writes everything into `personas-pack.md` (table of contents + every prompt, with SHA-256).

Repo-side equivalents: `bun run pack`, `bun run pack:watch`, and `bun scripts/diag-resolve.ts <folder> <provider/id> --why` to see exactly what matches.

---

## Good to know

- **Session only.** State lives in memory; restart turns it off (unless `autoApplyOnStart` is set).
- **One instance.** Loading the plugin twice makes two copies fight. One config entry.
- **Status** is written to `.state/purge-status.txt` when the filesystem allows, even with `notify: false`.
- **Sandbox only tightens.** It can turn allow into ask or deny, never the reverse.

---

<div align="center">

Ideas from [dsh-purge](https://github.com/YuJunZhiXue/dsh-purge) and [pi-purge](https://github.com/ZiChuanLan/pi-purge) · Example prompts: [togg53192-cmd/jailbreaks](https://github.com/togg53192-cmd/jailbreaks)

</div>
