// Notarization, decoupled from the build.
//
// `tauri build` notarizes inline: it submits the app and blocks on
// `notarytool --wait`, which has no upper bound. Apple's notary service can
// hold a submission for minutes or for hours — a new Developer ID identity is
// held for additional analysis until the service learns to recognise it — and
// a release workflow that waits inline is a release that cannot be shipped on
// a schedule anybody controls.
//
// So the bundle step signs only, and notarization happens here in two phases:
//
//   submit  after the bundles are uploaded. Submits the disk image, waits a
//           bounded number of minutes, and staples if Apple answers in time.
//           If it does not, a marker asset records the submission id and the
//           job ends anyway.
//   finish  from `notarize.yml`, which sweeps the marker up later, staples,
//           replaces the asset and deletes the marker.
//
// The ticket is stapled to the `.dmg` rather than to the `.app` inside it.
// Stapling the app would mean rebuilding and re-signing the disk image around
// it, and Apple supports stapling a disk image directly. The tradeoff is that
// a Mac with no network on first launch cannot see the app's own ticket; every
// online Mac resolves it against Apple.
//
// Usage: node .github/scripts/notarize-dmg.mjs submit <tag> <slug> <target> <wait-minutes>
//        node .github/scripts/notarize-dmg.mjs finish <tag>

import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MARKER = (slug) => `notarization-${slug}.json`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

// CI passes the Apple ID triple. A Mac running this by hand should not have to
// put an app-specific password in its environment: `notarytool
// store-credentials` keeps one in the data-protection keychain, and
// APPLE_KEYCHAIN_PROFILE names it.
function notary(args) {
  const profile = process.env.APPLE_KEYCHAIN_PROFILE;
  if (profile) return run('xcrun', ['notarytool', ...args, '--keychain-profile', profile]);

  const credentials = ['--apple-id', process.env.APPLE_ID, '--password', process.env.APPLE_PASSWORD, '--team-id', process.env.APPLE_TEAM_ID];
  if (credentials.some((value) => !value)) {
    console.error('notarize-dmg: set APPLE_KEYCHAIN_PROFILE, or all of APPLE_ID, APPLE_PASSWORD and APPLE_TEAM_ID');
    process.exit(1);
  }
  return run('xcrun', ['notarytool', ...args, ...credentials]);
}

// notarytool prints `  key: value` blocks; the submission id is the first one.
function field(output, key) {
  return output.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? '';
}

