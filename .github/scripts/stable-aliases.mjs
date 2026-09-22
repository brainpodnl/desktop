// `releases/latest/download/<name>` resolves the newest release but not the
// asset inside it, and every bundler stamps the version into its filename — so
// a README cannot link a download that survives the next tag. This uploads a
// second, version-less copy of each installer under a name that never changes,
// which is what those permanent links point at.
//
// Only installers are copied. Updater payloads keep their versioned names:
// `latest.json` names them explicitly and is rewritten every release anyway.
//
// Usage: node .github/scripts/stable-aliases.mjs <tag> <slug> [target-triple]

import { copyFileSync, existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [tag, slug, target] = process.argv.slice(2);

if (!tag || !slug) {
  console.error('stable-aliases: usage: <tag> <slug> [target-triple]');
  process.exit(1);
}

const bundles = target
  ? join('src-tauri', 'target', target, 'release', 'bundle')
  : join('src-tauri', 'target', 'release', 'bundle');

if (!existsSync(bundles)) {
  console.error(`stable-aliases: ${bundles} does not exist; did the bundle step run?`);
  process.exit(1);
}

// First match wins, so the NSIS installer is claimed before the bare `.exe`
// rule would see it.
const rules = [
  [/-setup\.exe$/, `Brainpod-${slug}-setup.exe`],
  [/\.dmg$/, `Brainpod-${slug}.dmg`],
  [/\.AppImage$/, `Brainpod-${slug}.AppImage`],
  [/\.deb$/, `Brainpod-${slug}.deb`],
  [/\.rpm$/, `Brainpod-${slug}.rpm`],
  [/\.msi$/, `Brainpod-${slug}.msi`],
];

function* walk(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

const staging = mkdtempSync(join(tmpdir(), 'brainpod-aliases-'));
const uploads = [];

for (const path of walk(bundles)) {
  if (path.endsWith('.sig')) continue;

  const rule = rules.find(([pattern]) => pattern.test(path));
  if (!rule) continue;

  const alias = join(staging, rule[1]);
  copyFileSync(path, alias);
  uploads.push(alias);
  console.log(`${path} -> ${rule[1]}`);
}

if (uploads.length === 0) {
  console.error(`stable-aliases: no installer found under ${bundles}`);
  process.exit(1);
}

// `--clobber` because a re-run of a flaked platform has to replace the copy it
// uploaded last time rather than fail on the name already being taken.
const upload = spawnSync('gh', ['release', 'upload', tag, ...uploads, '--clobber'], {
  stdio: 'inherit',
});

if (upload.status !== 0) {
  console.error(`stable-aliases: gh release upload exited ${upload.status ?? 'on a signal'}`);
  process.exit(1);
}
