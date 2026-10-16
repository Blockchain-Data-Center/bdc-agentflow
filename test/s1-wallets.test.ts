import "./helpers/net-guard.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The script only ever writes into this isolated temporary directory, with test-generated dummy keys.
let dir: string;
let firstRun: ReturnType<typeof spawnSync>;

const runCreate = () =>
  spawnSync(process.execPath, ["--import", "tsx", "scripts/wallets-create.ts", "--dir", dir], {
    cwd: repoRoot,
    encoding: "utf8",
  });

// Reads the dummy keys of the temporary .env, for comparison only; they are never printed.
function dummyEnv(): Map<string, string> {
  const lines = readFileSync(join(dir, ".env"), "utf8").split("\n").filter(Boolean);
  return new Map(lines.map((line) => line.split("=", 2) as [string, string]));
}

before(() => {
  dir = mkdtempSync(tmpdir() + "/agentflow-wallets-test-");
  const fromRepo = relative(repoRoot, dir);
  assert.ok(fromRepo.startsWith("..") || isAbsolute(fromRepo), "the test directory is not inside repo/");
  firstRun = runCreate();
});

after(() => rmSync(dir, { recursive: true, force: true }));

describe("s1-wallets", () => {
  it("writes .env with exactly the two *_SECRET_KEY_B58 names, mode 0o600, plus wallets.public.json", () => {
    assert.equal(firstRun.status, 0, String(firstRun.stderr));
    assert.deepEqual([...dummyEnv().keys()], ["BUYER_SECRET_KEY_B58", "SELLER_SECRET_KEY_B58"]);
    assert.equal(statSync(join(dir, ".env")).mode & 0o777, 0o600);
    const info = JSON.parse(readFileSync(join(dir, "wallets.public.json"), "utf8"));
    assert.deepEqual(Object.keys(info).sort(), ["buyer", "createdAt", "paymentNetwork", "seller"]);
    assert.equal(info.paymentNetwork, "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
  });

  it("a second run refuses and changes neither file", () => {
    const before = [".env", "wallets.public.json"].map((name) => readFileSync(join(dir, name), "utf8"));
    const second = runCreate();
    assert.notEqual(second.status, 0);
    const afterRun = [".env", "wallets.public.json"].map((name) => readFileSync(join(dir, name), "utf8"));
    assert.deepEqual(afterRun, before);
  });

  it("stdout contains both public addresses and neither secret value", () => {
    const info = JSON.parse(readFileSync(join(dir, "wallets.public.json"), "utf8"));
    const stdout = String(firstRun.stdout);
    assert.ok(stdout.includes(info.buyer));
    assert.ok(stdout.includes(info.seller));
    for (const secret of dummyEnv().values()) {
      assert.ok(secret.length > 0);
      assert.equal(stdout.includes(secret), false);
      assert.equal(String(firstRun.stderr).includes(secret), false);
    }
  });
});
