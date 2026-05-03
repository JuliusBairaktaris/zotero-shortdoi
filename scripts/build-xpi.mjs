#!/usr/bin/env node
// Build a Zotero .xpi (zip) of the addon. Mirrors the old built.bat but
// runs cross-platform and pulls the version from manifest.json so the two
// can never drift.

import { createWriteStream, readFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import archiver from "archiver";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");

const INCLUDE = ["content", "lib", "locale", "skin", "bootstrap.js", "manifest.json", "prefs.js", "zoteroshortdoi.js"];

const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
const outFile = join(DIST, `zotero-doi-manager-${manifest.version}.xpi`);

mkdirSync(DIST, { recursive: true });
rmSync(outFile, { force: true });

const output = createWriteStream(outFile);
const archive = archiver("zip", { zlib: { level: 9 } });

output.on("close", () => {
  const sizeKb = (archive.pointer() / 1024).toFixed(1);
  console.log(`Built ${outFile} (${sizeKb} KB)`);
});

archive.on("warning", (err) => {
  if (err.code === "ENOENT") console.warn(err);
  else throw err;
});
archive.on("error", (err) => { throw err; });

archive.pipe(output);

const SKIP_DIRS = new Set(["__tests__"]);

for (const entry of INCLUDE) {
  const src = join(ROOT, entry);
  if (entry.includes(".")) {
    archive.file(src, { name: entry });
  } else {
    archive.glob("**/*", {
      cwd: src,
      ignore: [...SKIP_DIRS].map((d) => `**/${d}/**`),
    }, { prefix: entry });
  }
}

await archive.finalize();
