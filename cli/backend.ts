import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { configDir, configPath } from "../server/config.ts";
import { normalizeBackendUrl } from "../shared/backend-url.ts";
import { readPrivateJson, withPrivateLock, writePrivateJson } from "./private-state.ts";

export function selectedBackend(
  cwd = process.cwd(),
  environment: Record<string, string | undefined> = process.env,
  userConfig = configPath(),
): string | null {
  if (environment.R3_URL?.trim()) return normalizeBackendUrl(environment.R3_URL.trim());
  for (let directory = resolve(cwd); ; ) {
    const file = join(directory, ".r3.json");
    if (existsSync(file)) {
      let value: unknown;
      try {
        value = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        throw new Error("Invalid project .r3.json");
      }
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        typeof (value as { backendUrl?: unknown }).backendUrl !== "string" ||
        Object.keys(value).some((key) => key !== "backendUrl")
      )
        throw new Error("Project .r3.json must contain only a backendUrl string");
      return normalizeBackendUrl((value as { backendUrl: string }).backendUrl);
    }
    const parent = dirname(directory);
    if (parent === directory || existsSync(join(directory, ".git"))) break;
    directory = parent;
  }
  if (!existsSync(userConfig)) return null;
  let config: { backendUrl?: unknown };
  try {
    config = JSON.parse(readFileSync(userConfig, "utf8"));
  } catch {
    throw new Error("Invalid user configuration");
  }
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new Error("Invalid user configuration");
  if (config.backendUrl === undefined) return null;
  if (typeof config.backendUrl !== "string") throw new Error("backendUrl must be a URL string");
  return normalizeBackendUrl(config.backendUrl);
}

export interface BackendCredential {
  url: string;
  kind: "key" | "oauth";
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export class BackendCredentials {
  constructor(
    private readonly directory = join(configDir(), "credentials"),
    private readonly send = fetch,
  ) {}
  private path(url: string): string {
    return join(
      this.directory,
      `${createHash("sha256").update(normalizeBackendUrl(url)).digest("hex")}.json`,
    );
  }
  read(url: string): BackendCredential | null {
    let credential: BackendCredential | null;
    try {
      credential = readPrivateJson<BackendCredential>(this.path(url));
    } catch {
      throw new Error(
        "Cannot read saved backend access; check credential permissions and run r3 login",
      );
    }
    if (!credential) return null;
    if (
      credential.url !== normalizeBackendUrl(url) ||
      !credential.accessToken ||
      !["key", "oauth"].includes(credential.kind)
    )
      throw new Error("Invalid saved backend credentials; run r3 login");
    return credential;
  }
  async save(credential: BackendCredential): Promise<void> {
    const url = normalizeBackendUrl(credential.url);
    await withPrivateLock(`${this.path(url)}.lock`, async () =>
      writePrivateJson(this.path(url), { ...credential, url }),
    );
  }
  async token(url: string): Promise<string> {
    const saved = this.read(url);
    if (!saved) throw new Error("No saved access for this backend; run r3 login");
    if (saved.kind === "key" || (saved.expiresAt ?? 0) > Date.now() + 30_000)
      return saved.accessToken;
    return withPrivateLock(`${this.path(url)}.lock`, async () => {
      const latest = this.read(url);
      if (!latest) throw new Error("No saved access for this backend; run r3 login");
      if (latest.kind === "key" || (latest.expiresAt ?? 0) > Date.now() + 30_000)
        return latest.accessToken;
      if (!latest.refreshToken) throw new Error("Backend access expired; run r3 login");
      const response = await this.send(`${normalizeBackendUrl(url)}/api/oauth/token`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: latest.refreshToken,
          client_id: "r3-cli",
        }),
      });
      if (!response.ok) {
        if (response.status === 408 || response.status === 429 || response.status >= 500)
          throw new Error(
            `Backend credential refresh is temporarily unavailable (HTTP ${response.status}); try again`,
          );
        throw new Error("Backend access was rejected; run r3 login");
      }
      const result = (await response.json()) as OAuthTokens;
      const next = credentialFromTokens(url, result);
      writePrivateJson(this.path(url), next);
      return next.accessToken;
    });
  }
}

export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}
export function credentialFromTokens(url: string, tokens: OAuthTokens): BackendCredential {
  if (
    !tokens.access_token ||
    !tokens.refresh_token ||
    tokens.token_type !== "Bearer" ||
    !Number.isFinite(tokens.expires_in) ||
    tokens.expires_in <= 0
  )
    throw new Error("Backend returned an invalid credential response");
  return {
    url: normalizeBackendUrl(url),
    kind: "oauth",
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  };
}
