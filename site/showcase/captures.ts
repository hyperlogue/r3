import { createHash } from "node:crypto";
import { join } from "node:path";

export const storyCaptureSpecs = (
  ["prototype", "proposal", "explainer", "code-review"] as const
).flatMap((scene) =>
  (["start", "feedback", "result"] as const).flatMap((step) =>
    (["light", "dark"] as const).map((theme) => ({
      file: `fieldwork-story-${scene}-${step}-${theme}.png`,
      scene,
      step,
      theme,
      width: 1240,
      height: scene === "code-review" ? (step === "start" ? 320 : 480) : 740,
      scale: 3,
    })),
  ),
);

export const captureSpecs = [
  ...storyCaptureSpecs,
  ...(["light", "dark"] as const).map((theme) => ({
    file: `fieldwork-privacy-${theme}.png`,
    theme,
    width: 1240,
    height: 660,
    scale: 3,
    recorded: true,
  })),
  { file: "fieldwork-light.png", theme: "light", width: 1240, height: 740, scale: 3 },
  { file: "fieldwork-dark.png", theme: "dark", width: 1240, height: 740, scale: 3 },
  { file: "fieldwork-mobile-light.png", theme: "light", width: 390, height: 740, scale: 3 },
  { file: "fieldwork-mobile-dark.png", theme: "dark", width: 390, height: 740, scale: 3 },
  ...(["explainer", "brief"] as const).flatMap((scene) =>
    (["light", "dark"] as const).flatMap((theme) => [
      { file: `fieldwork-${scene}-${theme}.png`, scene, theme, width: 1240, height: 740, scale: 3 },
      {
        file: `fieldwork-${scene}-mobile-${theme}.png`,
        scene,
        theme,
        width: 390,
        height: 740,
        scale: 3,
      },
    ]),
  ),
  {
    file: "fieldwork-comment-light.png",
    theme: "light",
    width: 820,
    height: 540,
    scale: 3,
    scene: "components",
  },
  {
    file: "fieldwork-comment-dark.png",
    theme: "dark",
    width: 820,
    height: 540,
    scale: 3,
    scene: "components",
  },
  ...(["light", "dark"] as const).map((theme) => ({
    file: `fieldwork-comparison-${theme}.png`,
    theme,
    width: 1240,
    height: 480,
    scale: 3,
    scene: "components" as const,
    comparison: true,
  })),
  ...(["light", "dark"] as const).flatMap((theme) => [
    {
      file: `fieldwork-media-image-${theme}.png`,
      theme,
      width: 1000,
      height: 600,
      scale: 3,
      scene: "media" as const,
    },
    {
      file: `fieldwork-media-video-${theme}.png`,
      theme,
      width: 1000,
      height: 600,
      scale: 3,
      scene: "media-video" as const,
    },
    {
      file: `fieldwork-media-comparison-${theme}.png`,
      theme,
      width: 1000,
      height: 600,
      scale: 3,
      scene: "media" as const,
      mediaComparison: true,
    },
  ]),
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
