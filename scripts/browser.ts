import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real browser acceptance uses a caller-supplied Chromium executable. No package
// download, browser installation, user profile, or running daemon is involved.
export async function openTestBrowser(flags: string[] = []) {
  const executable = process.env.R3_TEST_BROWSER;
  if (!executable) throw new Error("Set R3_TEST_BROWSER to a Chromium executable");
  const profile = await mkdtemp(join(tmpdir(), "r3-browser-"));
  const browser = Bun.spawn(
    [
      executable,
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-background-networking",
      "--disable-dev-shm-usage",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      ...flags,
      "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  let socket: WebSocket | undefined;
  let id = 0;
  const events = new Set<(event: any) => void>();
  const pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const close = async () => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error("Browser closed"));
    }
    pending.clear();
    socket?.close();
    browser.kill();
    await Promise.race([browser.exited, Bun.sleep(1000)]);
    if (browser.exitCode === null) browser.kill("SIGKILL");
    await browser.exited;
    await rm(profile, { recursive: true, force: true });
  };
  try {
    let port = "";
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0];
        break;
      } catch {
        await Bun.sleep(50);
      }
    }
    if (!port) throw new Error("Browser did not start its testing endpoint");
    const info = (await fetch(`http://127.0.0.1:${port}/json/version`).then((response) =>
      response.json(),
    )) as { webSocketDebuggerUrl: string };
    socket = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket!.onopen = () => resolve();
      socket!.onerror = () => reject(new Error("Browser testing connection failed"));
    });
    socket.onmessage = (event) => {
      const response = JSON.parse(String(event.data));
      for (const listener of events) listener(response);
      const item = pending.get(response.id);
      if (!item) return;
      pending.delete(response.id);
      clearTimeout(item.timer);
      if (response.error) item.reject(new Error(response.error.message));
      else item.resolve(response.result);
    };
    const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
      new Promise<any>((resolve, reject) => {
        const key = ++id;
        const timer = setTimeout(() => {
          pending.delete(key);
          reject(new Error(`Browser command timed out: ${method}`));
        }, 15_000);
        pending.set(key, { resolve, reject, timer });
        socket!.send(
          JSON.stringify({ id: key, method, params, ...(sessionId ? { sessionId } : {}) }),
        );
      });
    const attach = async (targetId: string) => {
      const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
      const command = (method: string, params: Record<string, unknown> = {}) =>
        send(method, params, sessionId);
      const contexts = new Map<number, any>();
      events.add((event) => {
        if (event.sessionId !== sessionId) return;
        if (event.method === "Runtime.executionContextCreated")
          contexts.set(event.params.context.id, event.params.context);
        if (event.method === "Runtime.executionContextDestroyed")
          contexts.delete(event.params.executionContextId);
        if (event.method === "Runtime.executionContextsCleared") contexts.clear();
      });
      await command("Page.enable");
      await command("Runtime.enable");
      const evaluate = async <T = any>(expression: string, contextId?: number): Promise<T> => {
        const result = await command("Runtime.evaluate", {
          expression,
          returnByValue: true,
          awaitPromise: true,
          ...(contextId === undefined ? {} : { contextId }),
        });
        if (result.exceptionDetails)
          throw new Error(
            result.exceptionDetails.exception?.description || "Browser evaluation failed",
          );
        return result.result.value as T;
      };
      return {
        command,
        evaluate,
        contexts,
        inContext: (contextId: number) => ({
          command,
          evaluate: <T = any>(expression: string) => evaluate<T>(expression, contextId),
        }),
      };
    };
    return {
      send,
      attach,
      close,
      listen: (listener: (event: any) => void) => {
        events.add(listener);
        return () => {
          events.delete(listener);
        };
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function eventually<T>(
  read: () => Promise<T>,
  description: string,
): Promise<Exclude<T, null | undefined | false>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value as Exclude<T, null | undefined | false>;
    await Bun.sleep(50);
  }
  throw new Error(`Browser acceptance timed out: ${description}`);
}
