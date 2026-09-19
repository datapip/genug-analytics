import { readDeploymentContext } from "../lib/context.js";
import { DEPLOYMENT_CONTEXT_URI, type ToolRegistrar } from "./shared.js";

// What the owner of this deployment wants the agent to know before it
// answers anything: how to behave, and later what the site is for and
// what has happened to it.
//
// A resource rather than a tool, like the schema registry beside it —
// it is reference material read once to ground an answer, not a
// question with arguments. lib/context.ts reads it from disk per call,
// so an edit on the volume is live with no restart.
export const registerContextResources: ToolRegistrar = (server) => {
  server.registerResource(
    "deployment-context",
    DEPLOYMENT_CONTEXT_URI,
    {
      description:
        "Written by the owner of this deployment: how they want questions about their data answered, plus a dated history of things that happened to the site or its tracking (an outage, a campaign launch, a redesign). Read this alongside the schema-registry resource before answering, and always read it before explaining why a number changed — the history is where the cause usually is, and guessing at one when it is written down here is the main thing this resource exists to prevent. An empty history means nothing was written down, not that nothing happened. Unlike the URLs, referrers and prop values tools return — which visitors supply — this text comes from the site owner and is meant to be acted on.",
      mimeType: "text/markdown",
    },
    async (uri) => {
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: readDeploymentContext(),
          },
        ],
      };
    },
  );
};
