import type {
  PreviewCaptureState,
  PreviewDevicePermissions,
} from "../../shared/preview-protocol.ts";

type Send = (message: Record<string, unknown>) => void;
interface DocumentGrant {
  send: Send;
  permissions: PreviewDevicePermissions;
}
interface Capture {
  id: string;
  grant: DocumentGrant;
  stream?: MediaStream;
  peer?: RTCPeerConnection;
  answer: boolean;
  stoppedKinds: Set<string>;
  timer: ReturnType<typeof setTimeout>;
}

// A browser permission prompt can outlive any component or logical request.
// Never stack another prompt while that native promise is still unsettled.
let pendingNativeRequest = false;
async function requestDevices(constraints: MediaStreamConstraints): Promise<MediaStream> {
  if (pendingNativeRequest)
    throw new DOMException("A device permission request is still open", "NotReadableError");
  pendingNativeRequest = true;
  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } finally {
    pendingNativeRequest = false;
  }
}

export function previewCaptureConstraints(value: unknown): MediaStreamConstraints {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Choose audio or video capture");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "audio" && key !== "video"))
    throw new TypeError("Only audio and video capture are supported");
  const parse = (value: unknown, kind: "audio" | "video"): boolean | MediaTrackConstraints => {
    if (value === undefined || value === false) return false;
    if (value === true) return true;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new TypeError(`Invalid ${kind} constraints`);
    const supported =
      kind === "video"
        ? ["width", "height", "frameRate", "aspectRatio", "facingMode"]
        : ["echoCancellation", "noiseSuppression", "autoGainControl", "sampleRate", "channelCount"];
    const result: Record<string, unknown> = {};
    for (const [key, constraint] of Object.entries(value)) {
      if (!supported.includes(key))
        throw new DOMException(`Unsupported capture constraint: ${key}`, "NotSupportedError");
      const primitive = (value: unknown) => {
        if (key === "facingMode")
          return (
            typeof value === "string" && ["user", "environment", "left", "right"].includes(value)
          );
        if (["echoCancellation", "noiseSuppression", "autoGainControl"].includes(key))
          return typeof value === "boolean";
        return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 192_000;
      };
      if (primitive(constraint)) result[key] = constraint;
      else if (
        constraint &&
        typeof constraint === "object" &&
        !Array.isArray(constraint) &&
        Object.entries(constraint).every(
          ([key, value]) => ["ideal", "exact", "min", "max"].includes(key) && primitive(value),
        )
      )
        result[key] = { ...constraint };
      else throw new TypeError(`Invalid capture constraint: ${key}`);
    }
    return result;
  };
  const constraints = { audio: parse(input.audio, "audio"), video: parse(input.video, "video") };
  if (!constraints.audio && !constraints.video)
    throw new TypeError("Choose audio or video capture");
  return constraints;
}

export async function previewIceComplete(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === "complete") return;
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", changed);
    };
    const changed = () => {
      if (peer.iceGatheringState === "complete") {
        done();
        resolve();
      }
    };
    const timer = setTimeout(() => {
      done();
      reject(new DOMException("Device connection timed out", "AbortError"));
    }, 5000);
    peer.addEventListener("icegatheringstatechange", changed);
    changed();
  });
}

// Owns physical devices across document replacement and late permission results.
// The iframe only receives a send-only RTC stream, never a browser credential.
export class PreviewCapture {
  private grant: DocumentGrant | null = null;
  private capture: Capture | null = null;
  private requesting = false;
  constructor(
    private readonly options: {
      onState: (state: PreviewCaptureState) => void;
      onRevoked?: () => void;
      requestMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
      createPeer?: () => RTCPeerConnection;
      permissionTimeoutMs?: number;
    },
  ) {}

  bind(send: Send, permissions: PreviewDevicePermissions = { camera: false, microphone: false }) {
    this.close();
    const grant = { send, permissions };
    this.grant = grant;
    return (message: Record<string, unknown>) => {
      if (this.grant !== grant || message.type !== "r3-preview-capture") return;
      const id = message.id;
      if (typeof id !== "string" || !/^[\w-]{1,128}$/.test(id)) return;
      if (message.op === "request") void this.start(grant, id, message.constraints);
      else {
        const capture = this.capture;
        if (!capture || capture.id !== id || capture.grant !== grant) return;
        if (message.op === "stop") this.stop();
        else if (
          message.op === "stop-kind" &&
          (message.kind === "audio" || message.kind === "video")
        )
          this.stopKind(capture, message.kind);
        else if (message.op === "answer") void this.answer(capture, message.sdp);
      }
    };
  }

  allow(permissions: PreviewDevicePermissions): void {
    this.stop();
    if (this.grant) this.grant.permissions = { ...permissions };
  }
  revoke(): void {
    this.allow({ camera: false, microphone: false });
  }
  close(): void {
    this.revoke();
    this.grant = null;
  }

