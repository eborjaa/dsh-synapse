# dsh-synapse — a Synapse vault inside the DeepSeek Harness

> **Wires an existing [Synapse](https://github.com/eborjaa/synapse) context vault into
> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) over MCP — the client row, the
> lease-governance hooks, and the agent skills — as config in `~/.dsh`. Zero lines of DSH source modified.**

`synapse install --write` generates MCP client configs for Claude Code, Cursor and opencode. DSH is not
one of them: it has no generated config, and its wiring is a `cordis.patch.yml` patch layer rather than a
JSON file in your repo. This package is that missing generator, plus the two things a vault needs to
behave correctly under a harness that can delegate.

Nothing here is a fork. DSH is ~200k lines; the integration is 9 files. Forking to hold them would mean
carrying the whole codebase to change nothing in it, and every upstream release candidate would become a
merge. So the integration lives *outside* the checkout, in `~/.dsh`, and survives `git pull` on DSH by
never having touched it.

---

## Requirements

- Node 22+
- A Synapse vault with `@eborja/synapse` installed into it (`npm install @eborja/synapse` in the vault)
- A working `dsh` checkout, already run once so `~/.dsh` exists

---

## Install

```bash
cd /path/to/your-vault
npx @eborja/dsh-synapse install            # dry-run — prints every file it would touch
npx @eborja/dsh-synapse install --write    # apply
# restart dsh
```

Run it from inside the vault and it finds everything itself. From anywhere else, name the vault:

```bash
npx @eborja/dsh-synapse install --vault /path/to/your-vault
```

The dry-run is the default, and it is the real plan — same resolution, same file comparison, just no
writes:

```
dsh-synapse install  (dry-run)
  vault    : /Users/you/synapse/synapse-vault
  dsh home : /Users/you/.dsh
  node     : /Users/you/.nvm/versions/node/v25.8.1/bin/node

  + create     ~/.dsh/hooks/claim-guard.mjs
  + create     ~/.dsh/hooks/lease-guard.mjs
  …            (7 hook files in all, incl. synapse-hooks.json)
  + create     ~/.dsh/profiles/web/cordis.patch.yml
  + create     ~/.dsh/profiles/headless/cordis.patch.yml
  → symlink    ~/.dsh/skills/synapse-oracle → …/@eborja/synapse/.dsh/skills/synapse-oracle
  …            (4 skills in all)

13 change(s) pending — re-run with --write to apply.
```

### Verify

```bash
dsh --profile web --dump-config | grep -E "^- id: (mcp-synapse|hooks-synapse|spill-policy)"
```

Three rows, or the patch layer did not load. `--dump-config` composes the tree without booting it, so this
is safe to run any time. Inside a session, the vault is live when `mcp__synapse__*` tools appear and
`/synapse-oracle` completes.

---

## What it installs, and why

### 1. The MCP client row

A `@deepseek-ai/dsh-mcp-client` row inserted into `~/.dsh/profiles/{web,headless}/cordis.patch.yml`,
pointed at your vault's `bin/synapse-mcp.mjs` over stdio, on the `orchestrator` surface (the full tool set
plus `synapse_claim_and_brief` / `synapse_spawn_release` / `synapse_history` / `synapse_recall`).

```yaml
- id: mcp-synapse
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: synapse
    transport: stdio
    command: /absolute/path/to/node
    args: [/path/to/vault/node_modules/@eborja/synapse/bin/synapse-mcp.mjs]
    cwd: /path/to/vault
    env:
      SYNAPSE_VAULT: /path/to/vault
      SYNAPSE_MCP_SURFACE: orchestrator
```

**The node path must be absolute.** DSH scrubs a spawned child's environment, so a bare `node` may not
resolve — under a version manager it usually doesn't. The installer records `process.execPath`, i.e.
whichever node you ran it with. Switch node versions later and re-run the installer, or pass `--node`.

### 2. Lease-governance hooks

The Synapse delegation loop is three calls: `synapse_claim_and_brief` takes a lease and opens an episode,
*you* launch the doer, `synapse_spawn_release` closes the lease with the outcome. Both ends matter — the
claim is what makes dedup unskippable, the release is what writes the result to episodic memory.

Prompting does not hold that loop together. "Claim before you delegate" was in the curator skill three
times and got skipped three times. The claim gives a model nothing it needs to finish its turn: it is pure
governance, paid up front and redeemed only at release, so a model optimising locally drops it every time
and often reports success anyway. These hooks enforce it mechanically instead, via the
`@deepseek-ai/dsh-hooks-claude-code` dialect.

| Hook | Event | Does |
|---|---|---|
| `claim-guard.mjs` | PreToolUse `subagent\|subagent_fork` | Refuses to delegate vault work with no lease held. Exit 2 denies the call; stderr becomes the reason the model reads. |
| `lease-guard.mjs` | Stop | Catches a claim that was never released. Nudges **once** (exit 2 → `agent.steer()`, forcing another model step), then auto-releases the lease itself. |
| `lease-open.mjs` | PostToolUse `synapse_claim_and_brief` | Records the lease. Trusts the result — a refused claim (`held`, `looks-like-duplicate`) took no lease and is not tracked. |
| `lease-close.mjs` | PostToolUse `synapse_spawn_release` | Clears it — only if the result says `released: true`. A release refused for a stale fencing token leaves the lease held, and clearing it there would hide the exact failure this exists to catch. |
| `synapse-touch.mjs` | PostToolUse `mcp__synapse__.*` | Flags the session as doing vault work. |

That last one is why an ordinary coding session is unaffected: `claim-guard` enforces **only** on sessions
that have touched a Synapse tool. Everything else delegates freely.

