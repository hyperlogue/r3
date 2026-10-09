import { ArtifactClient } from "../shared/artifact-client.ts";
import { normalizeBackendUrl } from "../shared/backend-url.ts";
import { ArtifactCommandError } from "./artifact-args.ts";
import { BackendCredentials, credentialFromTokens, type OAuthTokens } from "./backend.ts";
import { discoverArtifactServer } from "./daemon-client.ts";
import { reloadWorker } from "./worker-client.ts";

export async function loginCommand(args: string[]): Promise<void> {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--api-key-stdin"))
    throw new ArtifactCommandError("login [--api-key-stdin]");
  const { url } = await discoverArtifactServer(true);
  const credentials = new BackendCredentials();
  if (args[0] === "--api-key-stdin") {
    if (process.stdin.isTTY) throw new Error("Pipe the API key to r3 login --api-key-stdin");
    const reader = Bun.stdin.stream().getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 4096) throw new Error("API key is too long");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const accessToken = Buffer.concat(chunks).toString("utf8").trim();
    if (!accessToken) throw new Error("Missing API key");
    await new ArtifactClient({ url, token: accessToken }).json("GET", "/api/sessions");
    await credentials.save({ url, kind: "key", accessToken });
  } else {
    const response = await fetch(`${url}/api/oauth/device/code`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      body: new URLSearchParams({ client_id: "r3-cli", label: "r3 CLI" }),
    });
    if (!response.ok) throw new Error("Backend could not start browser approval");
    const request = (await response.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      expires_in: number;
      interval: number;
    };
    if (
      typeof request.device_code !== "string" ||
      typeof request.user_code !== "string" ||
      !Number.isFinite(request.expires_in) ||
      request.expires_in <= 0 ||
      !Number.isFinite(request.interval) ||
      request.interval < 1
    )
      throw new Error("Invalid device authorization response");
    const verification = new URL(request.verification_uri);
    if (
      new URL(normalizeBackendUrl(url)).origin !== verification.origin ||
      verification.username ||
      verification.password
    )
      throw new Error("Backend returned an unrelated approval address");
    console.log(
      `Open ${verification.href}\nEnter code: ${request.user_code}\nApprove this request in your authenticated r3 browser.`,
    );
    const deadline = Date.now() + Math.min(request.expires_in, 1800) * 1000;
    let interval = request.interval * 1000;
    let approved = false;
    while (Date.now() < deadline) {
      await Bun.sleep(interval);
      let result: Response;
      try {
        result = await fetch(`${url}/api/oauth/token`, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
          body: new URLSearchParams({
            client_id: "r3-cli",
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: request.device_code,
          }),
        });
      } catch {
        interval = Math.min(60_000, interval * 2);
        continue;
      }
      if (result.status >= 500 || result.status === 429) {
        interval = Math.min(60_000, interval * 2);
        continue;
      }
      const body = (await result.json()) as OAuthTokens & { error?: string };
      if (result.ok) {
        await credentials.save(credentialFromTokens(url, body));
        approved = true;
        break;
      }
      if (body.error === "authorization_pending") continue;
      if (body.error === "slow_down") {
        interval += 5000;
        continue;
      }
      throw new Error(
        body.error === "access_denied"
          ? "Browser approval was declined"
          : "Authorization expired or was rejected; run r3 login again",
      );
    }
    if (!approved) throw new Error("Browser approval expired; run r3 login again");
  }
  await reloadWorker(url);
  console.log(`Connected to ${url}`);
}
