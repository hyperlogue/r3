import type { ArtifactDetail } from "../../shared/artifacts.ts";
import {
  type ArtifactLocation,
  artifactLocationSearch,
  readArtifactLocation,
} from "./artifact-navigation.ts";

const KEY = "r3-workspace-selections-1";
const LIMIT = 64;
function isLocation(value: unknown): value is ArtifactLocation {
  if (!value || typeof value !== "object") return false;
  const { versionSeq, path, representation, threadId } = value as ArtifactLocation;
  const text = (value: unknown) =>
    value === null || (typeof value === "string" && value.length <= 4096);
  return (
    Number.isSafeInteger(versionSeq) &&
    versionSeq! > 0 &&
    text(path) &&
    text(threadId) &&
    ["source", "rendered", "diff", "media"].includes(representation)
  );
}

// Optional, tab-local reading metadata. Never replay a saved thread as a Locate
// action: its original target can belong to a different publication.
export class ArtifactWorkspaceSelections {
  private readonly entries = new Map<string, ArtifactLocation>();
  constructor(private readonly storage: () => Pick<Storage, "getItem" | "setItem"> | null) {
    try {
      const entries: unknown = JSON.parse(storage()?.getItem(KEY) ?? "[]");
      if (Array.isArray(entries))
        for (const entry of entries.slice(-LIMIT))
          if (Array.isArray(entry) && typeof entry[0] === "string" && isLocation(entry[1]))
            this.entries.set(entry[0], entry[1]);
    } catch {
      /* Browser storage is optional. */
    }
  }
  restore(detail: ArtifactDetail, search: string): ArtifactLocation {
    const requested = readArtifactLocation(detail.kind, search);
    const versionSeq = requested.versionSeq ?? detail.versions.at(-1)?.seq ?? null;
    const view = readArtifactLocation(
      detail.kind,
      artifactLocationSearch({ versionSeq }),
      this.entries.get(detail.id),
    );
    if (!detail.threads.some((thread) => thread.id === view.threadId)) view.threadId = null;
    return view;
  }
  save(id: string, view: ArtifactLocation) {
    if (!isLocation(view)) return;
    this.entries.delete(id);
    this.entries.set(id, { ...view });
    while (this.entries.size > LIMIT) this.entries.delete(this.entries.keys().next().value!);
    this.flush();
  }
  forget(id: string) {
    this.entries.delete(id);
    this.flush();
  }
  private flush() {
    try {
      this.storage()?.setItem(KEY, JSON.stringify([...this.entries]));
    } catch {
      /* Keep selections in memory when storage is unavailable. */
    }
  }
}
export const artifactWorkspaceSelections = new ArtifactWorkspaceSelections(() => sessionStorage);
