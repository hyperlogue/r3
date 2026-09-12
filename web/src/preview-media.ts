import type { PreviewBootstrap } from "../../shared/preview-protocol.ts";
import type { PreviewConnection } from "./preview-channel.ts";

// Serialized before publisher code. Capture itself stays in the trusted parent;
// these are received RTC tracks, with ordinary MediaStream consumers supported.
export function createPreviewMedia(
  config: PreviewBootstrap,
  connection: PreviewConnection,
  iceComplete: (peer: RTCPeerConnection) => Promise<void>,
): (constraints: MediaStreamConstraints) => Promise<MediaStream> {
  interface Capture {
    id: string;
    expected: number;
    peer?: RTCPeerConnection;
    tracks: Map<MediaStreamTrack, () => void>;
    resolve: (stream: MediaStream) => void;
    reject: (error: Error) => void;
    resolved: boolean;
    timer: ReturnType<typeof setTimeout>;
  }
  let active: Capture | null = null;
  const send = (capture: Capture, message: Record<string, unknown>) => {
    connection.send({ type: "r3-preview-capture", id: capture.id, ...message });
  };
  const finish = (capture: Capture, error?: Error) => {
    if (active !== capture) return;
    active = null;
    clearTimeout(capture.timer);
    for (const [track, stop] of capture.tracks) {
      if (track.readyState !== "ended") {
        stop();
        track.dispatchEvent(new Event("ended"));
      }
    }
    capture.peer?.close();
    send(capture, { op: "stop" });
    if (!capture.resolved)
      capture.reject(error ?? new DOMException("Capture was stopped", "AbortError"));
  };
  const remaining = (capture: Capture, kind: string) => {
    if (active !== capture) return;
    const live = [...capture.tracks.keys()].filter((track) => track.readyState === "live");
    if (!live.some((track) => track.kind === kind)) send(capture, { op: "stop-kind", kind });
    if (live.length === 0) finish(capture);
  };
  const ownTrack = (capture: Capture, track: MediaStreamTrack): MediaStreamTrack => {
    const stop = track.stop.bind(track);
    const clone = track.clone.bind(track);
    capture.tracks.set(track, stop);
    Object.defineProperties(track, {
      stop: {
        configurable: true,
        value: () => {
          stop();
          remaining(capture, track.kind);
        },
      },
      clone: { configurable: true, value: () => ownTrack(capture, clone()) },
    });
    track.addEventListener("ended", () => remaining(capture, track.kind));
    return track;
  };
  const ownStream = (capture: Capture, tracks: MediaStreamTrack[]): MediaStream => {
    const stream = new MediaStream(tracks);
    Object.defineProperty(stream, "clone", {
      configurable: true,
      value: () =>
        ownStream(
          capture,
          stream.getTracks().map((track) => track.clone()),
        ),
    });
    return stream;
  };
  const ready = (capture: Capture) => {
    if (
      active !== capture ||
      capture.resolved ||
      capture.peer?.connectionState !== "connected" ||
      capture.tracks.size < capture.expected
    )
      return;
    capture.resolved = true;
    clearTimeout(capture.timer);
    capture.resolve(ownStream(capture, [...capture.tracks.keys()]));
  };
  connection.subscribe((message) => {
    const capture = active;
    if (
      !capture ||
      message?.type !== "r3-preview-capture" ||
      message.contextId !== config.contextId ||
      message.id !== capture.id
    )
      return;
    if (message.op === "error") {
      finish(
        capture,
        new DOMException(
          typeof message.message === "string" ? message.message : "Device capture failed",
          typeof message.name === "string" ? message.name : "AbortError",
        ),
      );
    } else if (message.op === "ended") {
      if (message.kind === "audio" || message.kind === "video") {
        for (const [track, stop] of capture.tracks)
          if (track.kind === message.kind && track.readyState !== "ended") {
            stop();
            track.dispatchEvent(new Event("ended"));
          }
        remaining(capture, message.kind);
      } else finish(capture);
    } else if (message.op === "offer" && !capture.peer) {
      void (async () => {
        try {
          if (typeof message.sdp !== "string" || message.sdp.length > 64_000)
            throw new TypeError("Invalid device connection offer");
          const peer = new RTCPeerConnection({ iceServers: [], bundlePolicy: "max-bundle" });
          capture.peer = peer;
          peer.ontrack = (event) => {
            if (active === capture) {
              ownTrack(capture, event.track);
              ready(capture);
            }
          };
          peer.onconnectionstatechange = () => {
            if (peer.connectionState === "connected") ready(capture);
            else if (["closed", "disconnected", "failed"].includes(peer.connectionState))
              finish(capture);
          };
          await peer.setRemoteDescription({ type: "offer", sdp: message.sdp });
          if (active !== capture) return;
          const answer = await peer.createAnswer();
          if (active !== capture) return;
          await peer.setLocalDescription(answer);
          if (active !== capture) return;
          await iceComplete(peer);
          if (active === capture) send(capture, { op: "answer", sdp: peer.localDescription!.sdp });
        } catch (error) {
          finish(capture, error instanceof Error ? error : new Error("Device connection failed"));
        }
      })();
    }
  });
  window.addEventListener("pagehide", () => {
    if (active) finish(active);
  });
  const getUserMedia = (constraints: MediaStreamConstraints): Promise<MediaStream> =>
    new Promise((resolve, reject) => {
      if (!config.capture) {
        reject(
          new DOMException(
            "Enable external access and devices in artifact permissions",
            "NotAllowedError",
          ),
        );
        return;
      }
      if (active) {
        reject(
          new DOMException("Stop the current capture before starting another", "NotReadableError"),
        );
        return;
      }
      const id = crypto.randomUUID();
      const capture: Capture = {
        id,
        expected: Number(!!constraints?.audio) + Number(!!constraints?.video),
        tracks: new Map(),
        resolved: false,
        resolve,
        reject,
        timer: setTimeout(
          () =>
            finish(capture, new DOMException("Device permission request timed out", "AbortError")),
          125_000,
        ),
      };
      active = capture;
      try {
        send(capture, { op: "request", constraints });
      } catch (error) {
        finish(capture, error instanceof Error ? error : new Error("Invalid capture request"));
      }
    });
  // Native capture remains denied by sandbox/Permissions-Policy. This adapter
  // lets existing pages use the standard call without acquiring a real origin.
  if (config.capture && navigator.mediaDevices)
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      writable: true,
      value: getUserMedia,
    });
  return getUserMedia;
}
