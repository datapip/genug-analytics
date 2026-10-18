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

// The cockpit's JSON routes. Mounted behind the session gate
// (lib/cockpitAuth.ts); the page and its files are served after it, by
// app.ts. One router, so the two rules below cover every route in
// cockpit/, including the next one someone adds there.

export interface CockpitRouterDeps {
  db: Database.Database;
  // Refuses every write, see below.
  readOnly: boolean;
  timezone: string;
  // The sites ALLOWED_ORIGIN lists; the top pages card names a row's
  // site whenever there is more than one.
  siteHosts: ReadonlySet<string>;
  // Typed again to confirm a danger-zone action (cockpit/danger.ts).
  cockpitPassword: string;
  // undefined keeps events forever; shown in the page's footnote.
  retentionDays: number | undefined;
}

export function createCockpitRouter(deps: CockpitRouterDeps): Router {
  const router = Router();

  // These answers carry visitors' URLs and prop values: no cache may keep
  // them, shared or the browser's own on a shared machine after sign-out.
  // Requests that fall through to the pages and files below get their own
  // header there, which replaces this one.
  router.use((_req: Request, res: Response, next: NextFunction) => {
    res.set("Cache-Control", "private, no-store");
    next();
  });

  // Read-only mode closes every write on this router in one place, by
  // method rather than by route: an edit, a new event, a reload and both
  // danger-zone resets are all POST or PUT, and so will be the next write
  // someone adds. Answered with a message that says the deployment is
  // read-only, not a bare 403 that would read as a broken page, and
  // checked before the CSRF header so that a cross-site form gets the
  // same answer as the page itself — there is nothing here to protect
  // from a forged request that a real one could not do either.
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
