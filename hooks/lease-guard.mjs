// Stop hook — fires at agent/turn-stopping for every agent, root and subagent.
//
// If the session still holds a Synapse lease, exit 2: the harness turns that into agent.steer()
// and forces another model step, so the agent cannot end its turn having claimed work it never
// closed. On the second attempt the harness releases the lease itself and lets the turn end.
//
// The self-limit is MANDATORY, not defensive: DSH has no consecutive-block cap
// (TODO(stop-loop-guard) in hooks-claude-code), so a hook that blocks unconditionally would
// force-continue every step forever.

import { readPayload, markerPath, readMarker, writeMarker, autoRelease } from "./lib.mjs";

const MAX_NUDGES = 1; // one nudge, then the harness closes it itself

const payload = await readPayload();
const path = markerPath(payload.session_id);
const marker = readMarker(path);
const open = Object.values(marker.leases ?? {});

if (open.length === 0) process.exit(0); // nothing outstanding — let the turn close

// Give up nudging and close the leases ourselves. Leaking a lease for its full TTL, with no
// episode written, is strictly worse than an honest auto-release record.
if (marker.tries >= MAX_NUDGES || payload.stop_hook_active === true) {
  for (const lease of open) {
    try { await autoRelease(lease); } catch {}
  }
  writeMarker(path, { leases: {}, tries: 0 });
  process.exit(0);
}

marker.tries = (marker.tries ?? 0) + 1;
writeMarker(path, marker);

const lines = open.map((l) =>
  `  synapse_spawn_release({ job: "${l.job}", owner: "${l.owner}", token: ${l.token}`
  + (l.spawnId ? `, spawnId: "${l.spawnId}"` : "")
  + (l.episodeId ? `, episodeId: "${l.episodeId}"` : "")
  + `, summary: "<what the doer actually produced>" })`);

process.stderr.write(
  `You are ending this turn while still holding ${open.length} unreleased Synapse `
  + `lease${open.length === 1 ? "" : "s"}. A claim that is never released blocks the job for its full TTL `
  + `and loses the result from episodic memory.\n\nCall this now, with a real summary of what the doer `
  + `produced (not a placeholder):\n\n${lines.join("\n")}\n\n`
  + `If the work did not actually happen, release it anyway and say so in the summary.\n`,
);

process.exit(2); // -> agent.steer(): the harness forces another step
