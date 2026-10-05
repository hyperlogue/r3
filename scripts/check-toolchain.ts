import assert from "node:assert/strict";
import { devDependencies, engines } from "../toolchain/package.json";
import lock from "../toolchain/package-lock.json";

assert.deepEqual(lock.packages[""].devDependencies, devDependencies, "Toolchain lock is stale");
assert.deepEqual(lock.packages[""].engines, engines, "Toolchain Node engine lock is stale");
const packages = lock.packages as Record<string, { version?: string; integrity?: string }>;
for (const [name, version] of Object.entries(devDependencies)) {
  assert.equal(packages[`node_modules/${name}`]?.version, version, `${name} lock version`);
}
for (const platform of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]) {
  for (const [name, version] of [
    [`@oven/bun-${platform.replace("arm64", "aarch64")}`, devDependencies.bun],
    [`@biomejs/cli-${platform}`, devDependencies["@biomejs/biome"]],
  ]) {
    assert.equal(packages[`node_modules/${name}`]?.version, version, `${name} lock version`);
    assert(packages[`node_modules/${name}`]?.integrity, `${name} archive integrity is required`);
  }
}
assert.equal(Bun.version, devDependencies.bun, "Bun version");
for (const [command, version] of [
  ["biome", devDependencies["@biomejs/biome"]],
  ["npm", devDependencies.npm],
  ["node", engines.node],
]) {
  const result = Bun.spawnSync([command!, "--version"], { stdout: "pipe", stderr: "pipe" });
  assert.equal(result.exitCode, 0, `${command} --version failed`);
  assert.equal(
    result.stdout
      .toString()
      .trim()
      .replace(/^(?:Version: |v)/, ""),
    version,
    command,
  );
}
console.log("Toolchain versions match the shared manifest and lockfile");
