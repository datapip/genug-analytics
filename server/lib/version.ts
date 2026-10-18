// Which release this build is. The Docker image sets it from the release
// tag (the Dockerfile's GENUG_VERSION arg). A build from a git clone has
// no tag and reports "dev". The startup log and the MCP handshake both
// include it, so a bug report can say which version it came from.
export const VERSION = process.env.GENUG_VERSION || "dev";
