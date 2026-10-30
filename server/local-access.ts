import { createHash, randomBytes } from "node:crypto";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

// The URL carries only a one-use ticket. Reusable credentials never enter links.
export class LocalBrowserAccess {
  private readonly tickets = new Map<string, number>();

  constructor(private readonly clock = Date.now) {}

  cleanup(): void {
    const now = this.clock();
    for (const [key, expires] of this.tickets) if (expires <= now) this.tickets.delete(key);
  }

  issue(): string {
    this.cleanup();
    if (this.tickets.size >= 32) this.tickets.delete(this.tickets.keys().next().value!);
    const ticket = randomBytes(32).toString("base64url");
    this.tickets.set(digest(ticket), this.clock() + 60_000);
    return ticket;
  }

  consume(ticket: string): boolean {
    this.cleanup();
    return this.tickets.delete(digest(ticket));
  }
}
