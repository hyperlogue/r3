import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

type Workflow = { jobs: { build: { steps: { name?: string; run?: string }[] } } };
type Call = { args: string[]; base?: string; url?: string };
const root = join(import.meta.dir, "..");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function buildStep(file: string, name: string) {
  const workflow = Bun.YAML.parse(
    readFileSync(join(root, ".github/workflows", file), "utf8"),
  ) as Workflow;
  const run = workflow.jobs.build.steps.find((step) => step.name === name)?.run;
  if (!run) throw new Error(`Missing workflow step: ${name}`);
  return run;
}

const pagesBuild = buildStep("pages.yml", "Build Pages site");
const ciBuild = buildStep("ci.yml", "Check website builds");

// Execute the actual workflow shell. Replace only the builders, so tests cover
// selection, failure propagation, output requirements, and deployment inputs.
function fixture(site: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "pages-workflow-test-"));
  dirs.push(dir);
  mkdirSync(join(dir, "bin"));
  if (site) {
    mkdirSync(join(dir, "site"));
    writeFileSync(join(dir, "site/build.ts"), "// Builder supplied by the website.\n");
  }
  writeFileSync(join(dir, "calls.json"), "[]");
  writeFileSync(
    join(dir, "bin/bun"),
    `#!${process.execPath}
import { mkdirSync } from "node:fs";
const args = process.argv.slice(2);
const calls = await Bun.file("calls.json").json();
calls.push({ args, base: process.env.R3_SITE_BASE, url: process.env.R3_SITE_URL });
await Bun.write("calls.json", JSON.stringify(calls));
if (args[0] === "site/build.ts") {
  if (process.env.TEST_BUILD_FAIL) process.exit(12);
} else if (args[0] === "run" && ["gen:demo", "build:demo"].includes(args[1])) {
  process.exit(0);
} else if (args[0] !== "run" || args[1] !== "stage:pages") {
  throw new Error("Unexpected build command");
}
mkdirSync("dist/pages", { recursive: true });
for (const file of ["index.html", "404.html"]) {
  if (file !== process.env.TEST_MISSING_OUTPUT) {
    await Bun.write("dist/pages/" + file, "<!doctype html><title>Build output</title>");
  }
}
`,
    { mode: 0o755 },
  );
  return {
    run(script: string, env: Record<string, string> = {}) {
      return spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: [join(dir, "bin"), dirname(process.execPath), process.env.PATH].join(delimiter),
          R3_SITE_BASE: "/project",
          R3_SITE_URL: "https://example.test/project",
          ...env,
        },
      });
    },
    calls: () => JSON.parse(readFileSync(join(dir, "calls.json"), "utf8")) as Call[],
  };
}

test("Pages retains the complete demo build before the website entrypoint exists", () => {
  const build = fixture(false);
  expect(build.run(pagesBuild).status).toBe(0);
  expect(build.calls().map((call) => call.args)).toEqual([
    ["run", "gen:demo"],
    ["run", "build:demo"],
    ["run", "stage:pages"],
  ]);
});

test("Pages delegates the complete build and URL inputs to the website entrypoint", () => {
  const build = fixture(true);
  expect(build.run(pagesBuild).status).toBe(0);
  expect(build.calls()).toEqual([
    { args: ["site/build.ts"], base: "/project", url: "https://example.test/project" },
  ]);
});

test("a failed website build cannot fall back to publishing the demo", () => {
  const build = fixture(true);
  expect(build.run(pagesBuild, { TEST_BUILD_FAIL: "1" }).status).toBe(12);
  expect(build.calls()).toHaveLength(1);
});

for (const output of ["index.html", "404.html"]) {
  test(`Pages refuses a website missing ${output}`, () => {
    const build = fixture(true);
    expect(build.run(pagesBuild, { TEST_MISSING_OUTPUT: output }).status).not.toBe(0);
    expect(build.calls()).toHaveLength(1);
  });
}

test("CI leaves the demo-only checkout buildable and checks both website mount paths", () => {
  const absent = fixture(false);
  expect(absent.run(ciBuild).status).toBe(0);
  expect(absent.calls()).toEqual([]);

  const present = fixture(true);
  expect(present.run(ciBuild).status).toBe(0);
  expect(present.calls()).toEqual([
    { args: ["site/build.ts"], base: "/r3", url: "https://example.test/r3" },
    { args: ["site/build.ts"], base: "", url: "https://example.test" },
  ]);
});
