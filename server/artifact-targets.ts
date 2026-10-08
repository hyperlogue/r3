import type {
  ArtifactKind,
  ArtifactMessageContext,
  ArtifactSourceRange,
  ArtifactTarget,
  DiffLocator,
  RenderedLocator,
  Representation,
  SourceLocator,
  TextQuote,
} from "../shared/artifacts.ts";
import { MAX_RENDERED_HEIGHT } from "../shared/artifacts.ts";
import { animatedImage, FULL_MEDIA_BOX, targetableMedia } from "../shared/media-target.ts";
import { normalizeRenderedText } from "../shared/rendered-text.ts";
import {
  ArtifactError,
  optionalText,
  requireArtifactPath,
  requireObject,
  requireSequence,
  requireString,
} from "./artifact-validation.ts";
import type { ArtifactStore } from "./artifacts.ts";
import { parseUnifiedDiff } from "./git.ts";

export const TARGET_LIMITS = {
  quote: 16_384,
  lines: 100,
  selector: 4096,
  context: 512,
  label: 200,
} as const;

function requireRepresentation(kind: ArtifactKind, value: unknown): Representation {
  if (
    (kind === "files" && (value === "source" || value === "rendered" || value === "media")) ||
    (kind === "html" && value === "rendered") ||
    (kind === "diff" && value === "diff")
  )
    return value;
  throw new ArtifactError("Representation is incompatible with this artifact kind");
}

function nativeQuote(value: unknown): TextQuote {
  const body = requireObject(value, "Text quote");
  const quote = normalizeRenderedText(requireString(body.quote, "quote", TARGET_LIMITS.quote));
  const prefix = optionalText(body.prefix, "prefix", TARGET_LIMITS.context);
  const suffix = optionalText(body.suffix, "suffix", TARGET_LIMITS.context);
  return {
    quote,
    ...(prefix === null ? {} : { prefix: normalizeRenderedText(prefix) }),
    ...(suffix === null ? {} : { suffix: normalizeRenderedText(suffix) }),
  };
}

function sourceLocator(value: unknown): SourceLocator {
  const locator = requireObject(value, "Source locator");
  const start = requireSequence(locator.start);
  const end = requireSequence(locator.end);
  if (end < start || end - start >= TARGET_LIMITS.lines)
    throw new ArtifactError("Invalid target line range");
  return {
    start,
    end,
    quote: requireString(locator.quote, "quote", TARGET_LIMITS.quote).replaceAll("\r\n", "\n"),
  };
}

