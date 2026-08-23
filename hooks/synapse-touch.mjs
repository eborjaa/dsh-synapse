// PostToolUse on any mcp__synapse__* tool: mark this session as doing vault work.
// The claim guard only enforces on sessions carrying this flag, so an ordinary coding
// session can still use `subagent` freely.
import { writeFileSync } from "node:fs";
import { readPayload, markerPath } from "./lib.mjs";

const payload = await readPayload();
try { writeFileSync(markerPath(payload.session_id) + ".vault", "1", "utf8"); } catch {}
process.exit(0);
