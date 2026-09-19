import { db, dbPath } from "./connection.js";
import { migrate } from "./migrations.js";

migrate(db);

export { db, dbPath };
