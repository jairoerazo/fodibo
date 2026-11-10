import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const CORE = fileURLToPath(new URL('../../', import.meta.url));
const FORBIDDEN = [/from\s+['"]electron['"]/, /require\(\s*['"]electron['"]\s*\)/, /from\s+['"]react['"]/];

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await tsFiles(p)));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

it('src/core no importa electron ni react (criterio 6)', async () => {
  const files = await tsFiles(CORE);
  expect(files.length).toBeGreaterThan(5);
  const offenders: string[] = [];
  for (const f of files) {
    if (f.endsWith('core-isolation.test.ts')) continue;
    const src = await readFile(f, 'utf8');
    if (FORBIDDEN.some((re) => re.test(src))) offenders.push(f);
  }
  expect(offenders).toEqual([]);
});
