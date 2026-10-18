import type Database from "better-sqlite3";
import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { registerDataRoutes } from "./cockpit/data.js";
import { registerEventRoutes } from "./cockpit/events.js";
import { registerContextRoutes } from "./cockpit/context.js";
import { registerDangerRoutes } from "./cockpit/danger.js";

// The cockpit's JSON routes. They sit behind the sign-in check
// (lib/cockpitAuth.ts); app.ts serves the page and its files. All of
// them share this router, so the two rules below apply to every route
// in cockpit/, including new ones.

export interface CockpitRouterDeps {
  db: Database.Database;
  // Refuses every write, see below.
  readOnly: boolean;
  timezone: string;
  // The sites ALLOWED_ORIGIN lists. With more than one, the top pages
  // card shows each row's site.
  siteHosts: ReadonlySet<string>;
  // Typed again to confirm a danger-zone action (cockpit/danger.ts).
  cockpitPassword: string;
  // undefined keeps events forever; shown in the page's footnote.
  retentionDays: number | undefined;
}

export function createCockpitRouter(deps: CockpitRouterDeps): Router {
  const router = Router();

  // These responses contain visitors' URLs and prop values, so no cache
  // may keep them: not a shared one, and not the browser's own on a
  // shared computer after sign-out. Requests for the page and its files
  // get their own header later, which replaces this one.
  router.use((_req: Request, res: Response, next: NextFunction) => {
    res.set("Cache-Control", "private, no-store");
    next();
  });

  // Read-only mode blocks every write in one place, by HTTP method rather
  // than by route: anything but GET and HEAD is refused, so a write added
  // later is covered too. The answer says the deployment is read-only, so it
  // doesn't look like a broken page. It runs before the CSRF check: in
  // read-only mode no request can change anything, forged or not.
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (!deps.readOnly || req.method === "GET" || req.method === "HEAD") {
      next();
      return;
    }
    res.status(403).json({
      ok: false,
      error:
        "This deployment is read-only (READ_ONLY=true): events cannot be " +
        "edited, created, reloaded or reset from the cockpit.",
    });
  });

  registerDataRoutes(router, deps);
  registerEventRoutes(router, deps);
  registerContextRoutes(router);
  registerDangerRoutes(router, deps);
  return router;
}
