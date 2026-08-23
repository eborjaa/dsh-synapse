// PreToolUse on `subagent`: refuse to delegate vault work that was never claimed.
//
// Why a hook and not a prompt: "claim before you delegate" was written into the curator skill
// three times and skipped three times. The claim gives the model nothing it needs to finish its
// turn — it is pure governance, paid up front, redeemed only at release. A model optimising
// locally will always drop it. So the harness enforces it instead.
//
// Exit 2 => tools/pre-execute denies the call; stderr becomes the reason the model sees.
import { existsSync } from "node:fs";
import { readPayload, markerPath, readMarker } from "./lib.mjs";

const payload = await readPayload();
const base = markerPath(payload.session_id);

// Not a Synapse session -> not our business. Ordinary delegation stays untouched.
if (!existsSync(base + ".vault")) process.exit(0);

const open = Object.values(readMarker(base).leases ?? {});
if (open.length > 0) process.exit(0); // a lease is held -> delegation is governed -> allow

process.stderr.write(
  "Refused: you are delegating vault work without having claimed it.\n\n"
  + "Call mcp__synapse__synapse_claim_and_brief FIRST with the specialist agent and a canonical "
  + "job id built from stable facts (e.g. \"reconciler:hub-finances:view-drift\"). That takes the "
  + "lease, opens the episode, and returns the doer's briefing — which is what you pass to "
  + "`subagent`.\n\n"
  + "Without it there is no dedup (two passes can do the same job) and no durable record of what "
  + "the doer found. Claim first, then delegate with run_in_background: false, then release.\n",
);
process.exit(2);
