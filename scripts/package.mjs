#!/usr/bin/env node
// Release packaging: builds the extension without sourcemaps and zips it into
// an artifact a stranger can install — the extension under `dist/`, the
// native-messaging helper for Unlimited mode, `update.sh`, and the
// instructions. The zip extracts straight into `~/.local/share/crazyagent`,
// which puts the extension at a fixed path; Chromium derives an unpacked
// extension's id from that path, so every later update lands on the same id and
// keeps the browser-side storage (conversations, settings) and the native-host
// manifest valid.
// Usage: node scripts/package.mjs [--allow-dirty]
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const release = path.join(root, "release");
const stage = path.join(release, ".stage");
const allowDirty = process.argv.includes("--allow-dirty");

function fail(msg) {
  console.error(`[package] ${msg}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: root, stdio: "inherit", ...opts });
  if (res.status !== 0) fail(`${cmd} ${args.join(" ")} failed`);
}

function instructions({ name, version, stamp }) {
  const installDir = "~/.local/share/crazyagent";
  return `crazyAgent ${version} (build ${stamp})
An AI browser agent in a Chromium sidebar.

INSTALL
  mkdir -p ${installDir}
  unzip ${name} -d ${installDir}

  Then open chrome://extensions (Edge and Brave work too), turn on Developer
  mode and choose "Load unpacked" -> ${installDir}/dist

  Click the toolbar icon to open the side panel, then Settings: pick a provider
  (Anthropic, or any OpenAI-compatible endpoint), a model and an API key.

UNLIMITED MODE (optional; Linux)
  sh ${installDir}/helper/install.sh <extension-id>
  sh ${installDir}/helper/profile-setup.sh
  then restart the browser. The id is on the extension's card in
  chrome://extensions.

UPDATE
  sh ${installDir}/update.sh
  then press the reload arrow on the extension's card in chrome://extensions.

  That fetches the newest release zip and replaces the contents of this folder
  in place, so nothing else to remember. The folder itself must not move: the
  extension id is the sha256 of its absolute path, so a new path means a new id,
  empty browser storage, and a native-host manifest that no longer matches.

  Updating by hand from a zip you downloaded yourself:
    unzip -o crazyagent.zip -d ${installDir}
`;
}

// Fail before building, not after, when the archiver is missing.
if (spawnSync("zip", ["--version"], { stdio: "ignore" }).status !== 0) {
  fail("packaging needs the `zip` binary (on Debian/Ubuntu: apt install zip)");
}

await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });

// Build straight into the staging tree: your own dist/ keeps its sourcemaps,
// and the artifact cannot pick up a stale file left in it.
run("node", [
  "build/build.mjs",
  "--no-sourcemap",
  "--outdir",
  path.join(stage, "dist"),
]);

const manifest = JSON.parse(
  await readFile(path.join(stage, "dist", "manifest.json"), "utf8"),
);
const version = manifest.version;
const stamp = manifest.version_name || "unknown";

// A stamped build is traceable to a commit; anything else is not something to
// hand out. `--allow-dirty` is the escape hatch for trying the artifact locally.
if (!allowDirty && (stamp === "unknown" || stamp.endsWith("-dirty"))) {
  await rm(stage, { recursive: true, force: true });
  fail(
    `refusing to package build "${stamp}": commit your changes first, ` +
      `or pass --allow-dirty to package it anyway`,
  );
}

// One stable name, so the GitHub "latest release" download URL never changes
// and the shipped update.sh can fetch it without knowing the version. The build
// stamp still identifies the artifact — from inside dist/manifest.json.
const name = "crazyagent.zip";
const artifact = path.join(release, name);
await rm(artifact, { force: true });

await cp(path.join(root, "helper"), path.join(stage, "helper"), {
  recursive: true,
});
await cp(
  path.join(root, "installer", "update.sh"),
  path.join(stage, "update.sh"),
);
// Explicit rather than inherited, so a checkout that lost the bit cannot ship
// an updater nobody can run.
await chmod(path.join(stage, "update.sh"), 0o755);
await writeFile(
  path.join(stage, "README.txt"),
  instructions({ name, version, stamp }),
);

run("zip", ["-qrX", artifact, "dist", "helper", "update.sh", "README.txt"], {
  cwd: stage,
});
await rm(stage, { recursive: true, force: true });

const bytes = await readFile(artifact);
const sha256 = createHash("sha256").update(bytes).digest("hex");

console.log(`[package] ${path.relative(root, artifact)}`);
console.log(
  `[package] ${(bytes.length / 1024).toFixed(0)} KB · build ${stamp} · sha256 ${sha256}`,
);
console.log(
  `[package] install: mkdir -p ~/.local/share/crazyagent && unzip ${name} -d ~/.local/share/crazyagent`,
);
console.log(
  "[package] update:  sh ~/.local/share/crazyagent/update.sh, then reload in chrome://extensions",
);
console.log(
  `[package] attach to a GitHub Release keeping the name ${name}, so releases/latest/download/${name} resolves`,
);
