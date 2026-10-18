import { join } from "node:path";
import { json, type Request, type Response, type Router } from "express";
import { z } from "zod";
import { contextPath } from "../../lib/context.js";
import { writeGroundRules } from "../../lib/writeGroundRules.js";
import { writeBusinessContext } from "../../lib/writeBusinessContext.js";
import { appendHistoryEntry, HISTORY_FILE } from "../../lib/history.js";
import { parseEditBody, refusesCockpitOrigin } from "./guards.js";

// The writes to what the agent reads before answering: ground rules,
// the site's context, and the history log.

// The whole ground-rules or business-context file, overwritten in one
// call — see lib/writeGroundRules.ts and lib/writeBusinessContext.ts
// for why a whole-file overwrite is right for free prose with no shape
// to merge against. No length check here: each field's writer enforces
// the real cap, in bytes rather than the characters z.string().max()
// would count. Shared by both routes below since the body shape is
// identical either way.
const proseFieldSchema = z.strictObject({ text: z.string() });

// Every other write on this router sends a few hundred bytes at most —
// event names, descriptions, prop metadata — so parseEditBody's 64kb was
// never close to MAX_PROSE_FIELD_BYTES (32kb). These two are the first
// bodies that can get close. JSON-escapes its content (a `"`, `\` or
// newline in ordinary prose each cost 2 bytes instead of 1), so a
// document sitting right at the content cap can push the *request
// body* — not the text — past 64kb, and body-parser rejects it before
// the route or the writer's own friendly error ever runs. Comfortably
// over double the content cap even under pessimistic escaping, rather
// than testing around the collision. Shared by both routes for the same
// reason proseFieldSchema is: same body shape, same cap.
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

  // The business-context counterpart to the route above — same body
  // shape, same writer pattern (lib/writeBusinessContext.ts), no
  // usingDefault to report back since there is nothing to fall back to.
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

  // Adds one dated entry to history.json — the cockpit's counterpart to
  // the add_history_note MCP tool (mcp/admin.ts), sharing the same
  // append-only writer. Deliberately not extended to edit or delete an
  // entry: those stay a file edit on the volume, exactly as they were
  // before this route existed (see docs/decisions.md) — a person fixing a
  // typo in a form is a small win next to what full CRUD over text the
  // agent reads as instruction would cost.
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
