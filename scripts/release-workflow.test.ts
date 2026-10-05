import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

type Step = {
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
  "working-directory"?: string;
  with?: { path: string; pattern?: string; "merge-multiple"?: boolean };
};
const root = join(import.meta.dir, "..");
const workflow = Bun.YAML.parse(
  readFileSync(join(root, ".github/workflows/release.yml"), "utf8"),
) as {
  jobs: Record<
    string,
    { environment?: string; steps: Step[]; needs?: string[] | string; uses?: string }
  >;
};
const platforms = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
const assets = Object.fromEntries(platforms.map((p) => [`r3-${p}`, `published bytes for ${p}`]));
type State = {
  release: Record<string, string> | null;
  published: Record<string, string>;
  calls: string[];
  apiStatus?: number;
  draft?: boolean;
  missingAsset?: string;
  failPublish?: string;
  commitBeforeFailure?: boolean;
};
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Run the workflow's actual shell steps and staging/wait scripts. Only external
// GitHub/npm operations and the build artifact download are replaced.
function fixture(initial: Partial<State> = {}, version = "1.2.3") {
  const dir = mkdtempSync(join(tmpdir(), "release-workflow-test-"));
  dirs.push(dir);
  for (const sub of ["bin", "npm", "scripts", "shared", "temp"]) mkdirSync(join(dir, sub));
  for (const script of ["stage-npm-packages.ts", "wait-for-npm-packages.sh"]) {
    copyFileSync(join(root, "scripts", script), join(dir, "scripts", script));
  }
  writeFileSync(
    join(dir, "shared/version.ts"),
    `export const R3_VERSION = ${JSON.stringify(version)};`,
  );
  writeFileSync(join(dir, "npm/package.json"), JSON.stringify({ name: "@hyperlogue/r3", version }));
  writeFileSync(join(dir, "npm/LICENSE"), "fixture license");
  writeFileSync(
    join(dir, "CHANGELOG.md"),
    `## [${version}]\n\nRelease notes.\n\n## [1.0.0]\nOld.\n`,
  );
  const statePath = join(dir, "state.json");
  writeFileSync(statePath, JSON.stringify({ release: null, published: {}, calls: [], ...initial }));
  const fakeCommand = `#!/usr/bin/env bun
const fs = require("node:fs");
const path = require("node:path");
const statePath = process.env.RELEASE_TEST_STATE;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
function done(code = 0) {
  fs.writeFileSync(statePath, JSON.stringify(state));
  process.exit(code);
}
state.calls.push(tool + " " + args.join(" "));
if (tool === "gh") {
  if (args[0] === "api") {
    const status = state.apiStatus ?? (state.release ? 200 : 404);
    console.log("HTTP/2.0 " + status + "\\r\\nContent-Type: application/json\\r\\n\\r\\n" +
      JSON.stringify({ draft: state.draft ?? false }));
    done(status === 200 ? 0 : 1);
  }
  if (args[0] === "release" && args[1] === "create") {
    if (state.release) done(1);
    state.release = Object.fromEntries(args.filter(a => a.startsWith("dist/r3-"))
      .map(a => [path.basename(a), fs.readFileSync(a, "utf8")]));
    done();
  }
  if (args[0] === "release" && args[1] === "download") {
    if (!state.release) done(1);
    const dir = args[args.indexOf("-D") + 1];
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, bytes] of Object.entries(state.release)) {
      if (name !== state.missingAsset) fs.writeFileSync(path.join(dir, name), bytes);
    }
    done();
  }
} else if (tool === "npm") {
  if (args[0] === "install" || args[0] === "--version") done();
  if (args[0] === "view") {
    if (!args.includes("--prefer-online") || !(args[1] in state.published)) done(1);
    console.log(args[1].slice(args[1].lastIndexOf("@") + 1));
    done();
  }
  if (args[0] === "publish") {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    const spec = pkg.name + "@" + pkg.version;
    state.calls.push("publish " + spec);
    if (spec in state.published) done(1);
    const fail = state.failPublish === pkg.name;
    if (!fail || state.commitBeforeFailure) {
      state.published[spec] = fs.existsSync("bin/r3") ? fs.readFileSync("bin/r3", "utf8") : "launcher";
    }
    if (fail) { delete state.failPublish; done(1); }
    done();
  }
}
console.error("Unexpected external command: " + tool + " " + args.join(" "));
done(1);
`;
  for (const tool of ["gh", "npm"]) {
    writeFileSync(join(dir, "bin", tool), fakeCommand, { mode: 0o755 });
  }
  const state = () => JSON.parse(readFileSync(statePath, "utf8")) as State;
  function run(artifactExpired = false) {
    rmSync(join(dir, "dist"), { recursive: true, force: true });
    const output = join(dir, "temp/output");
    writeFileSync(output, "");
    for (const step of workflow.jobs.publish.steps) {
      if (step.if) {
        expect(step.if).toBe("steps.release.outputs.exists == 'false'");
        if (!readFileSync(output, "utf8").includes("exists=false")) continue;
      }
      if (step.uses?.startsWith("actions/download-artifact@")) {
        if (artifactExpired) throw new Error("Build artifact expired");
        const dest = join(dir, step.with!.path);
        mkdirSync(dest, { recursive: true });
        for (const name of Object.keys(assets))
          writeFileSync(join(dest, name), `build bytes: ${name}`);
      }
      if (!step.run) continue;
      const result = spawnSync(
        "bash",
        ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run],
        {
          cwd: join(dir, step["working-directory"] ?? "."),
          encoding: "utf8",
          timeout: 15_000,
          env: {
            // Fake commands receive no ambient GitHub/npm credentials.
            PATH: [join(dir, "bin"), dirname(process.execPath), process.env.PATH].join(delimiter),
            RELEASE_TEST_STATE: statePath,
            VERSION: version,
            GITHUB_REPOSITORY: "example/project",
            GITHUB_OUTPUT: output,
            RUNNER_TEMP: join(dir, "temp"),
            NPM_VISIBILITY_TIMEOUT_SECONDS: "10",
          },
        },
      );
      if (result.error) throw result.error;
      if (result.status !== 0) return { failed: step.name, output: result.stdout + result.stderr };
    }
    return { failed: undefined, output: "" };
  }
  return { dir, state, run };
}

