// PostToolUse hook for mcp__synapse__synapse_spawn_release.
// Clears the lease the agent just released. Never blocks.

import { readPayload, markerPath, readMarker, writeMarker, toolResultJson } from "./lib.mjs";

const payload = await readPayload();
const result = toolResultJson(payload);

// Trust the RESULT, not the call: a release that was refused (wrong owner or a stale fencing
// token) leaves the lease held, and clearing the marker there would hide exactly the failure
// this hook exists to catch.
const released = result?.released === true;
const job = result?.job ?? payload?.tool_input?.job;

if (released && job) {
  const path = markerPath(payload.session_id);
  const marker = readMarker(path);
  if (marker.leases[job]) {
    delete marker.leases[job];
    writeMarker(path, marker);
  }
}

process.exit(0);
