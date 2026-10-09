# Remote backend protocol, version 1

This document defines authorization extensions to `artifacts-v1`.
`GET /api/health` advertises `r3-auth-v1` in its `capabilities` array.

## Client authorization


Ordinary API and stream requests accept an API key or OAuth access token in
`Authorization: Bearer` or `X-R3-Token`. Browser cookies retain the existing
single-owner login model. Sessions used for authorship are not credentials.
All API routes retain Host and Origin checks, including the public OAuth routes;
opaque preview origins cannot authorize requests. Responses are `no-store`.

Keys can be created, listed, and revoked with `r3 auth create-key`, `list-clients`, and
`revoke-client`. Keys optionally expire. No external identity provider is involved.

Client login uses the [OAuth device authorization grant](https://www.rfc-editor.org/rfc/rfc8628):

| Route | Request | Response |
| --- | --- | --- |
| `POST /api/oauth/device/code` | Form: `client_id=r3-cli`, optional `label` | `device_code`, `user_code`, `verification_uri`, `verification_uri_complete`, `expires_in`, `interval` |
| `POST /api/oauth/token` | Form: `client_id=r3-cli`, device grant `grant_type=urn:ietf:params:oauth:grant-type:device_code`, `device_code` | `access_token`, `refresh_token`, `token_type=Bearer`, `expires_in` |
| `POST /api/oauth/token` | Form: `client_id=r3-cli`, `grant_type=refresh_token`, `refresh_token` | A fresh access token and rotated refresh token |
| `POST /api/oauth/device/inspect` | JSON: `userCode` | `label`, `expiresAt`, `requestIp` |
| `POST /api/oauth/device/decision` | JSON: `userCode`, boolean `approved` | `{ "ok": true }` |

The first two routes require no prior credential. Approval requires an authenticated
r3 browser session when login is enabled; an API key cannot approve another device.
`/authorize` shows the code and observed request address, then requires an explicit
Approve or Decline action. Merely opening the link does not grant access.

Device grants expire after ten minutes and are consumed once. Polls start at five
seconds; an early poll receives `slow_down` and adds five seconds to the interval.
Other OAuth errors include `authorization_pending`, `access_denied`, `expired_token`,
`invalid_grant`, and `unsupported_grant_type`, with HTTP 400. Forms are limited to
8 KiB, reject duplicate fields, and accept only the public `r3-cli` client. The
server limits authorization requests per observed source to 60/minute, with at most
256 active device flows and a bounded source-rate map. Capacity failures return 429.

Access tokens last 15 minutes; refresh tokens expire after 90 days unused and
rotate on every refresh. Reuse revokes the authorization, following [OAuth security guidance](https://www.rfc-editor.org/rfc/rfc9700).
Management routes require ordinary authentication:

| Route | Contract |
| --- | --- |
| `GET /api/auth/clients` | Authorization IDs, kind, label, creation, expiry and revocation timestamps; no secret hashes |
| `POST /api/auth/clients` | Optional `label`, optional future `expiresAt` in epoch milliseconds; returns `id`, one-time `token`, `expiresAt` |
| `DELETE /api/auth/clients/:id` | Revoke that authorization |
| `GET /api/auth/audit` | Latest 1,000 observations, newest first |

The approval transaction records server time and separate observed CLI and browser
source addresses before any token is issued. The worker address is initially null.
The server uses the actual connection peer. Only an explicitly configured immediate
`trustedProxies` peer may supply one valid `X-Forwarded-For` address; chains are not
guessed. A trusted proxy must overwrite the header. Audit data contains no bearer,
refresh, device, cookie, or harness secrets. Addresses are observations, not identity.
