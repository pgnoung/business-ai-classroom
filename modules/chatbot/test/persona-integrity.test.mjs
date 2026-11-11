import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig, loadPersona } from "../src/config.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

test("configured persona hash is checked at the chassis read boundary", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "chassis-persona-"));
  const personaFile = resolve(root, "persona.md");
  const approved = "ลูกแพร persona approved\n";
  await writeFile(personaFile, approved, "utf8");
  const config = createConfig({ PERSONA_FILE: personaFile, PERSONA_SHA256: sha256(approved) });
  assert.equal(loadPersona(config), approved);

  await writeFile(personaFile, "drifted after preflight\n", "utf8");
  assert.throws(() => loadPersona(config), /does not match PERSONA_SHA256/u);
});

test("configured persona hash fails closed for invalid pins and missing files", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "chassis-persona-invalid-"));
  const personaFile = resolve(root, "persona.md");
  await writeFile(personaFile, "reviewed bytes\n", "utf8");
  const invalid = createConfig({ PERSONA_FILE: personaFile, PERSONA_SHA256: "not-a-hash" });
  assert.throws(() => loadPersona(invalid), /must be 64 lowercase hex/u);

  const missing = createConfig({ PERSONA_FILE: "/definitely/missing/persona.md", PERSONA_SHA256: "a".repeat(64) });
  assert.throws(() => loadPersona(missing), /configured persona file is unreadable/u);
});

test("legacy instances remain backward compatible when no persona hash is configured", () => {
  const legacy = createConfig({ PERSONA_FILE: "/definitely/missing/persona.md" });
  assert.equal(loadPersona(legacy), "");
});
