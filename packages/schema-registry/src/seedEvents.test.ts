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

// A volume that already has events belongs to the deployment, and
// seeding must never change it, least of all bring back a renamed file.
test("a populated volume is left completely alone", () => {
  const image = imageDirectory();
  const volume = emptyVolume();
  writeFileSync(join(volume, "seitenaufruf.json"), '{"mine":true}');

  const { source, errors } = seedEvents(image, volume);

  assert.deepEqual(errors, []);
  assert.equal(source, volume);
  assert.deepEqual(readdirSync(volume), ["seitenaufruf.json"]);
});

// After renaming page_view.json to seitenaufruf.json, copying "whatever
// is missing" would bring back page_view.json, and two events with
// "_pageView" would stop the server.
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

// Other files don't count: a volume with only a README still gets the
// built-in events.
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

// The usual development case: no /data, so the clone's own events are
// used. It is reported, because in a container it means the volume isn't
// mounted where EVENTS_PATH says.
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
  // A deployment's own event, a renamed built-in, and an edited built-in:
  // the three ways a volume can differ from the image.
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
  // The edit is undone.
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
  // Only .json files are deleted; other files were put there by a person.
  assert.equal(
    readFileSync(join(volume, "notes.txt"), "utf8"),
    "not an event file",
  );
});

test("resetEvents refuses when the volume IS the image directory", () => {
  // EVENTS_PATH may point at the image's folder. Deleting would remove
  // the files the reset copies from, leaving no events while reporting
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
