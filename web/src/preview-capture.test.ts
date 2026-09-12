import { expect, test } from "bun:test";
import { PreviewCapture, previewCaptureConstraints } from "./preview-capture.ts";

class Track extends EventTarget {
  readyState = "live";
  constructor(readonly kind: string) {
    super();
  }
  stop() {
    this.readyState = "ended";
  }
}
const stream = (...tracks: Track[]) => ({ getTracks: () => tracks }) as unknown as MediaStream;
const both = { camera: true, microphone: true };
const request = (id: string, constraints: unknown = { audio: true, video: true }) => ({
  type: "r3-preview-capture",
  op: "request",
  id,
  constraints,
});
const answer = (id: string, sdp: string) => ({ type: "r3-preview-capture", op: "answer", id, sdp });
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await Bun.sleep(1);
  }
  throw new Error("Capture did not reach the expected state");
}
class Peer extends EventTarget {
  iceGatheringState = "complete";
  connectionState = "new";
  onconnectionstatechange = () => {};
  localDescription = { sdp: "offer" };
  remote = 0;
  senders: { track: Track | null; replaceTrack: (track: Track | null) => Promise<void> }[] = [];
  addTransceiver(track: Track, options: { direction: string }) {
    expect(options.direction).toBe("sendonly");
    const sender = {
      track: track as Track | null,
      replaceTrack: async (value: Track | null) => {
        sender.track = value;
      },
    };
    this.senders.push(sender);
  }
  getSenders() {
    return this.senders;
  }
  async createOffer() {
    return { type: "offer", sdp: "offer" };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {
    this.remote++;
    this.connectionState = "connected";
    this.onconnectionstatechange();
  }
  close() {
    this.connectionState = "closed";
    this.onconnectionstatechange();
  }
}

test("capture accepts a bounded device subset without exposing enumeration or screen capture", () => {
  expect(
    previewCaptureConstraints({
      audio: true,
      video: { width: { ideal: 640 }, facingMode: "user" },
    }),
  ).toEqual({ audio: true, video: { width: { ideal: 640 }, facingMode: "user" } });
  for (const constraints of [
    null,
    {},
    { audio: false },
    { screen: true },
    { video: { deviceId: "selection" } },
    { video: { groupId: "selection" } },
    { video: { pan: true } },
    { audio: { mandatory: {} } },
    { video: { width: Infinity } },
    { video: { facingMode: "invalid" } },
  ])
    expect(() => previewCaptureConstraints(constraints)).toThrow();
});

test("a replacement document cannot inherit capture or receive a late permission result", async () => {
  let complete!: (value: MediaStream) => void;
  let calls = 0;
  const first: Record<string, unknown>[] = [];
  const second: Record<string, unknown>[] = [];
  const source = new PreviewCapture({
    onState: () => {},
    requestMedia: () => {
      calls++;
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
  });
  const old = source.bind((message) => first.push(message), both);
  old(request("old"));
  const next = source.bind((message) => second.push(message));
  next(request("no-consent"));
  expect(second.at(-1)?.name).toBe("NotAllowedError");
  source.allow(both);
  next(request("still-pending"));
  expect(second.at(-1)?.name).toBe("NotReadableError");
  old(request("stale-port"));
  expect(calls).toBe(1);
  const camera = new Track("video");
  complete(stream(camera));
  await until(() => camera.readyState === "ended");
  expect(second.some((message) => message.op === "offer")).toBe(false);
  source.close();
});

test("timing out a native permission prompt does not allow another outstanding prompt", async () => {
  let complete!: (value: MediaStream) => void;
  let calls = 0;
  const messages: Record<string, unknown>[] = [];
  const source = new PreviewCapture({
    onState: () => {},
    permissionTimeoutMs: 5,
    requestMedia: () => {
      calls++;
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
  });
  const receive = source.bind((message) => messages.push(message), both);
  receive(request("timeout"));
  await until(() => messages.some((message) => message.op === "error"));
  receive(request("retry"));
  expect(messages.at(-1)?.name).toBe("NotReadableError");
  expect(calls).toBe(1);
  const microphone = new Track("audio");
  complete(stream(microphone));
  await until(() => microphone.readyState === "ended");
  source.close();
});

test("device consent is checked even when the browser would grant capture", async () => {
  let calls = 0;
  const messages: Record<string, unknown>[] = [];
  const source = new PreviewCapture({
    onState: () => {},
    requestMedia: async () => {
      calls++;
      throw new DOMException("Browser denied", "NotAllowedError");
    },
  });
  const receive = source.bind((message) => messages.push(message), {
    camera: true,
    microphone: false,
  });
  receive(request("microphone", { audio: true }));
  expect(calls).toBe(0);
  receive(request("camera", { video: true }));
  await until(() => messages.some((message) => message.message === "Browser denied"));
  expect(calls).toBe(1);
  source.revoke();
  receive(request("revoked", { video: true }));
  expect(calls).toBe(1);
  source.close();
});

test("capture only accepts its one receive-only answer and owns independent physical track shutdown", async () => {
  const camera = new Track("video");
  const microphone = new Track("audio");
  const peer = new Peer();
  const messages: Record<string, unknown>[] = [];
  const source = new PreviewCapture({
    onState: () => {},
    requestMedia: async () => stream(camera, microphone),
    createPeer: () => peer as unknown as RTCPeerConnection,
  });
  const receive = source.bind((message) => messages.push(message), both);
  receive(request("capture"));
  await until(() => messages.some((message) => message.op === "offer"));
  receive(answer("unrelated", "malformed"));
  expect(camera.readyState).toBe("live");
  receive(
    answer(
      "capture",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=recvonly\r\n",
    ),
  );
  expect(peer.remote).toBe(1);
  receive(answer("capture", "renegotiation"));
  expect(peer.remote).toBe(1);
  receive({ type: "r3-preview-capture", op: "stop-kind", id: "capture", kind: "video" });
  expect(camera.readyState).toBe("ended");
  expect(microphone.readyState).toBe("live");
  expect(peer.senders[0].track).toBeNull();
  source.revoke();
  expect(microphone.readyState).toBe("ended");
  expect(peer.connectionState).toBe("closed");
  source.close();
});

test("a data-channel or sending answer tears down capture instead of opening a generic RTC endpoint", async () => {
  const camera = new Track("video");
  const peer = new Peer();
  const messages: Record<string, unknown>[] = [];
  const source = new PreviewCapture({
    onState: () => {},
    requestMedia: async () => stream(camera),
    createPeer: () => peer as unknown as RTCPeerConnection,
  });
  const receive = source.bind((message) => messages.push(message), both);
  receive(request("capture", { video: true }));
  await until(() => messages.some((message) => message.op === "offer"));
  receive(answer("capture", "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n"));
  expect(peer.remote).toBe(0);
  expect(camera.readyState).toBe("ended");
  expect(messages.at(-1)?.op).toBe("error");
  source.close();
});