function upload(tag, files) {
  // `--clobber` so a re-run replaces its own earlier attempt instead of
  // failing on a name that is already taken.
  const result = run('gh', ['release', 'upload', tag, ...files, '--clobber'], { stdio: 'inherit', encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(`notarize-dmg: gh release upload exited ${result.status}`);
    process.exit(1);
  }
}

function staple(path) {
  const result = run('xcrun', ['stapler', 'staple', path], { stdio: 'inherit', encoding: 'utf8' });
  return result.status === 0;
}

function submit(tag, slug, target, waitMinutes) {
  const bundles = target
    ? join('src-tauri', 'target', target, 'release', 'bundle', 'dmg')
    : join('src-tauri', 'target', 'release', 'bundle', 'dmg');

  if (!existsSync(bundles)) {
    console.error(`notarize-dmg: ${bundles} does not exist; did the bundle step run?`);
    process.exit(1);
  }

  const name = readdirSync(bundles).find((entry) => entry.endsWith('.dmg'));
  if (!name) {
    console.error(`notarize-dmg: no .dmg under ${bundles}`);
    process.exit(1);
  }

  const dmg = join(bundles, name);
  console.log(`submitting ${name} (${statSync(dmg).size} bytes)`);

  const submission = notary(['submit', dmg, '--no-wait']);
  const id = field(submission.stdout, 'id');
  if (submission.status !== 0 || !id) {
    console.error(submission.stdout + submission.stderr);
    console.error('notarize-dmg: submission failed');
    process.exit(1);
  }
  console.log(`submission ${id}`);

  // A bounded wait, not an open one. When the notary is healthy this returns
  // in a couple of minutes and the release is complete when the job ends.
  const waited = notary(['wait', id, '--timeout', `${waitMinutes}m`]);
  const status = field(waited.stdout, 'status');
  console.log(`status after ${waitMinutes}m: ${status || 'no answer'}`);

  if (status === 'Invalid') {
    console.error(notary(['log', id]).stdout);
    console.error('notarize-dmg: Apple rejected the disk image');
    process.exit(1);
  }

  if (status === 'Accepted' && staple(dmg)) {
    const alias = join(mkdtempSync(join(tmpdir(), 'brainpod-notarized-')), `Brainpod-${slug}.dmg`);
    run('cp', [dmg, alias]);
    upload(tag, [dmg, alias]);
    console.log(`stapled and replaced ${name} and Brainpod-${slug}.dmg`);
    return;
  }

  // Still queued. Record what `finish` needs and let the job end: the assets
  // on the release are signed and will be replaced with stapled copies once
  // Apple answers.
  const marker = join(mkdtempSync(join(tmpdir(), 'brainpod-pending-')), MARKER(slug));
  writeFileSync(marker, JSON.stringify({ submission: id, dmg: name, alias: `Brainpod-${slug}.dmg`, slug }, null, 2));
  upload(tag, [marker]);
  console.log(`::warning::${name} is signed but not stapled; notarize.yml will finish submission ${id}`);
}

function finish(tag) {
  const assets = run('gh', ['release', 'view', tag, '--json', 'assets', '--jq', '.assets[].name']);
  if (assets.status !== 0) {
    console.error(assets.stderr);
    process.exit(1);
  }

  const markers = assets.stdout.split('\n').map((line) => line.trim()).filter((name) => /^notarization-.+\.json$/.test(name));
  if (markers.length === 0) {
    console.log(`no pending notarization on ${tag}`);
    return;
  }

  const staging = mkdtempSync(join(tmpdir(), 'brainpod-finish-'));
  let pending = 0;

  for (const name of markers) {
    run('gh', ['release', 'download', tag, '--pattern', name, '--dir', staging, '--clobber'], { stdio: 'inherit', encoding: 'utf8' });
    const { submission, dmg, alias, slug } = JSON.parse(readFileSync(join(staging, name), 'utf8'));

    const status = field(notary(['info', submission]).stdout, 'status');
    console.log(`${slug}: ${submission} -> ${status || 'unknown'}`);

    if (status === 'In Progress') {
      pending += 1;
      continue;
    }

    if (status !== 'Accepted') {
      console.error(notary(['log', submission]).stdout);
      console.error(`notarize-dmg: ${slug} did not pass notarization (${status || 'no status'})`);
      process.exit(1);
    }

    run('gh', ['release', 'download', tag, '--pattern', dmg, '--dir', staging, '--clobber'], { stdio: 'inherit', encoding: 'utf8' });
    const path = join(staging, dmg);

    if (!staple(path)) {
      console.error(`notarize-dmg: ${dmg} is Accepted but the ticket could not be stapled yet`);
      pending += 1;
      continue;
    }

    const copy = join(staging, alias);
    run('cp', [path, copy]);
    upload(tag, [path, copy]);
    run('gh', ['release', 'delete-asset', tag, name, '--yes'], { stdio: 'inherit', encoding: 'utf8' });
    console.log(`${slug}: stapled, replaced ${dmg} and ${alias}, marker removed`);
  }

  if (pending > 0) console.log(`${pending} submission(s) still queued at Apple; the next run picks them up`);
}

const [mode, tag, ...rest] = process.argv.slice(2);

if (!tag) {
  console.error('notarize-dmg: usage: submit <tag> <slug> <target> <wait-minutes> | finish <tag>');
  process.exit(1);
}

if (mode === 'submit') {
  const [slug, target, waitMinutes] = rest;
  if (!slug) {
    console.error('notarize-dmg: submit needs a slug');
    process.exit(1);
  }
  submit(tag, slug, target || '', Number(waitMinutes) > 0 ? Number(waitMinutes) : 10);
} else if (mode === 'finish') {
  finish(tag);
} else {
  console.error(`notarize-dmg: unknown mode ${mode}`);
  process.exit(1);
}
