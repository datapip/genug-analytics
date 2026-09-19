import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedEvents } from "./seedEvents.js";
import { resetEventFiles } from "./registry.js";

function imageDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "genug-image-"));
  writeFileSync(join(dir, "page_view.json"), '{"shipped":true}');
  writeFileSync(join(dir, "file_download.json"), "{}");
  return dir;
}

function emptyVolume(): string {
  return mkdtempSync(join(tmpdir(), "genug-volume-"));
}

test("an empty volume gets every event file the image ships", () => {
  const image = imageDirectory();
  const volume = emptyVolume();

  const { source, errors } = seedEvents(image, volume);

  assert.deepEqual(errors, []);
  assert.equal(source, volume);
  assert.deepEqual(readdirSync(volume).sort(), [
    "file_download.json",
    "page_view.json",
  ]);
});

test("a volume that does not exist yet is created", () => {
  const image = imageDirectory();
  const volume = join(emptyVolume(), "events");

  const { source, errors } = seedEvents(image, volume);

  assert.deepEqual(errors, []);
  assert.equal(source, volume);
  assert.deepEqual(readdirSync(volume), [
    "file_download.json",
    "page_view.json",
  ]);
});

// The whole point. A volume that already holds events is somebody's
// configuration, and seeding must never reach into it again — least of
// all to restore a file they renamed.
test("a populated volume is left completely alone", () => {
  const image = imageDirectory();
  const volume = emptyVolume();
  writeFileSync(join(volume, "seitenaufruf.json"), '{"mine":true}');

  const { source, errors } = seedEvents(image, volume);

  assert.deepEqual(errors, []);
  assert.equal(source, volume);
  assert.deepEqual(readdirSync(volume), ["seitenaufruf.json"]);
});

// Renaming page_view.json to seitenaufruf.json is the case the "copy
// whatever is missing" version of this got wrong: it would restore
// page_view.json, and two events carrying "_pageView" stop the server.
test("a renamed built-in does not come back on the next start", () => {
  const image = imageDirectory();
  const volume = emptyVolume();
  seedEvents(image, volume);

  const renamed = join(volume, "seitenaufruf.json");
  writeFileSync(renamed, readFileSync(join(volume, "page_view.json"), "utf8"));
  unlinkSync(join(volume, "page_view.json"));

  seedEvents(image, volume);

  assert.deepEqual(readdirSync(volume).sort(), [
    "file_download.json",
    "seitenaufruf.json",
  ]);
});

// Files that are not events stay out of the way — a volume holding only
// a README is still an unseeded volume.
test("only .json files are copied, and only they count as seeded", () => {
  const image = imageDirectory();
  writeFileSync(join(image, "README.md"), "not an event");
  const volume = emptyVolume();
  writeFileSync(join(volume, "notes.txt"), "not an event either");

  const { errors } = seedEvents(image, volume);

  assert.deepEqual(errors, []);
  assert.deepEqual(readdirSync(volume).sort(), [
    "file_download.json",
    "notes.txt",
    "page_view.json",
  ]);
});

// The ordinary development case: no /data, nothing to seed, and the
// clone's own events serve. Reported rather than silent, because in a
// container the same situation means the volume is not mounted where
// EVENTS_PATH says.
test("a volume whose parent is missing is not created, and is reported", () => {
  const image = imageDirectory();
  const volume = join(emptyVolume(), "no", "such", "parent");

  const { source, errors } = seedEvents(image, volume);

  assert.equal(source, image);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.file, volume);
  assert.match(errors[0]!.messages.join(), /does not exist/);
});

/* ---------- resetEvents ---------- */

test("resetEvents replaces everything on the volume with the image's events", () => {
  const image = imageDirectory();
  const volume = emptyVolume();
  seedEvents(image, volume);
  // A deployment's own event, a renamed built-in, and an edit to one
  // that kept its name — the three ways a volume drifts from the image.
  writeFileSync(join(volume, "order_completed.json"), "{}");
  writeFileSync(join(volume, "seitenaufruf.json"), '{"renamed":true}');
  unlinkSync(join(volume, "page_view.json"));
  writeFileSync(join(volume, "file_download.json"), '{"edited":true}');

  const result = resetEventFiles(image, volume);

  assert.equal(result.ok, true);
  assert.deepEqual(readdirSync(volume).sort(), [
    "file_download.json",
    "page_view.json",
  ]);
  // The edit is undone, not merely joined by a fresh copy.
  assert.equal(readFileSync(join(volume, "file_download.json"), "utf8"), "{}");
  assert.equal(
    readFileSync(join(volume, "page_view.json"), "utf8"),
    '{"shipped":true}',
  );
});

test("resetEvents reports what it removed", () => {
  const image = imageDirectory();
  const volume = emptyVolume();
  writeFileSync(join(volume, "order_completed.json"), "{}");
  writeFileSync(join(volume, "notes.txt"), "not an event file");

  const result = resetEventFiles(image, volume);

  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.removed, ["order_completed.json"]);
  assert.deepEqual((result.ok && result.restored).sort(), [
    "file_download.json",
    "page_view.json",
  ]);
  // Only .json files are the registry's to manage; anything else on the
  // volume was put there by a person and is not ours to delete.
  assert.equal(
    readFileSync(join(volume, "notes.txt"), "utf8"),
    "not an event file",
  );
});

test("resetEvents refuses when the volume IS the image directory", () => {
  // EVENTS_PATH can be pointed here. Clearing the volume would delete
  // the very files the reset restores from, and re-seeding would copy
  // an empty directory over itself — every event gone, reported as a
  // success.
  const image = imageDirectory();

  const result = resetEventFiles(image, image);

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /Nothing was changed/);
  assert.deepEqual(readdirSync(image).sort(), [
    "file_download.json",
    "page_view.json",
  ]);
});

test("resetEvents changes nothing when the image ships no events", () => {
  const image = emptyVolume(); // no event files in it
  const volume = emptyVolume();
  writeFileSync(join(volume, "order_completed.json"), "{}");

  const result = resetEventFiles(image, volume);

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /Nothing was changed/);
  assert.deepEqual(readdirSync(volume), ["order_completed.json"]);
});
