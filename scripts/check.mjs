import { readdir, readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
let checked = 0;
async function check(directory) {
  for (const name of await readdir(directory)) {
    const file = new URL(name, directory);
    if ((await stat(file)).isDirectory()) { await check(new URL(name + '/', directory)); continue; }
    if (!/\.(?:m?js)$/.test(name)) continue;
    const result = spawnSync(process.execPath, ['--check', fileURLToPath(file)], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/(?:from\s*|import\s*)['"](\.\.?\/[^'"]+)['"]/g)) {
      await stat(new URL(match[1], file));
    }
    checked++;
  }
}
for (const directory of ['web/', 'scripts/', 'tests/']) await check(new URL(directory, root));
console.log(`Checked ${checked} JavaScript modules and relative imports.`);
