import { MIMEType } from "node:util";
import type { ArtifactActor } from "../shared/artifacts.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: reject controls in URL paths and HTTP headers
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;

export class ArtifactError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 413 = 400,
  ) {
    super(message);
    this.name = "ArtifactError";
  }
}

export function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ArtifactError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function requireString(value: unknown, name: string, max = 1024 * 1024): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new ArtifactError(`${name} must be nonempty text (at most ${max} characters)`);
  }
  return value;
}

export function optionalText(value: unknown, name: string, max = 1024 * 1024): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > max) {
    throw new ArtifactError(`${name} must be text (at most ${max} characters) or null`);
  }
  return value;
}

export function requireSequence(value: unknown, allowZero = false): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new ArtifactError("Version sequence must be an explicit integer");
  }
  return value;
}

export function requireActor(value: unknown): ArtifactActor {
  const actor = requireObject(value, "actor");
  if (actor.role === "human" && actor.sessionId === null) {
    return { role: "human", sessionId: null };
  }
  if (actor.role === "agent") {
    return { role: "agent", sessionId: requireString(actor.sessionId, "actor.sessionId", 200) };
  }
  throw new ArtifactError("actor must explicitly name a human owner or an agent session");
}

// These names are logical publication paths, never server filesystem paths.
// Reject aliases rather than normalizing two different input names to one URL.
export function requireArtifactPath(value: unknown): string {
  const path = requireString(value, "File path", 4096);
  const parts = path.split("/");
  if (
    path.includes("\\") ||
    CONTROL_CHARACTERS.test(path) ||
    /^[a-z]:/i.test(path) ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new ArtifactError("File paths must be canonical relative paths without traversal");
  }
  return path;
}

export function requireMediaType(value: unknown): string {
  const raw = requireString(value, "Media type", 200);
  if (CONTROL_CHARACTERS.test(raw)) throw new ArtifactError("Invalid media type");
  try {
    return new MIMEType(raw).toString();
  } catch {
    throw new ArtifactError("Invalid media type");
  }
}

// Canonical JSON gives semantically identical metadata the same retry identity.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = requireObject(value, "JSON value");
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return JSON.stringify(value);
  }
  throw new ArtifactError("Metadata must contain only JSON values");
}

export function jsonObject(value: unknown, name: string): Record<string, unknown> {
  const serialized = canonicalJson(requireObject(value, name));
  if (serialized.length > 64 * 1024) throw new ArtifactError(`${name} is too large`, 413);
  return JSON.parse(serialized);
}
