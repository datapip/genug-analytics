// Which build this is. Stamped in at image build time from the tag being
// published (see the Dockerfile's GENUG_VERSION arg); from a clone there
// is no tag and "dev" is the honest answer.
//
// It exists because once images are pulled rather than built, a bug
// report has to be able to say which genug it came from — so the startup
// log and the MCP handshake both carry it.
export const VERSION = process.env.GENUG_VERSION || "dev";