function renderedLocator(value: unknown): RenderedLocator {
  const locator = requireObject(value, "Rendered locator");
  const selector = requireString(locator.selector, "selector", TARGET_LIMITS.selector);
  const label =
    locator.label === undefined
      ? undefined
      : normalizeRenderedText(requireString(locator.label, "label", TARGET_LIMITS.label));
  const text = locator.quote === undefined ? {} : nativeQuote(locator);
  const route = optionalText(locator.route, "route", 2048);
  if (route !== null && !/^[?#]/.test(route)) {
    throw new ArtifactError("Rendered route must be a document-local query or fragment");
  }
  let viewport: RenderedLocator["viewport"];
  if (locator.viewport !== undefined) {
    const size = requireObject(locator.viewport, "viewport");
    const width = size.width;
    const height = size.height;
    if (
      typeof width !== "number" ||
      typeof height !== "number" ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0 ||
      width > 100_000 ||
      height > MAX_RENDERED_HEIGHT
    ) {
      throw new ArtifactError("Invalid rendered viewport");
    }
    viewport = { width, height };
  }
  return {
    selector,
    ...(label === undefined ? {} : { label }),
    ...text,
    ...(route === null ? {} : { route }),
    ...(viewport ? { viewport } : {}),
  };
}

function checkSourceQuote(lines: string[], locator: SourceLocator): void {
  if (
    lines.length !== locator.end - locator.start + 1 ||
    !lines.join("\n").includes(locator.quote)
  ) {
    throw new ArtifactError("Quote and range must match the selected version's captured source");
  }
}

// Version and representation are explicit on every target and reply context.
// Source/diff validation uses retained bytes; a dynamic rendered DOM supplies
// native evidence without being reverse-mapped into an invented source range.
export class ArtifactTargets {
  constructor(private readonly artifacts: ArtifactStore) {}

  context(id: string, value: unknown): ArtifactMessageContext {
    const context = requireObject(value, "Message context");
    if (context.versionSeq === null && context.representation === null) {
      this.artifacts.get(id);
      return { versionSeq: null, representation: null };
    }
    const versionSeq = requireSequence(context.versionSeq);
    const version = this.artifacts.version(id, versionSeq);
    const representation =
      context.representation === null
        ? null
        : requireRepresentation(version.kind, context.representation);
    return { versionSeq, representation };
  }

  async target(id: string, value: unknown, allowMissingDocument = false): Promise<ArtifactTarget> {
    const target = requireObject(value, "Target");
    const artifact = this.artifacts.get(id);
    if (target.kind === "artifact") return { kind: "artifact" };
    if (target.kind === "artifact_summary")
      throw new ArtifactError("Artifact overview targets are read-only historical evidence");
    if (target.kind === "version_summary")
      throw new ArtifactError("Version description targets are read-only historical evidence");
    const versionSeq = requireSequence(target.versionSeq);
    this.artifacts.version(id, versionSeq);
    const kind = requireRepresentation(artifact.kind, target.kind);
    const path = requireArtifactPath(target.path);
    if (kind === "media") {
      const file = this.artifacts.file(id, versionSeq, path);
      const media = targetableMedia(file.mediaType);
      if (
        !media ||
        (media === "image" &&
          animatedImage(await this.artifacts.readFile(id, versionSeq, path), file.mediaType))
      )
        throw new ArtifactError(
          "Media targets require a video or a static PNG, JPEG, or WebP image",
        );
      const locator = requireObject(target.locator, "Media locator");
      const time = locator.time;
      if (
        media === "image"
          ? time !== null
          : typeof time !== "number" || !Number.isFinite(time) || time < 0 || time > 86400 * 365
      )
        throw new ArtifactError(
          "Use one finite timestamp in seconds for video and null for an image",
        );
      const box =
        locator.box === undefined ? FULL_MEDIA_BOX : requireObject(locator.box, "Media box");
      const { x, y, width, height } = box;
      if (
        ![x, y, width, height].every(
          (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1,
        ) ||
        !(Number(width) > 0) ||
        !(Number(height) > 0) ||
        Number(x) + Number(width) > 1.000000001 ||
        Number(y) + Number(height) > 1.000000001
      )
        throw new ArtifactError(
          "Media box must be a nonempty rectangle within the intrinsic frame, normalized to 0–1",
        );
      return {
        kind,
        versionSeq,
        path,
        locator: {
          time: time as number | null,
          box: { x: x as number, y: y as number, width: width as number, height: height as number },
        },
      };
    }
    if (allowMissingDocument && target.locator === null) {
      return { kind, versionSeq, path, locator: null };
    }
    if (kind === "diff") {
      if (target.locator === null) {
        const found = parseUnifiedDiff(this.artifacts.patch(id, versionSeq)).some(
          (file) => file.path === path || file.oldPath === path,
        );
        if (!found) throw new ArtifactError("Target file is absent from this patch");
        return { kind, versionSeq, path, locator: null };
      }
      const input = requireObject(target.locator, "Diff locator");
      if (input.side !== "old" && input.side !== "new")
        throw new ArtifactError("Diff locator requires an explicit old or new side");
      const locator: DiffLocator = { ...sourceLocator(input), side: input.side };
      await this.sourceRange(id, { kind, versionSeq, path, locator });
      return { kind, versionSeq, path, locator };
    }
    const file = this.artifacts.file(id, versionSeq, path);
    if (kind === "rendered") {
      if (!file.renderedHash && file.mediaType.split(";")[0] !== "text/html") {
        throw new ArtifactError("Target file has no rendered document representation");
      }
      return {
        kind,
        versionSeq,
        path,
        locator: target.locator === null ? null : renderedLocator(target.locator),
      };
    }
    if (target.locator === null) return { kind, versionSeq, path, locator: null };
    const locator = sourceLocator(target.locator);
    await this.sourceRange(id, { kind, versionSeq, path, locator });
    return { kind, versionSeq, path, locator };
  }

  async sourceRange(id: string, target: ArtifactTarget): Promise<ArtifactSourceRange> {
    if ((target.kind !== "source" && target.kind !== "diff") || !target.locator)
      throw new ArtifactError("Feedback has no captured source or diff line range");
    const versionSeq = requireSequence(target.versionSeq);
    const version = this.artifacts.version(id, versionSeq);
    requireRepresentation(version.kind, target.kind);
    const path = requireArtifactPath(target.path);
    const locator = sourceLocator(target.locator);
    const side = target.kind === "diff" ? target.locator.side : null;
    let lines: string[];
    if (target.kind === "diff") {
      if (side !== "old" && side !== "new")
        throw new ArtifactError("Diff locator requires an explicit old or new side");
      const file = parseUnifiedDiff(this.artifacts.patch(id, versionSeq)).find(
        (file) => file.path === path || file.oldPath === path,
      );
      if (!file) throw new ArtifactError("Target file is absent from this patch");
      const rows = file.lines.filter((row) => {
        const line = side === "old" ? row.oldLine : row.newLine;
        return line !== null && line >= locator.start && line <= locator.end;
      });
      if (rows.some((row, i) => (side === "old" ? row.oldLine : row.newLine) !== locator.start + i))
        throw new ArtifactError("Target range crosses a gap in the captured patch");
      lines = rows.map((row) => row.text);
    } else {
      const bytes = await this.artifacts.readFile(id, versionSeq, path);
      let source: string;
      try {
        source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (source.includes("\0")) throw new Error("Binary source");
      } catch {
        throw new ArtifactError("Binary files support whole-file feedback only");
      }
      const all = source.replaceAll("\r\n", "\n").split("\n");
      if (source.endsWith("\n")) all.pop();
      lines = all.slice(locator.start - 1, locator.end);
    }
    checkSourceQuote(lines, locator);
    return {
      artifactId: id,
      versionSeq,
      path,
      side,
      start: locator.start,
      end: locator.end,
      text: lines.join("\n"),
    };
  }
}

export interface TargetColumns {
  target_kind: ArtifactTarget["kind"];
  target_version_seq: number | null;
  target_path: string | null;
  locator_json: string | null;
}

export function targetColumns(target: ArtifactTarget): TargetColumns {
  return {
    target_kind: target.kind,
    target_version_seq: "versionSeq" in target ? target.versionSeq : null,
    target_path: "path" in target ? target.path : null,
    locator_json:
      "locator" in target && target.locator !== null ? JSON.stringify(target.locator) : null,
  };
}

export function targetFromColumns(row: TargetColumns): ArtifactTarget {
  const locator = row.locator_json === null ? null : JSON.parse(row.locator_json);
  switch (row.target_kind) {
    case "artifact":
      return { kind: "artifact" };
    case "artifact_summary":
      return { kind: row.target_kind, locator };
    case "version_summary":
      return { kind: row.target_kind, versionSeq: row.target_version_seq!, locator };
    default:
      return {
        kind: row.target_kind,
        versionSeq: row.target_version_seq!,
        path: row.target_path!,
        locator,
      };
  }
}
