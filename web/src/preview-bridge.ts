import type { ArtifactDetail, RenderedLocator } from "../../shared/artifacts.ts";
import type { PreviewPageContext } from "../../shared/preview-protocol.ts";
import { normalizeRenderedText } from "../../shared/rendered-text.ts";
import type { artifactApi } from "./artifact-api.ts";
import type { previewThemePreference } from "./preview-theme.ts";

export function previewLocator(value: unknown): RenderedLocator | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid rendered target");
  const input = value as Record<string, unknown>;
  const text = (key: string, limit: number, required = false) => {
    const value = input[key];
    if (value === undefined && !required) return undefined;
    if (typeof value !== "string" || (required && !value.trim()) || value.length > limit)
      throw new Error(`Invalid rendered ${key}`);
    return value;
  };
  const selector = text("selector", 4096, true)!;
  const quote = text("quote", 16_384);
  const prefix = text("prefix", 512);
  const suffix = text("suffix", 512);
  const route = text("route", 2048);
  if (route && !/^[?#]/.test(route))
    throw new Error("Rendered routes must stay within the document");
  let viewport: RenderedLocator["viewport"];
  if (input.viewport !== undefined) {
    if (!input.viewport || typeof input.viewport !== "object")
      throw new Error("Invalid rendered viewport");
    const { width, height } = input.viewport as Record<string, unknown>;
    if (
      typeof width !== "number" ||
      typeof height !== "number" ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0 ||
      width > 100_000 ||
      height > 100_000
    )
      throw new Error("Invalid rendered viewport");
    viewport = { width, height };
  }
  return {
    selector,
    ...(quote === undefined ? {} : { quote: normalizeRenderedText(quote) }),
    ...(prefix === undefined ? {} : { prefix: normalizeRenderedText(prefix) }),
    ...(suffix === undefined ? {} : { suffix: normalizeRenderedText(suffix) }),
    ...(route === undefined ? {} : { route }),
    ...(viewport ? { viewport } : {}),
  };
}

export async function previewBridgeCall(
  method: string,
  value: unknown,
  context: PreviewPageContext,
  detail: ArtifactDetail,
  api: Pick<typeof artifactApi, "addFeedback" | "reply" | "submit">,
  userActivated: boolean,
  theme: ReturnType<typeof previewThemePreference>,
): Promise<unknown> {
  if (method === "getTheme") return theme.get();
  if (method === "getContext") return context;
  if (method === "getThreads") return detail.feedback;
  if (!["createFeedback", "reply", "submit", "setTheme"].includes(method))
    throw new Error("Unsupported r3 preview operation");
  // Browser user activation propagates from the preview to its parent. Loading
  // a page or receiving an agent reply cannot silently start another handoff.
  if (!userActivated) throw new Error("Use a button or another user action to send through r3");
  if (method === "setTheme") {
    if (value !== "light" && value !== "dark") throw new Error("Theme must be light or dark");
    return theme.set(value);
  }
  if (method === "submit") return api.submit(context.artifactId);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid r3 message");
  const input = value as Record<string, unknown>;
  const allowed = method === "reply" ? ["body", "feedbackId"] : ["body", "locator"];
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw new Error("Preview messages cannot change actor, publication, or scope");
  if (typeof input.body !== "string" || !input.body.trim() || input.body.length > 1024 * 1024)
    throw new Error("Message must contain between 1 and 1048576 characters");
  if (method === "reply") {
    if (
      typeof input.feedbackId !== "string" ||
      !detail.feedback.some((feedback) => feedback.id === input.feedbackId)
    )
      throw new Error("Thread is not part of this artifact");
    return api.reply(input.feedbackId, {
      body: input.body,
      context: { versionSeq: context.versionSeq, representation: context.representation },
    });
  }
  const locator = previewLocator(input.locator);
  if (context.representation === "source" && locator)
    throw new Error("Media previews support whole-file feedback");
  return api.addFeedback(
    context.artifactId,
    input.body,
    context.representation === "source"
      ? { kind: "source", versionSeq: context.versionSeq, path: context.path, locator: null }
      : { kind: "rendered", versionSeq: context.versionSeq, path: context.path, locator },
  );
}