test("publication has one approval gate", () => {
  expect(Object.entries(workflow.jobs).filter(([, job]) => job.environment)).toEqual([
    ["publish", expect.objectContaining({ environment: "release" })],
  ]);
});

test("publication requires native verification and downloads only its outputs", () => {
  expect(workflow.jobs.publish.needs).toContain("binaries");
  expect(workflow.jobs.binaries.uses).toBe("./.github/workflows/verify-binaries.yml");
  const downloads = workflow.jobs.publish.steps.filter((step) =>
    step.uses?.startsWith("actions/download-artifact@"),
  );
  expect(downloads).toHaveLength(1);
  expect(downloads[0]!.with).toEqual({
    pattern: "r3-verified-*",
    "merge-multiple": true,
    path: "dist",
  });
});

test("an npm timeout retries without touching the immutable release or expired artifact", () => {
  const f = fixture({ failPublish: "@hyperlogue/r3-darwin-x64", commitBeforeFailure: true });
  expect(f.run().failed).toBe("Publish platform binary packages");
  const first = f.state();
  expect(Object.keys(first.published)).toHaveLength(2);
  expect(f.run(true).failed).toBeUndefined();
  const retried = f.state();
  expect(retried.release).toEqual(first.release);
  expect(retried.calls.filter((c) => c.startsWith("gh release create"))).toHaveLength(1);
  expect(retried.calls.some((c) => c.startsWith("gh release upload"))).toBe(false);
  expect(retried.calls.filter((c) => c.startsWith("publish "))).toHaveLength(5);
  for (const platform of platforms) {
    expect(retried.published[`@hyperlogue/r3-${platform}@1.2.3`]).toBe(
      first.release![`r3-${platform}`],
    );
  }
  expect(Object.keys(retried.published).at(-1)).toBe("@hyperlogue/r3@1.2.3");
  expect(f.run(true).failed).toBeUndefined();
  expect(f.state().calls.filter((c) => c.startsWith("publish "))).toHaveLength(5);
});

test("an existing release supplies npm bytes without a build artifact", () => {
  const f = fixture({ release: assets });
  expect(f.run(true).failed).toBeUndefined();
  expect(f.state().calls.some((c) => /^gh release (create|upload)/.test(c))).toBe(false);
  for (const platform of platforms) {
    expect(f.state().published[`@hyperlogue/r3-${platform}@1.2.3`]).toBe(assets[`r3-${platform}`]);
  }
});

test("a launcher failure retries after skipping all published platforms", () => {
  const f = fixture({ release: assets, failPublish: "@hyperlogue/r3" });
  expect(f.run(true).failed).toBe("Publish npm launcher");
  expect(f.run(true).failed).toBeUndefined();
  expect(f.state().calls.filter((c) => c.startsWith("publish @hyperlogue/r3-"))).toHaveLength(4);
  expect(Object.keys(f.state().published)).toHaveLength(5);
});

test.each([403, 500])("GitHub API failure %i stops before publication", (apiStatus) => {
  const f = fixture({ apiStatus });
  expect(f.run(true).failed).toBe("Check for an existing GitHub Release");
  expect(f.state().calls).toHaveLength(1);
});

test("an unfinished draft stops before npm publication", () => {
  const f = fixture({ release: assets, draft: true });
  expect(f.run(true).failed).toBe("Check for an existing GitHub Release");
  expect(f.state().published).toEqual({});
});

test("a missing published asset cannot fall back to leftover build bytes", () => {
  const f = fixture({ missingAsset: "r3-linux-x64" });
  expect(f.run().failed).toBe("Download published release assets");
  expect(f.state().published).toEqual({});
});

test("prerelease flags and changelog notes survive the combined publication", () => {
  const f = fixture({}, "1.2.3-rc.1");
  expect(f.run().failed).toBeUndefined();
  expect(f.state().calls.find((c) => c.startsWith("gh release create"))).toContain("--prerelease");
  expect(f.state().calls.find((c) => c.includes("--tag"))).toContain("--tag next");
  expect(readFileSync(join(f.dir, "temp/relnotes.md"), "utf8").trim()).toBe("Release notes.");
});
