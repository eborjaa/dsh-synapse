// PostToolUse hook for mcp__synapse__synapse_claim_and_brief.
// Records the lease this session now holds. Never blocks: exit 0 whatever happens, because a
// bookkeeping failure must not break a legitimate turn.

import { readPayload, markerPath, readMarker, writeMarker, toolResultJson } from "./lib.mjs";

const payload = await readPayload();
const result = toolResultJson(payload);

// A refused claim (`refused: held` / `looks-like-duplicate`) took no lease — nothing to track.
if (result && result.ok === true && result.job && result.owner && result.token !== undefined) {
  const path = markerPath(payload.session_id);
  const marker = readMarker(path);
  marker.leases[result.job] = {
    job: result.job,
    owner: result.owner,
    token: result.token,
    spawnId: result.spawnId,
    episodeId: result.episodeId,
    task: payload?.tool_input?.task,
    openedAt: new Date().toISOString(),
  };
  marker.tries = 0; // a fresh claim restarts the guard's patience
  writeMarker(path, marker);
}

process.exit(0);
