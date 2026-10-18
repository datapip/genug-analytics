import type Database from "better-sqlite3";
import { openConnection } from "./connection.js";
import { migrate } from "./migrations.js";

// Opens the database at `path` and brings its tables up to date. Only
// index.ts calls this; other code receives the connection as a parameter.
export function openDatabase(path: string): Database.Database {
  const db = openConnection(path);
  migrate(db);
  return db;
}
