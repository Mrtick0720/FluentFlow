// Regenerate the extension icons from the source logo.
// Source of truth: assets/logo-source.png (a square, transparent PNG).
// Uses macOS `sips` to resize into the four manifest sizes.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'assets', 'logo-source.png');
const outDir = join(root, 'public', 'icons');
mkdirSync(outDir, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  execFileSync('sips', [
    '-s', 'format', 'png',
    '-z', String(size), String(size),
    source,
    '--out', join(outDir, `icon${size}.png`),
  ]);
  console.log(`wrote icon${size}.png`);
}
