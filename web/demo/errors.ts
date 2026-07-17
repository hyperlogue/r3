// The demo backend throws the same ApiError the real fetch client does, so
// components that branch on `err.status` (e.g. ReviewView treating 404 as
// "deleted") behave identically against the in-browser backend. Kept in its own
// module so backend.ts and api.ts can both import it without a cycle.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
