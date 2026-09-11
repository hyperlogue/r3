export interface ServerEvent {
  event: string;
  data: string;
  id?: string;
}

// Both clients consume authenticated fetch streams. Preserve UTF-8 and SSE line
// boundaries across arbitrary transport chunks; never treat one chunk as a frame.
export async function* readEventStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ServerEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let id: string | undefined;
  let data: string[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      for (;;) {
        const match = /\r\n|\r|\n/.exec(buffer);
        if (!match || (!chunk.done && match[0] === "\r" && match.index === buffer.length - 1))
          break;
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        size += line.length;
        if (size > 8 * 1024 * 1024) throw new Error("Event stream frame is too large");
        if (!line) {
          if (data.length)
            yield { event, data: data.join("\n"), ...(id === undefined ? {} : { id }) };
          event = "message";
          data = [];
          size = 0;
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "event") event = value || "message";
          else if (field === "data") data.push(value);
          else if (field === "id" && !value.includes("\0")) id = value;
        }
      }
      if (buffer.length + size > 8 * 1024 * 1024)
        throw new Error("Event stream frame is too large");
      if (chunk.done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
