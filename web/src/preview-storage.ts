import type { StorageMutation, StorageValues } from "./artifact-local-storage.ts";

export function installPreviewStorage(
  initial: StorageValues,
  port: MessagePort,
  childDocument: (html: string) => string,
): void {
  const limit = 256 * 1024;
  let values = new Map<string, string>(initial);
  const pending = new Map<number, StorageMutation>();
  const children = new Map<MessagePort, { frame: HTMLIFrameElement; window: Window }>();
  const frames = new Set<HTMLIFrameElement>();
  let sequence = 0;
  let stopped = false;
  const apply = (input: Map<string, string>, operation: StorageMutation) => {
    const next = new Map(input);
    if (operation.type === "clear") next.clear();
    else if (operation.type === "remove") next.delete(operation.key);
    else next.set(operation.key, operation.value);
    let bytes = 0;
    for (const [key, value] of next) bytes += 2 * (key.length + value.length);
    if (next.size > 1024 || bytes > limit)
      throw new DOMException("Artifact storage quota exceeded", "QuotaExceededError");
    return next;
  };
  const broadcast = () => {
    for (const [child, owner] of children) {
      if (!owner.frame.isConnected || owner.frame.contentWindow !== owner.window) {
        child.close();
        children.delete(child);
      } else child.postMessage({ values: [...values] });
    }
  };
  const write = (operation: StorageMutation) => {
    if (stopped) throw new DOMException("The preview was closed", "InvalidStateError");
    const next = apply(values, operation);
    const id = ++sequence;
    values = next;
    pending.set(id, operation);
    port.postMessage({ id, operation });
    broadcast();
  };
  const requireArgument = (count: number, required: number) => {
    if (count < required) throw new TypeError(`Expected ${required} arguments`);
  };
  const string = (value: unknown) => {
    if (typeof value === "symbol") throw new TypeError("Cannot convert a Symbol to a string");
    return String(value);
  };
  const methods = {
    getItem(...args: [string]) {
      requireArgument(args.length, 1);
      return values.get(string(args[0])) ?? null;
    },
    setItem(...args: [string, string]) {
      requireArgument(args.length, 2);
      write({ type: "set", key: string(args[0]), value: string(args[1]) });
    },
    removeItem(...args: [string]) {
      requireArgument(args.length, 1);
      write({ type: "remove", key: string(args[0]) });
    },
    clear() {
      write({ type: "clear" });
    },
    key(...args: [number]) {
      requireArgument(args.length, 1);
      return [...values.keys()][Number(args[0]) >>> 0] ?? null;
    },
  };
  const storage = new Proxy(Object.create(Storage.prototype) as Storage, {
    get(_target, property) {
      if (property === "length") return values.size;
      if (property === Symbol.toStringTag) return "Storage";
      if (Object.hasOwn(methods, property)) return methods[property as keyof typeof methods];
      if (typeof property === "string" && values.has(property)) return values.get(property);
      return Reflect.get(Storage.prototype, property, storage);
    },
    set(_target, property, value) {
      if (typeof property !== "string") return false;
      write({ type: "set", key: property, value: string(value) });
      return true;
    },
    deleteProperty(_target, property) {
      if (typeof property === "string") write({ type: "remove", key: property });
      return true;
    },
    ownKeys: () => [...values.keys()],
    has: (_target, property) =>
      typeof property === "string" && (values.has(property) || property in Storage.prototype),
    getOwnPropertyDescriptor(_target, property) {
      if (typeof property !== "string" || !values.has(property)) return undefined;
      return { value: values.get(property), enumerable: true, configurable: true, writable: true };
    },
    defineProperty(_target, property, descriptor) {
      if (typeof property !== "string" || !("value" in descriptor)) return false;
      write({ type: "set", key: property, value: string(descriptor.value) });
      return true;
    },
  });
  Object.defineProperty(window, "localStorage", { value: storage });
  port.onmessage = ({ data }) => {
    if (stopped || !Array.isArray(data?.values)) return;
    if (Number.isSafeInteger(data.acknowledged)) {
      for (const id of pending.keys()) if (id <= data.acknowledged) pending.delete(id);
    }
    let next = new Map<string, string>(data.values);
    for (const operation of pending.values()) {
      try {
        next = apply(next, operation);
      } catch {}
    }
    const previous = values;
    values = next;
    broadcast();
    for (const key of new Set([...previous.keys(), ...next.keys()])) {
      const oldValue = previous.get(key) ?? null;
      const newValue = next.get(key) ?? null;
      if (oldValue === newValue) continue;
      const event = new StorageEvent("storage", { key, oldValue, newValue, url: location.href });
      Object.defineProperty(event, "storageArea", { value: storage });
      setTimeout(() => {
        if (!stopped) window.dispatchEvent(event);
      });
    }
  };
  const srcdoc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "srcdoc")!;
  const attribute = Element.prototype.setAttribute;
  Object.defineProperty(HTMLIFrameElement.prototype, "srcdoc", {
    ...srcdoc,
    set(this: HTMLIFrameElement, source: string) {
      frames.add(this);
      srcdoc.set!.call(this, childDocument(String(source)));
    },
  });
  Element.prototype.setAttribute = function (name: string, value: string) {
    if (this instanceof HTMLIFrameElement && String(name).toLowerCase() === "srcdoc") {
      this.srcdoc = value;
      return;
    }
    attribute.call(this, name, value);
  };
  window.addEventListener("message", (event) => {
    if (
      stopped ||
      event.origin !== "null" ||
      event.data?.type !== "r3-preview-storage-child" ||
      event.ports.length !== 1
    )
      return;
    for (const frame of document.querySelectorAll("iframe")) frames.add(frame);
    const frame = [...frames].find(
      (frame) => frame.isConnected && frame.contentWindow === event.source,
    );
    if (!frame?.contentWindow) return;
    const child = event.ports[0];
    for (const [old, owner] of children) {
      if (owner.frame === frame) {
        old.close();
        children.delete(old);
      }
    }
    children.set(child, { frame, window: frame.contentWindow });
    child.onmessage = ({ data }) => {
      if (
        stopped ||
        !children.has(child) ||
        !frame.isConnected ||
        frame.contentWindow !== children.get(child)?.window
      )
        return;
      const operation = data?.operation;
      if (!Number.isSafeInteger(data?.id) || data.id < 1 || !operation) return;
      if (!["set", "remove", "clear"].includes(operation.type)) return;
      if (operation.type !== "clear" && typeof operation.key !== "string") return;
      if (operation.type === "set" && typeof operation.value !== "string") return;
      try {
        write(operation);
      } catch {}
      child.postMessage({ values: [...values], acknowledged: data.id });
    };
    child.postMessage({ values: [...values] });
  });
  window.addEventListener(
    "pagehide",
    () => {
      stopped = true;
      port.close();
      for (const child of children.keys()) child.close();
      children.clear();
    },
    { once: true, capture: true },
  );
}

