import { artifactEventStream } from "../web/src/artifact-api.ts";
import { artifactLocalStorage } from "../web/src/artifact-local-storage.ts";
import { stopSharedArtifactEvents } from "../web/src/shared-artifact-events.ts";

const request = window.fetch;
window.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  if (url.pathname === "/api/events") {
    url.searchParams.set("tab", new URL(location.href).searchParams.get("tab") ?? "fallback");
    return request(input instanceof Request ? new Request(url, input) : url, init);
  }
  return request(input, init);
}, request);

const events: unknown[] = [];
let controller: AbortController | undefined;
const fixture = {
  events,
  start() {
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    void (async () => {
      for await (const event of artifactEventStream(signal)) {
        if (!signal.aborted) events.push(event);
      }
    })();
  },
  stop() {
    controller?.abort();
  },
  logout() {
    artifactLocalStorage.suspend();
    stopSharedArtifactEvents();
  },
};
Object.assign(window, { fixture });
