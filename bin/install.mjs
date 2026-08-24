#!/usr/bin/env node
// dsh-synapse install — wire a Synapse vault into the DeepSeek Harness.
//
//   npx @eborja/dsh-synapse install            # dry-run: print exactly what would change
//   npx @eborja/dsh-synapse install --write    # apply
//
// What it writes into $DSH_HOME (default ~/.dsh):
//   hooks/*.mjs + synapse-hooks.json   the lease guards (claim-before-delegate, release-before-stop)
//   profiles/{web,headless}/cordis.patch.yml   the MCP client row, the hooks row, spill sizing
//   skills/synapse-*                   symlinks to the agent skills shipped by @eborja/synapse
//
// What it NEVER touches: settings.yaml (your providers and model choices) and .credentials.yaml
// (your API keys). Both are yours; this package has no business rewriting either.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, symlinkSync, lstatSync, unlinkSync, realpathSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { readVaultMcpEnv, yamlMcpExtraEnv } from "../hooks/lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..");
const write = process.argv.includes("--write");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

// ── resolve the three machine-specific values ──────────────────────────────────────────────────
const DSH_HOME = resolve(arg("dsh-home", process.env.DSH_HOME || join(homedir(), ".dsh")));

// dsh scrubs a spawned child's env, so a bare `node` may not resolve. Record the absolute path.
const NODE = resolve(arg("node", process.execPath));

