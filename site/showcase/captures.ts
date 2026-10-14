import { createHash } from "node:crypto";
import { join } from "node:path";

export const captureSpecs = [
  { file: "fieldwork-light.png", theme: "light", width: 1240, height: 740, scale: 3 },
  { file: "fieldwork-dark.png", theme: "dark", width: 1240, height: 740, scale: 3 },
  { file: "fieldwork-mobile-light.png", theme: "light", width: 390, height: 740, scale: 3 },
  { file: "fieldwork-mobile-dark.png", theme: "dark", width: 390, height: 740, scale: 3 },
  {
    file: "fieldwork-comment-light.png",
    theme: "light",
    width: 520,
    height: 440,
    scale: 3,
    scene: "components",
  },
  {
    file: "fieldwork-comment-dark.png",
    theme: "dark",
    width: 520,
    height: 440,
    scale: 3,
    scene: "components",
  },
] as const;

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export interface CaptureManifest {
  captures: Array<(typeof captureSpecs)[number] & { sha256: string }>;
}

export async function verifyCaptures(assets: string) {
  const refresh =
    "Run bun --no-env-file site/capture-showcase.ts with R3_TEST_BROWSER set, then rebuild.";
  try {
    const manifest: CaptureManifest = await Bun.file(
      join(assets, "fieldwork-captures.json"),
    ).json();
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
    throw new Error(`Workspace captures are missing or invalid. ${refresh}`, { cause: error });
  }
}
