import { R3_VERSION_HEADER } from "../../shared/version.ts";
import { serverVersion } from "./server-version.ts";

// Observe only trusted, revalidated application API responses. Static assets
// can retain a previous server's headers in the browser's immutable cache.
export async function applicationFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  const observe =
    url.origin === location.origin && url.pathname.startsWith("/api/")
      ? serverVersion.beginRequest()
      : undefined;
  const response = await fetch(input, { ...init, redirect: "error", cache: "no-cache" });
  observe?.(response.headers.get(R3_VERSION_HEADER));
  return response;
}