export function bootstrapPreviewDocument(
  config: { contextId: string; applicationOrigin: string; resourceRoot: string } | null,
  install: () => void,
  storage: typeof installPreviewStorage,
): void {
  const source = JSON.parse(document.getElementById("r3-document-source")!.textContent!);
  const channel = new MessageChannel();
  const port = channel.port1;
  let initialized = false;
  const childDocument = (html: string): string => {
    if (html.startsWith("<!doctype html><html data-r3-storage-shell>")) return html;
    const script = `(${bootstrapPreviewDocument.toString()})(null,()=>{},${storage.toString()})`;
    return (
      '<!doctype html><html data-r3-storage-shell><head><meta charset="utf-8"><script type="application/json" id="r3-document-source">' +
      JSON.stringify(html).replaceAll("<", "\\u003c") +
      "</script><script>" +
      script.replace(/<\/script/gi, "<\\/script").replaceAll("<!--", "<\\!--") +
      "</script></head><body></body></html>"
    );
  };
  const prepare = (html: string) => {
    if (!/<iframe[\s>]/i.test(html)) return html;
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const frames = parsed.querySelectorAll("iframe[srcdoc]");
    if (!frames.length) return html;
    for (const frame of frames)
      frame.setAttribute("srcdoc", childDocument(frame.getAttribute("srcdoc")!));
    const doctype = parsed.doctype ? new XMLSerializer().serializeToString(parsed.doctype) : "";
    return doctype + parsed.documentElement.outerHTML;
  };
  port.onmessage = ({ data }) => {
    if (initialized || !Array.isArray(data?.values)) return;
    initialized = true;
    const html = prepare(source);
    document.open();
    storage(data.values, port, childDocument);
    install();
    document.write(html);
    document.close();
  };
  parent.postMessage(
    config
      ? {
          type: "r3-preview-storage-connect",
          contextId: config.contextId,
          path: decodeURIComponent(
            location.pathname.slice(new URL(config.resourceRoot).pathname.length),
          ),
        }
      : { type: "r3-preview-storage-child" },
    config?.applicationOrigin ?? "*",
    [channel.port2],
  );
}
