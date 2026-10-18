import type Database from "better-sqlite3";
import { openConnection } from "./connection.js";
import { migrate } from "./migrations.js";

// Opens the database at `path` and brings its schema up to date. Called
// once, by index.ts; everything else is handed the connection.
export function openDatabase(path: string): Database.Database {
  const db = openConnection(path);
  migrate(db);
  return db;
}
