import { join } from "node:path";
import { json, type Request, type Response, type Router } from "express";
import { z } from "zod";
import { contextPath } from "../../lib/context.js";
import { writeGroundRules } from "../../lib/writeGroundRules.js";
import { writeBusinessContext } from "../../lib/writeBusinessContext.js";
import { appendHistoryEntry, HISTORY_FILE } from "../../lib/history.js";
import { parseEditBody, refusesCockpitOrigin } from "./guards.js";

// Saves what the agent reads before answering: the ground rules, the
// business context and the history log.

// The body for saving the ground rules or the business context: the
// whole text. No length check here; the writers check the size in bytes,
// which z.string().max() can't (it counts characters).
const proseFieldSchema = z.strictObject({ text: z.string() });

// The request size limit for the two text fields. The text may be up to
// MAX_PROSE_FIELD_BYTES (32kb), but JSON escaping makes the request
// bigger (a `"`, `\` or newline takes 2 bytes). Too small a limit would
// make Express reject the request before the writer can return its
// clear "too long" message, so this is well over double the text limit.
const parseProseFieldBody = json({ limit: "128kb" });

export function registerContextRoutes(router: Router): void {
  router.put(
    "/context/ground-rules",
    parseProseFieldBody,
    (req: Request, res: Response) => {
      if (
        refusesCockpitOrigin(
          req,
          res,
          "Ground rules must be saved from the cockpit page.",
        )
      ) {
        return;
      }

      const body = proseFieldSchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ ok: false, error: "Malformed request." });
        return;
      }

      const result = writeGroundRules(body.data.text, contextPath);
      if (!result.ok) {
        res.status(400).json(result);
        return;
      }

      res.json({ ok: true });
    },
  );

  // Like the route above, for the business context. It returns no
  // usingDefault, because the business context has no default text.
  router.put(
    "/context/about",
    parseProseFieldBody,
    (req: Request, res: Response) => {
      if (
        refusesCockpitOrigin(
          req,
          res,
          "The site's context must be saved from the cockpit page.",
        )
      ) {
        return;
      }

      const body = proseFieldSchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ ok: false, error: "Malformed request." });
        return;
      }

      const result = writeBusinessContext(body.data.text, contextPath);
      if (!result.ok) {
        res.status(400).json(result);
        return;
      }

      res.json({ ok: true });
    },
  );

  // Adds one dated entry to history.json, using the same append-only
  // writer as the add_history_note MCP tool (mcp/admin.ts). Editing or
  // deleting an entry is deliberately left to editing the file by hand:
  // the agent treats this text as instructions, so changing it should
  // take more than a form (see docs/decisions.md).
  router.post(
    "/context/history",
    parseEditBody,
    (req: Request, res: Response) => {
      if (
        refusesCockpitOrigin(
          req,
          res,
          "A history note must be added from the cockpit page.",
        )
      ) {
        return;
      }

      const result = appendHistoryEntry(
        join(contextPath, HISTORY_FILE),
        req.body,
      );
      if (!result.ok) {
        res.status(400).json(result);
        return;
      }

      res.json({ ok: true, entry: result.entry, total: result.total });
    },
  );
}
