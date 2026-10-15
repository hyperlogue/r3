import { createHash } from "node:crypto";
import { join } from "node:path";
import { features } from "./features.ts";

interface VideoManifest {
  clips: Array<{
    id: string;
    duration: number;
    width: number;
    height: number;
    files: Record<string, string>;
  }>;
}

export async function verifyFeatureVideos(directory: string) {
  const manifest: VideoManifest = await Bun.file(join(directory, "manifest.json")).json();
  for (const feature of features) {
    const clip = manifest.clips.find(({ id }) => id === feature.id);
    if (
      !clip ||
      clip.duration !== feature.duration ||
      clip.duration > 30 ||
      clip.width !== 1600 ||
      clip.height !== 1000
    )
      throw new Error(`Feature video metadata is invalid: ${feature.id}`);
    for (const extension of ["mp4", "jpg", "transcript.txt"]) {
      const name = `${feature.id}.${extension}`;
      const bytes = await Bun.file(join(directory, name)).bytes();
      if (createHash("sha256").update(bytes).digest("hex") !== clip.files[name])
        throw new Error(
          `Feature video asset is invalid: ${name}. Hydrate Git LFS before building.`,
        );
    }
  }
}
