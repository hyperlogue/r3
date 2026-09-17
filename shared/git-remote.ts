export interface GitRemote {
  url: string;
  key: string;
  name: string;
}

// A repository identity for grouping, never a fetch destination. Strip transport
// credentials before this value crosses the publisher/server interface.
export function normalizeGitRemote(value: unknown): GitRemote | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  const raw = value.trim();
  if (!raw || /[\s\\\p{Cc}]/u.test(raw)) return null;
  let input = raw;
  if (!raw.includes("://")) {
    const scp = /^(?:[^/@:]+@)?(\[[^\]]+\]|[^/@:]+):([^/].*)$/.exec(raw);
    if (!scp || scp[1].length === 1 || scp[2].startsWith(":")) return null;
    input = `ssh://${scp[1]}/${scp[2]}`;
  }
  try {
    const url = new URL(input);
    if (!["http:", "https:", "ssh:"].includes(url.protocol) || !url.hostname) return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    const path = url.pathname.replace(/^\/+|\/+$/g, "");
    if (!path || path.split("/").some((part) => !part || part.startsWith("~"))) return null;
    const repository = path.replace(/\.git$/, "");
    if (!repository) return null;
    const port = url.protocol === "ssh:" && url.port === "22" ? "" : url.port;
    const host = url.hostname.toLowerCase();
    url.hostname = host;
    url.port = port;
    url.pathname = `/${path}`;
    return {
      url: url.href,
      key: `${host}${port ? `:${port}` : ""}/${repository}`,
      name: repository.split("/").at(-1)!,
    };
  } catch {
    return null;
  }
}