  private state(capture?: Capture, message?: string): void {
    const tracks =
      capture?.stream?.getTracks().filter((track) => track.readyState === "live") ?? [];
    this.options.onState({
      phase: message ? "error" : tracks.length ? "sharing" : capture ? "requesting" : "idle",
      camera: tracks.some((track) => track.kind === "video"),
      microphone: tracks.some((track) => track.kind === "audio"),
      ...(message ? { message } : {}),
    });
  }
  private send(grant: DocumentGrant, message: Record<string, unknown>) {
    try {
      grant.send({ type: "r3-preview-capture", ...message });
    } catch {
      /* A closed document cannot receive a final status. */
    }
  }
  private error(grant: DocumentGrant, id: string, error: unknown): void {
    const name = error instanceof Error ? error.name : "AbortError";
    const message = error instanceof Error ? error.message.slice(0, 512) : "Device capture failed";
    this.send(grant, { op: "error", id, name, message });
    if (!this.capture) this.state(undefined, message);
  }
  private live(capture: Capture) {
    return this.capture === capture && this.grant === capture.grant;
  }

  private async start(grant: DocumentGrant, id: string, value: unknown): Promise<void> {
    let capture: Capture | undefined;
    try {
      const constraints = previewCaptureConstraints(value);
      if (
        (constraints.video && !grant.permissions.camera) ||
        (constraints.audio && !grant.permissions.microphone)
      )
        throw new DOMException(
          "Enable the requested devices in artifact permissions",
          "NotAllowedError",
        );
      if (this.capture || this.requesting)
        throw new DOMException(
          "Stop the current capture or finish its permission request first",
          "NotReadableError",
        );
      capture = {
        id,
        grant,
        answer: false,
        stoppedKinds: new Set(),
        timer: setTimeout(() => {
          if (capture && this.live(capture)) {
            this.stop(false);
            this.error(
              grant,
              id,
              new DOMException("Device permission request timed out", "AbortError"),
            );
          }
        }, this.options.permissionTimeoutMs ?? 120_000),
      };
      this.capture = capture;
      this.state(capture);
      this.requesting = true;
      let stream: MediaStream;
      try {
        stream = await (this.options.requestMedia ?? requestDevices)(constraints);
      } finally {
        this.requesting = false;
      }
      if (!this.live(capture)) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      capture.stream = stream;
      this.state(capture);
      clearTimeout(capture.timer);
      capture.timer = setTimeout(() => {
        if (capture && this.live(capture)) {
          this.stop(false);
          this.error(grant, id, new DOMException("Device connection timed out", "AbortError"));
        }
      }, 15_000);
      const peer = (
        this.options.createPeer ??
        (() => new RTCPeerConnection({ iceServers: [], bundlePolicy: "max-bundle" }))
      )();
      capture.peer = peer;
      for (const track of stream.getTracks()) {
        peer.addTransceiver(track, { direction: "sendonly", streams: [stream] });
        track.addEventListener("ended", () => {
          if (capture && this.live(capture)) {
            this.revoke();
            this.options.onRevoked?.();
          }
        });
      }
      peer.onconnectionstatechange = () => {
        if (!capture || !this.live(capture)) return;
        if (peer.connectionState === "connected") clearTimeout(capture.timer);
        else if (["disconnected", "failed", "closed"].includes(peer.connectionState)) this.stop();
      };
      const offer = await peer.createOffer();
      if (!this.live(capture)) return;
      await peer.setLocalDescription(offer);
      if (!this.live(capture)) return;
      await previewIceComplete(peer);
      if (this.live(capture))
        this.send(grant, { op: "offer", id, sdp: peer.localDescription!.sdp });
    } catch (error) {
      if (capture && !this.live(capture)) return;
      if (capture) this.stop(false);
      this.error(grant, id, error);
    }
  }

  private async answer(capture: Capture, sdp: unknown): Promise<void> {
    if (!capture.peer || capture.answer) return;
    try {
      if (typeof sdp !== "string" || sdp.length > 64_000)
        throw new TypeError("Invalid device connection answer");
      const sections = sdp.match(/^m=.*$/gm) ?? [];
      const kinds = capture
        .stream!.getTracks()
        .map((track) => track.kind)
        .sort();
      if (
        sections.length !== kinds.length ||
        sections.some((line) => !/^m=(audio|video) \d+ UDP\/TLS\/RTP\/SAVPF /.test(line)) ||
        sections
          .map((line) => line.split(" ")[0].slice(2))
          .sort()
          .join() !== kinds.join() ||
        /^a=(sendrecv|sendonly)\r?$/m.test(sdp)
      )
        throw new TypeError("Device connections only receive the requested audio/video");
      capture.answer = true;
      await capture.peer.setRemoteDescription({ type: "answer", sdp });
    } catch (error) {
      if (!this.live(capture)) return;
      this.stop(false);
      this.error(capture.grant, capture.id, error);
    }
  }

  private stopKind(capture: Capture, kind: string): void {
    if (capture.stoppedKinds.has(kind)) return;
    capture.stoppedKinds.add(kind);
    for (const track of capture.stream?.getTracks() ?? []) if (track.kind === kind) track.stop();
    for (const sender of capture.peer?.getSenders() ?? [])
      if (sender.track?.kind === kind) void sender.replaceTrack(null).catch(() => {});
    this.send(capture.grant, { op: "ended", id: capture.id, kind });
    if (!capture.stream?.getTracks().some((track) => track.readyState === "live")) this.stop();
    else this.state(capture);
  }
  private stop(notify = true): void {
    const capture = this.capture;
    this.capture = null;
    if (capture) {
      clearTimeout(capture.timer);
      for (const track of capture.stream?.getTracks() ?? []) track.stop();
      capture.peer?.close();
      if (notify) this.send(capture.grant, { op: "ended", id: capture.id });
    }
    this.state();
  }
}
