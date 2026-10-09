import { createHash, randomBytes } from "node:crypto";
import type { AuthService } from "./auth.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
// Tickets exist only in this server process. Browser links carry a one-use,
// short-lived ticket in their fragment, never an API or reusable login token.
export class LocalBrowserAccess {
  private readonly tickets = new Map<string, number>();
  constructor(
    private readonly authentication: AuthService,
    private readonly clock = Date.now,
  ) {}
  issue(): string {
    for (const [key, expires] of this.tickets)
      if (expires <= this.clock()) this.tickets.delete(key);
    if (this.tickets.size >= 32) this.tickets.delete(this.tickets.keys().next().value!);
    const ticket = randomBytes(32).toString("base64url");
    this.tickets.set(digest(ticket), this.clock() + 60_000);
    return ticket;
  }
  consume(ticket: string): { cookieValue: string; maxAgeSeconds: number } | null {
    const key = digest(ticket),
      expires = this.tickets.get(key);
    this.tickets.delete(key);
    if (!expires || expires <= this.clock()) return null;
    const { info } = this.authentication.createLoginToken("Local browser");
    return this.authentication.mintSession(info.id);
  }
}
