import { compareVersions, R3_VERSION } from "../../shared/version.ts";

export class ServerVersionStore {
  private version: string | null = null;
  private requested = 0;
  private observed = 0;
  private readonly listeners = new Set<() => void>();
  constructor(private readonly clientVersion: string) {}

  getSnapshot = () => this.version;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  beginRequest(): (version: string | null) => void {
    const sequence = ++this.requested;
    return (version) => {
      if (!version || sequence < this.observed) return;
      const order = compareVersions(version, this.clientVersion);
      if (order === null) return;
      // An old request finishing after reconnect must not hide the new notice.
      this.observed = sequence;
      const next = order === 0 ? null : version;
      if (next === this.version) return;
      this.version = next;
      for (const listener of this.listeners) listener();
    };
  }
}

export const serverVersion = new ServerVersionStore(R3_VERSION);
