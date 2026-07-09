// The build version, shared by the daemon and the CLI. Both are produced from
// the same source/binary, so they agree in dev; a mismatch only arises when the
// binary is upgraded while an old daemon is still running (the tmux
// client/server version-skew problem). `GET /api/health` reports this and the
// CLI compares it against its own. Bump on any wire-format or
// daemon-protocol change.
export const R3_VERSION = "0.1.0";
