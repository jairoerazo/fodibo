/**
 * Crea y aprueba un expediente de prueba con la declaración de test-portal/declaracion.json.
 * Imprime el caseId. Entorno: FODIBO_DATA_DIR (por defecto ./.dev-data).
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDeclaration } from '../src/core/agent/index.js';
import { ExpedienteService } from '../src/core/expediente/index.js';
import { seedFromDeclaration } from '../src/core/expediente/seed.js';

const dataDir = process.env.FODIBO_DATA_DIR || './.dev-data';
let svc: ExpedienteService | undefined;
try {
  const raw = JSON.parse(readFileSync(fileURLToPath(new URL('../test-portal/declaracion.json', import.meta.url)), 'utf8')) as unknown;
  const inboxDir = join(dataDir, 'inbox');
  mkdirSync(inboxDir, { recursive: true });
  svc = await ExpedienteService.open({ dataDir, inboxDir });
  const { caseId } = await seedFromDeclaration(svc, loadDeclaration(raw), { taxYear: 2025, jurisdiction: 'ZH', label: 'Titular de prueba' });
  process.stdout.write(`${caseId}\n`);
} catch {
  process.stderr.write('No se pudo crear el expediente de prueba.\n');
  process.exitCode = 1;
} finally {
  svc?.close();
}