/** A vault is a directory carrying _meta/tools/context.manifest.json (flat or nested layout). */
function findVault(start) {
  let dir = resolve(start);
  for (;;) {
    for (const rel of ["_meta/tools/context.manifest.json", "context-vault/_meta/tools/context.manifest.json"]) {
      if (existsSync(join(dir, rel))) return rel.startsWith("context-vault") ? join(dir, "context-vault") : dir;
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// Resolution order: --vault, then the vault you are STANDING IN, then $SYNAPSE_VAULT.
//
// cwd deliberately beats the env var, matching @eborja/synapse's own resolveVault({preferCwd:true}).
// `synapse install --write` EXPORTS $SYNAPSE_VAULT from your shell rc, so on any machine that already
// has a vault the env var is always set — and with the old order (env first) `cd my-other-vault &&
// npx @eborja/dsh-synapse install --write` silently wired the FIRST vault while reporting it plainly
// enough that nobody read it. Standing in a vault is an unambiguous statement of which one you mean.
const cwdVault = findVault(process.cwd());
const explicit = arg("vault", null);
const VAULT = resolve(explicit || cwdVault || process.env.SYNAPSE_VAULT || "");
const VAULT_SOURCE = explicit ? "--vault" : cwdVault ? "the directory you are in" : "$SYNAPSE_VAULT";
if (!VAULT || !existsSync(VAULT)) {
  console.error(
    "Could not locate a Synapse vault.\n"
    + "Run this from inside one, or pass --vault /path/to/vault (or set $SYNAPSE_VAULT).\n"
    + "A vault is a directory containing _meta/tools/context.manifest.json.",
  );
  process.exit(1);
}
// Say so when the two disagree — this wires ~/.dsh globally, so pointing it at the wrong vault is
// silent and lasting.
const envVault = process.env.SYNAPSE_VAULT ? resolve(process.env.SYNAPSE_VAULT) : null;
if (envVault && envVault !== VAULT) {
  console.warn(
    `\n⚠ $SYNAPSE_VAULT is ${envVault}, but this run targets ${VAULT}\n`
    + `  (resolved from ${VAULT_SOURCE}). Pass --vault to be explicit if that is not what you meant.\n`,
  );
}

const MCP_BIN = join(VAULT, "node_modules", "@eborja", "synapse", "bin", "synapse-mcp.mjs");
const SKILLS_SRC = join(VAULT, "node_modules", "@eborja", "synapse", ".dsh", "skills");

// Extra env already on this vault's MCP configs (ZEPHYR_MCP_DISABLE, NODE_OPTIONS, …). DSH scrubs
// the child's environment, so these have to be written into cordis — `synapse mcp-config --env`
// otherwise only reaches Claude/Cursor.
const extraEnv = readVaultMcpEnv(VAULT);
const EXTRA_ENV = yamlMcpExtraEnv(extraEnv);

const fill = (s) => s
  .replaceAll("{{DSH_HOME}}", DSH_HOME)
  .replaceAll("{{NODE}}", NODE)
  .replaceAll("{{VAULT}}", VAULT)
  .replaceAll("{{EXTRA_ENV}}", EXTRA_ENV);

const planned = [];
const note = (action, path, detail = "") => planned.push({ action, path, detail });

function put(destPath, content) {
  const existing = existsSync(destPath) ? readFileSync(destPath, "utf8") : null;
  if (existing === content) return note("unchanged", destPath);
  note(existing === null ? "create" : "overwrite", destPath);
  if (!write) return;
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, content, "utf8");
}

// ── hooks ──────────────────────────────────────────────────────────────────────────────────────
for (const f of readdirSync(join(PKG, "hooks"))) {
  if (f.endsWith(".test.mjs")) continue;
  const src = readFileSync(join(PKG, "hooks", f), "utf8");
  put(join(DSH_HOME, "hooks", f.replace(/\.tmpl$/, "")), fill(src));
}

// ── profile patches ────────────────────────────────────────────────────────────────────────────
for (const profile of readdirSync(join(PKG, "profiles"))) {
  const src = readFileSync(join(PKG, "profiles", profile, "cordis.patch.yml.tmpl"), "utf8");
  put(join(DSH_HOME, "profiles", profile, "cordis.patch.yml"), fill(src));
}

// ── skills: symlink the ones @eborja/synapse ships ────────────────────────────────────────────
if (existsSync(SKILLS_SRC)) {
  for (const name of readdirSync(SKILLS_SRC)) {
    const dest = join(DSH_HOME, "skills", name);
    const target = join(SKILLS_SRC, name);
    let current = null;
    try { current = lstatSync(dest).isSymbolicLink() ? realpathSync(dest) : "(not a symlink)"; } catch {}
    if (current === realpathSync(target)) { note("unchanged", dest); continue; }
    note(current ? "relink" : "symlink", dest, `→ ${target}`);
    if (!write) continue;
    mkdirSync(dirname(dest), { recursive: true });
    try { unlinkSync(dest); } catch {}
    symlinkSync(target, dest);
  }
} else {
  note("skip", join(DSH_HOME, "skills"), `@eborja/synapse not installed in ${VAULT} — run npm install there first`);
}

// ── report ─────────────────────────────────────────────────────────────────────────────────────
console.log(`\ndsh-synapse install${write ? "" : "  (dry-run)"}`);
console.log(`  vault    : ${VAULT}   (from ${VAULT_SOURCE})`);
  console.log(`  dsh home : ${DSH_HOME}`);
  console.log(`  node     : ${NODE}`);
  console.log(`  mcp env  : ${Object.keys(extraEnv).join(", ")}   (from this vault's existing MCP config)\n`);
for (const p of planned) {
  const tag = { create: "+", overwrite: "~", symlink: "→", relink: "→", unchanged: " ", skip: "!" }[p.action] ?? "?";
  console.log(`  ${tag} ${p.action.padEnd(10)} ${p.path.replace(homedir(), "~")} ${p.detail}`);
}
const changed = planned.filter((p) => p.action !== "unchanged" && p.action !== "skip").length;
console.log(
  changed === 0
    ? "\nAlready up to date.\n"
    : write
      ? `\n${changed} change(s) applied. Restart dsh to pick them up.\n`
      : `\n${changed} change(s) pending — re-run with --write to apply.\n`,
);
if (write && changed > 0) {
  console.log("Verify the rows landed:");
  console.log(`  dsh --profile web --dump-config | grep -E "^- id: (mcp-synapse|hooks-synapse|spill-policy)"\n`);
}
