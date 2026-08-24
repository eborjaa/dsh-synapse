// mcp-env.test.mjs — extra env is copied from the vault's existing MCP configs, not hardcoded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readVaultMcpEnv, yamlMcpExtraEnv } from "../hooks/lib.mjs";

function tmpVault(env) {
  const root = mkdtempSync(join(tmpdir(), "dsh-syn-env-"));
  if (env) {
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({
      mcpServers: { synapse: { env } },
    }));
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("a vault with no MCP config still gets NODE_OPTIONS", () => {
  const { root, cleanup } = tmpVault(null);
  try {
    assert.deepEqual(readVaultMcpEnv(root), { NODE_OPTIONS: "--experimental-sqlite" });
  } finally { cleanup(); }
});

test("extra env from .mcp.json is copied; owned keys are not", () => {
  const { root, cleanup } = tmpVault({
    SYNAPSE_VAULT: "/wrong",
    SYNAPSE_MCP_SURFACE: "full",
    NODE_OPTIONS: "--experimental-sqlite",
    ZEPHYR_MCP_DISABLE: "1",
  });
  try {
    const env = readVaultMcpEnv(root);
    assert.equal(env.ZEPHYR_MCP_DISABLE, "1");
    assert.equal(env.NODE_OPTIONS, "--experimental-sqlite");
    assert.equal(env.SYNAPSE_VAULT, undefined);
    assert.equal(env.SYNAPSE_MCP_SURFACE, undefined);
  } finally { cleanup(); }
});

test("YAML quotes values so ZEPHYR_MCP_DISABLE=1 stays a string", () => {
  const yaml = yamlMcpExtraEnv({ ZEPHYR_MCP_DISABLE: "1", NODE_OPTIONS: "--experimental-sqlite" });
  assert.match(yaml, /ZEPHYR_MCP_DISABLE: "1"/);
  assert.doesNotMatch(yaml, /ZEPHYR_MCP_DISABLE: 1$/m);
  assert.match(yaml, /^          NODE_OPTIONS: "--experimental-sqlite"$/m);
});

test("cursor config is read when .mcp.json is absent", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-syn-env-"));
  try {
    mkdirSync(join(root, ".cursor"));
    writeFileSync(join(root, ".cursor", "mcp.json"), JSON.stringify({
      mcpServers: { synapse: { env: { ZEPHYR_MCP_DISABLE: "1" } } },
    }));
    assert.equal(readVaultMcpEnv(root).ZEPHYR_MCP_DISABLE, "1");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
