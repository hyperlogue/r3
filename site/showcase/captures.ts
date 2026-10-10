import { createHash } from "node:crypto";
import { join } from "node:path";

export const captureSpecs = [
  { file: "fieldwork-light.png", theme: "light", width: 1240, height: 740, scale: 3 },
  { file: "fieldwork-dark.png", theme: "dark", width: 1240, height: 740, scale: 3 },
  { file: "fieldwork-mobile-light.png", theme: "light", width: 390, height: 740, scale: 3 },
  { file: "fieldwork-mobile-dark.png", theme: "dark", width: 390, height: 740, scale: 3 },
] as const;

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// Fingerprint the actual shipped JS, CSS and document, including transitive
// product components and dependencies. Build paths and mount points are absent.
export async function showcaseHash(directory: string) {
  const files = await Array.fromAsync(
    new Bun.Glob("**/*").scan({ cwd: directory, onlyFiles: true }),
  );
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    hash.update(file).update("\0");
    hash.update(sha256(await Bun.file(join(directory, file)).bytes())).update("\0");
  }
  return hash.digest("hex");
}

export interface CaptureManifest {
  bundleHash: string;
  captures: Array<(typeof captureSpecs)[number] & { sha256: string }>;
}

export async function verifyCaptures(bundleHash: string, assets: string) {
  const refresh =
    "Run bun --no-env-file site/capture-showcase.ts with R3_TEST_BROWSER set, then rebuild.";
  try {
    const manifest: CaptureManifest = await Bun.file(
      join(assets, "fieldwork-captures.json"),
    ).json();
    if (manifest.bundleHash !== bundleHash) throw new Error("The real workspace bundle changed");
    if (manifest.captures.length !== captureSpecs.length) throw new Error("Incomplete capture set");
    for (const spec of captureSpecs) {
      const captured = manifest.captures.find((capture) => capture.file === spec.file);
      if (
        !captured ||
        Object.entries(spec).some(([key, value]) => captured[key as keyof typeof spec] !== value)
      )
        throw new Error(`Capture settings changed: ${spec.file}`);
      const bytes = Buffer.from(await Bun.file(join(assets, spec.file)).bytes());
      if (sha256(bytes) !== captured.sha256) throw new Error(`Capture bytes changed: ${spec.file}`);
      if (
        bytes.toString("hex", 0, 8) !== "89504e470d0a1a0a" ||
        bytes.readUInt32BE(16) !== spec.width * spec.scale ||
        bytes.readUInt32BE(20) !== spec.height * spec.scale
      )
        throw new Error(`Incorrect capture resolution: ${spec.file}`);
    }
  } catch (error) {
    throw new Error(`Workspace captures are missing or stale. ${refresh}`, { cause: error });
  }
}
