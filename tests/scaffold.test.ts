import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

const workspacePackages = [
  "@devlog/config",
  "@devlog/core",
  "@devlog/adapters",
  "@devlog/agent",
  "@devlog/cli",
  "@devlog/server",
] as const;

interface PackageManifest {
  name?: string;
  type?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  pnpm?: { overrides?: Record<string, string> };
}

function readJson(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, "utf8")) as PackageManifest;
}

function packageManifests(): string[] {
  const dirs = [join(root, "packages"), join(root, "apps")];
  const manifests: string[] = [];
  for (const dir of dirs) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      manifests.push(join(dir, entry.name, "package.json"));
    }
  }
  return manifests;
}

test(".nvmrc pins Node 22", () => {
  expect(readFileSync(join(root, ".nvmrc"), "utf8").trim()).toBe("22");
});

test("TypeScript base config is strict ESM", () => {
  const tsconfig = JSON.parse(
    readFileSync(join(root, "tsconfig.base.json"), "utf8"),
  ) as { compilerOptions: Record<string, unknown> };

  expect(tsconfig.compilerOptions.strict).toBe(true);
  expect(tsconfig.compilerOptions.module).toBe("NodeNext");
  expect(tsconfig.compilerOptions.moduleResolution).toBe("NodeNext");
});

test("zod is declared once, at the workspace root", () => {
  const rootManifest = readJson(join(root, "package.json"));
  expect(rootManifest.type).toBe("module");
  expect(rootManifest.dependencies?.zod).toBe("catalog:");
  expect(rootManifest.pnpm).toBeUndefined();

  const workspaceYaml = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  expect(workspaceYaml.match(/zod:\s*"4\.6\.5"/g)).toEqual(['zod: "4.6.5"']);
  expect(workspaceYaml.match(/zod:\s*"catalog:"/g)).toEqual([
    'zod: "catalog:"',
  ]);

  const manifests = packageManifests();
  expect(manifests).toHaveLength(workspacePackages.length);

  const names = manifests.map((path) => readJson(path).name);
  expect([...names].sort()).toEqual([...workspacePackages].sort());

  for (const path of manifests) {
    const manifest = readJson(path);
    expect(manifest.type).toBe("module");
    expect(manifest.dependencies?.zod).toBeUndefined();
    expect(manifest.devDependencies?.zod).toBeUndefined();
    expect(manifest.peerDependencies?.zod).toBeUndefined();
    expect(manifest.optionalDependencies?.zod).toBeUndefined();
  }
});
