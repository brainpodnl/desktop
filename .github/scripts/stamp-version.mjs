// A release is cut by creating it on GitHub, so its tag is the only statement
// of what version is being built. The version fields committed to the tree are
// a development placeholder; this rewrites them in the checkout before the
// bundlers read them, so the installer, the binary and the updater manifest all
// agree with the tag without anyone having to remember to bump three files.
//
// Usage: node .github/scripts/stamp-version.mjs 0.2.0

import { readFileSync, writeFileSync } from 'node:fs';

const version = process.argv[2];

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? '')) {
  console.error(`stamp-version: '${version ?? ''}' is not a semver version`);
  process.exit(1);
}

function rewrite(path, transform) {
  const before = readFileSync(path, 'utf8');
  const after = transform(before);
  writeFileSync(path, after);
  return after;
}

const json = (source) => source.replace(/"version": "[^"]*"/, `"version": "${version}"`);

rewrite('package.json', json);
rewrite('src-tauri/tauri.conf.json', json);
// Only the first `version = ` in a manifest belongs to the package itself;
// every later one is a dependency requirement.
rewrite('src-tauri/Cargo.toml', (source) =>
  source.replace(/^version = "[^"]*"$/m, `version = "${version}"`),
);

for (const [path, found] of [
  ['package.json', JSON.parse(readFileSync('package.json', 'utf8')).version],
  ['src-tauri/tauri.conf.json', JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')).version],
  [
    'src-tauri/Cargo.toml',
    readFileSync('src-tauri/Cargo.toml', 'utf8').match(/^version = "([^"]*)"$/m)?.[1],
  ],
]) {
  if (found !== version) {
    console.error(`stamp-version: ${path} says ${found ?? '<nothing>'} after rewriting`);
    process.exit(1);
  }
  console.log(`${path} -> ${version}`);
}
