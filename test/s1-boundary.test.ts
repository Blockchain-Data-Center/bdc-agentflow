import "./helpers/net-guard.ts";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = join(repoRoot, "src");

// Repository-relative path with forward slashes, whatever the platform separator.
const rel = (path: string) => relative(repoRoot, path).split(sep).join("/");

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(ts|mts|cts|js|mjs)$/.test(name) ? [path] : [];
  });
}

// Relative import specifiers of a file, resolved to repository-relative paths.
function localImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const specifiers = [
    ...text.matchAll(/\bfrom\s*["']([^"']+)["']/g),
    ...text.matchAll(/\bimport\s*["']([^"']+)["']/g),
    ...text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
  ].map((match) => match[1]);
  return specifiers.filter((s) => s.startsWith(".")).map((s) => rel(resolve(dirname(file), s)));
}

const inside = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

describe("s1-boundary", () => {
  it("SECRET_KEY appears under src/ only in src/signer/buyer-signer.ts", () => {
    const files = sourceFiles(srcRoot).filter((file) => readFileSync(file, "utf8").includes("SECRET_KEY"));
    assert.deepEqual(files.map(rel), ["src/signer/buyer-signer.ts"]);
  });

  it("src/signer is imported only by src/payments/client.ts and imports no policy, registry, service or agentflow code", () => {
    for (const file of sourceFiles(srcRoot)) {
      const from = rel(file);
      for (const target of localImports(file)) {
        if (inside(target, "src/signer") && !inside(from, "src/signer")) {
          assert.equal(from, "src/payments/client.ts", `${from} imports ${target}`);
        }
        if (inside(from, "src/signer")) {
          for (const forbidden of ["src/policy", "src/registry", "src/services", "src/agentflow"]) {
            assert.ok(!inside(target, forbidden), `${from} imports ${target}`);
          }
        }
      }
    }
  });
});
