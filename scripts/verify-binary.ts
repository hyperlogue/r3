// Exercise the shipped executable outside the checkout, with private storage.
import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { localBootstrap } from "../cli/local-bootstrap.ts";
import { R3_VERSION } from "../shared/version.ts";

export async function verifyBinary(path: string, platform: string) {
  assert.equal(`${process.platform}-${process.arch}`, platform, "Use a native verification runner");
  // macOS's default temporary directory can exceed the Unix socket path limit.
  const root = await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "r3-bin-"));
  const binary = join(root, "r3");
  const runtime = join(root, "runtime");
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port;
  await reservation.stop(true);
  const env = {
    PATH: process.env.PATH,
    TMPDIR: root,
    XDG_STATE_HOME: join(root, "state"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_RUNTIME_DIR: runtime,
    R3_DB: join(root, "store.sqlite"),
    R3_PORT: String(port),
    R3_BIND: "127.0.0.1",
    R3_AGENT_SESSION: "binary-verification",
  };
  const run = async (args: string[]) => {
    const child = Bun.spawn(args, {
      cwd: root,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    try {
      const [out, err, status] = await Promise.all([
        new Response(child.stdout).arrayBuffer(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      assert.equal(status, 0, `${basename(args[0]!)} ${args.slice(1).join(" ")} failed: ${err}`);
      return Buffer.from(out);
    } finally {
      clearTimeout(timer);
    }
  };
  const cli = async (...args: string[]) => (await run([binary, ...args])).toString("utf8");
  let started = false;
  try {
    await mkdir(runtime, { mode: 0o700 });
    await copyFile(path, binary);
    await chmod(binary, 0o755);
    // Rosetta can run a mislabeled Intel binary on an ARM runner. Check the
    // executable header as well as the runner before testing runtime behavior.
    const header = Buffer.from(await Bun.file(binary).slice(0, 32).arrayBuffer());
    assert.equal(header.length, 32, "Truncated executable header");
    if (process.platform === "darwin") {
      assert.equal(header.readUInt32LE(0), 0xfeedfacf, "Expected a thin Mach-O64 executable");
      assert.equal(
        header.readUInt32LE(4),
        process.arch === "arm64" ? 0x100000c : 0x1000007,
        "Mach-O architecture",
      );
      await run(["codesign", "--verify", "--strict", "--verbose=2", binary]);
    } else {
      assert.equal(
        header.subarray(0, 6).toString("hex"),
        "7f454c460201",
        "Expected ELF64 little endian",
      );
      assert.equal(
        header.readUInt16LE(18),
        process.arch === "arm64" ? 183 : 62,
        "ELF architecture",
      );
    }
    assert.match(await cli("--help"), /published artifacts/);
    // Mark before starting so even a partially failed start gets cleaned up.
    started = true;
    await cli("start");
    const daemon = JSON.parse(await readFile(join(runtime, "r3/daemon.json"), "utf8"));
    assert.equal(daemon.version, R3_VERSION);
    const { token } = await localBootstrap<{ token: string }>(daemon.bootstrapSocket, "bootstrap");
    const request = async (path: string) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        headers: { "x-r3-token": token },
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(response.status, 200, `GET ${path}`);
      return response;
    };
    const health = await (await request("/api/health")).json();
    assert.equal(health.version, R3_VERSION);
    assert.equal(health.protocol, "artifacts-v2");
    const html = await (await request("/")).text();
    const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => m[1]!);
    assert(
      assets.some((p) => p.endsWith(".js")),
      "Embedded application JavaScript missing",
    );
    assert(
      assets.some((p) => p.endsWith(".css")),
      "Embedded application CSS missing",
    );
    for (const asset of assets) {
      const response = await request(asset);
      assert.match(
        response.headers.get("content-type") ?? "",
        asset.endsWith(".js") ? /(?:java|ecma)script/ : /text\/css/,
        `Wrong content type for ${asset}`,
      );
      assert((await response.arrayBuffer()).byteLength > 0);
    }

    const directory = join(root, "publication");
    await mkdir(directory);
    await writeFile(join(directory, "hello.ts"), 'export const greeting = "verified";\n');
    const bytes = new Uint8Array([0, 128, 255]);
    await writeFile(join(directory, "bytes.bin"), bytes);
    const publication = JSON.parse(
      await cli(
        "create",
        "--kind",
        "files",
        "--dir",
        directory,
        "--title",
        "Binary verification",
        "--no-listen",
        "--json",
      ),
    );
    assert.equal(publication.version.seq, 1);
    const id = publication.artifact.id;
    const source = JSON.parse(
      await cli("source", id, "--version", "1", "--file", "hello.ts", "--json"),
    );
    assert.equal(source.kind, "text");
    assert(
      source.lines.some((line: { html: string }) => line.html.includes("<span")),
      "Embedded highlighting worker failed",
    );
    await cli("stop");
    started = false;
    // A second process must reopen SQLite and immutable blobs successfully.
    started = true;
    await cli("start");
    const saved = JSON.parse(await cli("show", id, "--json"));
    assert.equal(saved.id, id);
    const downloaded = await run([binary, "download", id, "--version", "1", "--file", "bytes.bin"]);
    assert.deepEqual(new Uint8Array(downloaded), bytes);
    console.log(
      `Verified ${platform}: CLI, daemon, embedded assets, publication and restart${process.platform === "darwin" ? ", code signature" : ""}`,
    );
  } finally {
    try {
      if (started) await cli("stop");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) {
  const [binary, platform] = process.argv.slice(2);
  if (!binary || !platform) throw new Error("Usage: verify-binary.ts <binary> <os-arch>");
  await verifyBinary(resolve(binary), platform);
}
