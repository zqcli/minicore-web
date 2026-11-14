import { cp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const destination = new URL('dist/', root);
await rm(destination, { recursive: true, force: true });
await mkdir(destination);
for (const name of await readdir(new URL('web/', root))) {
  if (name.endsWith('.local.json')) continue;
  await cp(new URL('web/' + name, root), new URL(name, destination), { recursive: true });
}
const { version } = JSON.parse(await readFile(new URL('package.json', root)));
console.log(`MiniCore Web ${version}: ${fileURLToPath(destination)}`);
