import type https from 'node:https';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { loadOrCreateCertificate } from '../certificate.js';
import { TransferServer, type ServerHooks } from '../server.js';

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

it('una subida grande en Wi-Fi lenta no la corta requestTimeout de Node', async () => {
  dir = await mkdtemp(join(tmpdir(), 'fodibo-srv-'));
  const cert = await loadOrCreateCertificate(dir);
  const server = new TransferServer(cert, {} as ServerHooks);
  const inner = (server as unknown as { server: https.Server }).server;
  // 0 = sin límite: la inactividad de sesión y el corte por estancamiento del cliente cubren los cuelgues.
  expect(inner.requestTimeout).toBe(0);
  // La cabecera sí debe llegar pronto aunque el cuerpo tarde.
  expect(inner.headersTimeout).toBeGreaterThan(0);
  expect(inner.headersTimeout).toBeLessThanOrEqual(60_000);
});
