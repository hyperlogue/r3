import type { PreviewScope } from "./preview-contexts.ts";

// Serialized as r3-owned code, never combined with publisher-provided strings.
// Keep this function closed over only its explicit parameters and browser APIs.
function checkPreviewBrowser({
  applicationOrigin,
  contextId,
  challenge,
}: {
  applicationOrigin: string;
  contextId: string;
  challenge: string;
}) {
  const report = (state: "ready" | "unsupported" | "error", message: string) => {
    document.querySelector("p")!.textContent = message;
    parent.postMessage({ type: "r3-preview-gate", contextId, state, message }, applicationOrigin);
  };
  const rtcBlocked = async () => {
    if (typeof RTCPeerConnection !== "function") return false;
    // No ICE server and relay-only: even a browser that ignores the policy
    // neither contacts STUN/TURN nor gathers host candidates during this probe.
    const pc = new RTCPeerConnection({ iceServers: [], iceTransportPolicy: "relay" });
    try {
      pc.createDataChannel("r3-policy-check");
      await pc.setLocalDescription(await pc.createOffer());
      if (pc.iceConnectionState === "failed") return true;
      return await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 1500);
        pc.oniceconnectionstatechange = () => {
          if (pc.iceConnectionState === "failed") {
            clearTimeout(timer);
            resolve(true);
          }
        };
      });
    } finally {
      pc.close();
    }
  };
  void (async () => {
    try {
      if (!isSecureContext) {
        report("unsupported", "Open r3 over HTTPS or localhost to use rendered previews.");
        return;
      }
      const control = await fetch("/r3/check", {
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
      if (!control.ok) throw new Error("Preview check unavailable");
      const blocked = async () => {
        try {
          await fetch("/outside/check", { cache: "no-store", signal: AbortSignal.timeout(5000) });
          return false;
        } catch (error) {
          return error instanceof TypeError;
        }
      };
      const [connections, rtc] = await Promise.all([blocked(), rtcBlocked()]);
      if (!connections || !rtc) {
        report(
          "unsupported",
          "This browser cannot enforce r3's preview network policy. Use a browser with Connection Allowlist support.",
        );
        return;
      }
      const verified = await fetch("/r3/verify", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challenge }),
        signal: AbortSignal.timeout(5000),
      });
      if (!verified.ok) throw new Error("Preview verification failed");
      const cookie = await fetch("/r3/verified", {
        credentials: "include",
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
      if (!cookie.ok) {
        report(
          "unsupported",
          "This browser blocked preview authentication. Rendered previews require partitioned cookies.",
        );
        return;
      }
      report("ready", "Preview ready.");
    } catch {
      report(
        "error",
        "Could not verify preview isolation. Retry when the preview server is reachable.",
      );
    }
  })();
}

export function previewGateDocument(scope: PreviewScope, challenge: string): string {
  const params = JSON.stringify({
    applicationOrigin: scope.applicationOrigin,
    contextId: scope.id,
    challenge,
  }).replaceAll("<", "\\u003c");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>r3 preview</title><style>body{font:16px system-ui,sans-serif;margin:0;padding:2rem;color:#525252;background:#fafafa}p{max-width:38rem;line-height:1.6}</style><body><p>Checking preview isolation…</p><script>(${checkPreviewBrowser.toString()})(${params})</script></body></html>`;
}
