#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const required = pkg.files || [];
const missing = required.filter((name) => !existsSync(join(root, name)));
if (missing.length) {
  throw new Error('pack missing: ' + missing.join(', '));
}

const dsh = pkg.dsh || {};
if (!dsh.bundle || dsh.bundle.patch !== './cordis.patch.yml') {
  throw new Error('dsh.bundle.patch must be ./cordis.patch.yml');
}
if (!dsh.client || dsh.client.platform !== 'web') {
  throw new Error('dsh.client.platform must be web');
}
if (!existsSync(join(root, 'cordis.patch.yml'))) {
  throw new Error('cordis.patch.yml missing');
}

const leaked = ['node_modules', 'test', '.git'].filter((name) => required.includes(name) || required.some((f) => f.startsWith(name + '/')));
if (leaked.length) {
  throw new Error('pack leaked: ' + leaked.join(', '));
}

console.log('pack files declared:');
for (const name of required) console.log('  ' + name);
console.log('pack ok:', pkg.name + '@' + pkg.version);
