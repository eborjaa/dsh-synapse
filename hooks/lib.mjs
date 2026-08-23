// Shared helpers for the Synapse lease hooks.
//
// The loop these hooks enforce: synapse_claim_and_brief takes a LEASE and opens an EPISODE;
// synapse_spawn_release frees the lease and writes the outcome to episodic memory. A model that
// claims and never releases leaks the lease for its whole TTL and loses the memory record — and
// may report success anyway. So the harness tracks the pair itself.
//
// State lives in one marker file per DSH session, in the temp dir: hook processes run sandboxed
// under the DEPLOYMENT default root (process.cwd() at load), not the session cwd, and the temp
// areas are always writable.

import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

// Resolved at install time; $SYNAPSE_VAULT still wins so one hook set can serve several vaults.
export const VAULT = process.env.SYNAPSE_VAULT || "{{VAULT}}";
export const MCP_BIN = `${VAULT}/node_modules/@eborja/synapse/bin/synapse-mcp.mjs`;

/** Read the whole hook payload from stdin. Hooks are always fed one JSON object. */
export async function readPayload() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

export function markerPath(sessionId) {
  const safe = String(sessionId || "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
  return join(process.env.TMPDIR || tmpdir(), `synapse-leases-${safe}.json`);
}

export function readMarker(path) {
  if (!existsSync(path)) return { leases: {}, tries: 0 };
  try {
    const m = JSON.parse(readFileSync(path, "utf8"));
    return { leases: m.leases ?? {}, tries: m.tries ?? 0 };
  } catch {
    return { leases: {}, tries: 0 };
  }
}

export function writeMarker(path, marker) {
  if (!marker.leases || Object.keys(marker.leases).length === 0) {
    if (existsSync(path)) { try { unlinkSync(path); } catch {} }
    return;
  }
  writeFileSync(path, JSON.stringify(marker), "utf8");
}

/**
 * Pull the tool's JSON result out of a hook payload. `tool_response` may arrive as the raw text,
 * as an MCP content array, or as an already-parsed object — accept all three rather than assume.
 */
export function toolResultJson(payload) {
  const r = payload?.tool_response;
  const candidates = [];
  if (typeof r === "string") candidates.push(r);
  else if (r && typeof r === "object") {
    if (Array.isArray(r.content)) for (const c of r.content) if (typeof c?.text === "string") candidates.push(c.text);
    if (typeof r.text === "string") candidates.push(r.text);
    candidates.push(null); // the object itself may already be the result
  }
  for (const c of candidates) {
    if (c === null) return r;
    try { const v = JSON.parse(c); if (v && typeof v === "object") return v; } catch {}
    // A flattened response may wrap the JSON in prose; take the outermost {...}.
    if (typeof c === "string") {
      const m = c.match(/\{[\s\S]*\}/);
      if (m) { try { return JSON.parse(m[0]); } catch {} }
    }
  }
  return null;
}

/** Call one MCP tool over stdio and resolve its parsed text result. */
export function callSynapseTool(name, args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MCP_BIN], {
      cwd: VAULT,
      env: { ...process.env, SYNAPSE_VAULT: VAULT, SYNAPSE_MCP_SURFACE: "orchestrator" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let buf = "";
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { child.kill(); } catch {} resolve(v); } };
    const timer = setTimeout(() => finish({ error: "timeout" }), timeoutMs);
    child.on("error", () => { clearTimeout(timer); finish({ error: "spawn-failed" }); });
    child.stdout.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 2) {
          clearTimeout(timer);
          const text = m.result?.content?.[0]?.text ?? "";
          try { finish(JSON.parse(text)); } catch { finish({ text }); }
        }
      }
    });
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "lease-hook", version: "1" } },
    }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }) + "\n");
  });
}

/** Release one lease, recording honestly that the harness closed it rather than the agent. */
export async function autoRelease(lease) {
  return callSynapseTool("synapse_spawn_release", {
    job: lease.job,
    owner: lease.owner,
    token: lease.token,
    ...(lease.spawnId ? { spawnId: lease.spawnId } : {}),
    ...(lease.episodeId ? { episodeId: lease.episodeId } : {}),
    summary:
      "AUTO-RELEASED by the DSH lease guard: the orchestrating agent ended its turn without calling "
      + "synapse_spawn_release, so the harness closed the lease to stop it leaking for the full TTL. "
      + "Whatever the doer produced was NOT captured here — treat this episode as an incomplete record "
      + "and consult the DSH session transcript if the outcome matters."
      + (lease.task ? ` Task was: ${lease.task}` : ""),
  });
}
