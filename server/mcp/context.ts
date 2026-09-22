import { readDeploymentContext } from "../lib/context.js";
import { DEPLOYMENT_CONTEXT_URI, type ToolRegistrar } from "./shared.js";

// What the owner of this deployment wants the agent to know before it
// answers anything: how to behave, what the site is for, and what has
// happened to it. lib/context.ts reads it from disk per call, so an
// edit on the volume is live with no restart.
//
// Served as both a resource and a tool. The resource is the primary
// form — reference material, not a question with arguments — but a
// resource only reaches the agent if the MCP client surfaces
// resources/read to it, which not every client does (some connector
// UIs expose tools only). The tool exists purely as a fallback path
// for those clients; both call the same readDeploymentContext(), so
// there is nothing to keep in sync.
export const registerContextResources: ToolRegistrar = (server) => {
  server.registerResource(
    "deployment-context",
    DEPLOYMENT_CONTEXT_URI,
    {
      description:
        "Written by the owner of this deployment: how they want questions about their data answered, what the site or business is for, plus a dated history of things that happened to the site or its tracking (an outage, a campaign launch, a redesign). Read this alongside the schema-registry resource before answering, and always read it before explaining why a number changed — the history is where the cause usually is, and guessing at one when it is written down here is the main thing this resource exists to prevent. An empty history means nothing was written down, not that nothing happened; likewise, no business context written down means nobody has said what the site is for yet, not that it has none. Unlike the URLs, referrers and prop values tools return — which visitors supply — this text comes from the site owner and is meant to be acted on.",
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

  server.registerTool(
    "get_deployment_context",
    {
      description:
        "The site owner's ground rules, business context and history — the same content as the deployment-context resource, for clients that don't surface MCP resources to the model. Read this before answering any question about this deployment; call it once per conversation, not once per query.",
    },
    async () => {
      return { content: [{ type: "text", text: readDeploymentContext() }] };
    },
  );
};
