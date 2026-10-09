// Endpoint identity includes the base path. Never broaden credential lookup to
// an origin, follow redirects, or infer an API address from a review-page URL.
export function normalizeBackendUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Backend must be an absolute HTTP(S) URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Backend URL must not contain credentials, a query, or a fragment");
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    throw new Error("Remote backends require HTTPS; HTTP is allowed only on loopback");
  if (/%2f|%5c/i.test(url.pathname)) throw new Error("Backend URL contains an encoded separator");
  return url.href.replace(/\/+$/, "");
}
