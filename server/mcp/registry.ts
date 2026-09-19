import { eventRegistry, serializeRegistry } from "@genug/schema-registry";
import {
  SCHEMA_REGISTRY_URI,
  jsonContent,
  type ToolRegistrar,
} from "./shared.js";

// What this deployment's event vocabulary actually is. The agent is
// meant to read this before calling anything else, so it grounds itself
// in real event/prop names instead of guessing them.
export const registerRegistryTools: ToolRegistrar = (server) => {
  server.registerResource(
    "schema-registry",
    SCHEMA_REGISTRY_URI,
    {
      description:
        "Every event type this server accepts: its description and each prop's description, example, declared type (string/number/boolean/null), and whether it's required or optional. Read this before calling get_traffic_summary or get_top_pages so custom event props aren't guessed at.",
      mimeType: "application/json",
    },
    async (uri) => {
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(serializeRegistry(), null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "list_event_types",
    {
      description:
        "List all known event types with a short description of what each one means, and which ones the deployment has flagged as a conversion (a business goal — a signup, a purchase, a newsletter subscribe). A deployment may flag none, one, or several. Read the schema-registry resource for full prop details before querying.",
    },
    async () => {
      const types = Object.entries(eventRegistry).map(([name, definition]) => ({
        name,
        description: definition.description,
        conversion: definition.conversion,
      }));
      return jsonContent(types, true);
    },
  );
};