**The one-nudge self-limit is mandatory, not defensive.** DSH has no consecutive-block cap
(`TODO(stop-loop-guard)` in `hooks-claude-code`), so a Stop hook that blocked unconditionally would
force-continue the agent forever. After one nudge the guard releases the lease itself and records honestly
that the *harness* closed it — leaking a lease for its full TTL with no episode written is strictly worse
than an auto-release that says so.

State is one marker file per session in `$TMPDIR`, not the vault: hook processes run sandboxed under the
deployment root — `process.cwd()` at load — not the session cwd, and the temp areas are always writable.

**Known gap:** the Stop hook fires on a clean turn-end, but **not on an interrupt**. Ctrl-C a run holding a
lease and that lease leaks until its TTL expires. Nothing here catches it. Re-claiming the same canonical
job id before then will be refused as held.

### 3. Agent skills

Symlinks `~/.dsh/skills/synapse-{oracle,curator,ingester,reconciler}` to the four skills shipped inside
`@eborja/synapse` under `.dsh/skills/`, so `/synapse-oracle` and friends load that role's procedure and
boundaries. Symlinks, not copies — an `npm update` in the vault upgrades the skills with no re-install.

### 4. `spill-policy: maxInlineBytes: 70000`

DSH's spill policy replaces any plain-text tool result over `maxInlineBytes` with a preview plus a file
locator. At the 50000 default, a `lean` Synapse briefing (~60KB) was silently truncated —
`Omitted 10194 bytes` — and the agent had to spend a turn re-reading what it had just been handed.
70000 keeps a briefing whole. Genuinely runaway output still spills.

### `headless` gets two extra rows

The `web` profile composes a preset roster; `headless` composes none, so it needs two things `web` already
has:

- **`system-prompt.persona`** — at order 0 this *is* the identity in headless. It states the protocol
  (brief before answering, `synapse_history` before starting work that may be done, claim → delegate →
  release, never write `db/synapse.db`, never self-merge). Kept deliberately static: order 0 sits at the
  front of the prompt, so anything varying per request would invalidate the cached prefix. The prompt
  states the protocol and the hooks enforce it — both, on purpose.
- **`tool-ask-user`** — the `user-questions` service is mounted in base but the model-facing tool is not,
  so a headless agent has no way to pause for a human decision instead of guessing.

---

## What it never touches

- **`~/.dsh/settings.yaml`** — your providers, models, and harness preferences.
- **`~/.dsh/.credentials.yaml`** — your API keys.

Neither is read, written, or backed up. This is a safety property, not an omission: an installer that
edits a config file holding secrets is one bug away from destroying them, and nothing this package does
requires either file.

It writes only `~/.dsh/hooks/`, `~/.dsh/profiles/{web,headless}/cordis.patch.yml`, and
`~/.dsh/skills/synapse-*` — and nothing at all inside your DSH checkout or your vault.

⚠ `cordis.patch.yml` is written **whole**, not merged. If you keep your own patch rows in those two
profiles, the installer will overwrite them. Keep unrelated patches in a separate profile, or re-apply
them after an install (the dry-run flags it as `overwrite` before anything happens).

---

## Flags

| Flag | Default |
|---|---|
| `--write` | off — dry-run prints the plan and changes nothing |
| `--vault <path>` | `$SYNAPSE_VAULT`, else an ancestor walk from `$PWD` for `_meta/tools/context.manifest.json` (flat or `context-vault/` nested) |
| `--dsh-home <path>` | `$DSH_HOME`, else `~/.dsh` |
| `--node <path>` | the absolute path of the node running the installer (`process.execPath`) |

Re-running is safe and idempotent: unchanged files are reported `unchanged` and skipped, so `install` is
also the way to re-point everything after moving a vault or switching node versions.

If `@eborja/synapse` is not installed in the vault, the skills step reports `skip` with the reason instead
of failing — the MCP row and hooks still install, and re-running after `npm install` links the skills.

---

## Uninstall

There is no uninstall subcommand; everything it wrote is in three places.

```bash
rm -f  ~/.dsh/hooks/{claim-guard,lease-guard,lease-open,lease-close,synapse-touch,lib}.mjs \
       ~/.dsh/hooks/synapse-hooks.json
rm -f  ~/.dsh/skills/synapse-{oracle,curator,ingester,reconciler}
rm -f  ~/.dsh/profiles/{web,headless}/cordis.patch.yml   # or delete just the synapse rows
rm -f  "${TMPDIR:-/tmp}"/synapse-leases-*                # stale session markers
```

Then restart dsh. `settings.yaml` and `.credentials.yaml` are untouched by all of this, as they were by
the install.

---

## Troubleshooting

**No `mcp__synapse__*` tools.** Check `dsh --profile web --dump-config | grep mcp-synapse`. If the row is
absent, the patch file did not load — confirm the path and that dsh restarted. If the row is present but
the tools are not, the stdio child failed to spawn: run the `command` + `args` from the row by hand and
read the error. A bare or wrong node path is the usual cause.

**Hooks do nothing.** `hooks-claude-code` reads `configPath` **once at load**, with no live reload — a bad
path registers nothing and says nothing. Verify the `hooks-synapse` row is in `--dump-config` and that
`~/.dsh/hooks/synapse-hooks.json` exists at exactly the path it names. Edit the JSON and you must restart.

**A job is refused as already held.** Most likely an interrupted run leaked its lease (see the gap above).
Wait out the TTL, or release it explicitly with `synapse_spawn_release` using the job id and owner.

**Briefings arrive truncated.** `Omitted N bytes` means `spill-policy` did not take. Confirm the row in
`--dump-config`; a `fat` briefing can exceed even 70000, in which case raise it further in the patch.

---

## License

MIT © 2026 Emmanuel Borja
