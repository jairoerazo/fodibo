import { randomUUID } from 'node:crypto';
import { readdirSync, writeFileSync, rmSync, lstatSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDF, closeAll, mk, sha, writePackage } from '../../core/expediente/__tests__/fixtures.js';
import { serveDocument } from '../doc-protocol.js';

afterEach(() => {
  closeAll();
  vi.restoreAllMocks();
});

async function setup() {
  const h = await mk();
  const pkg = writePackage(h.inboxDir, [{ name: 'Lohn', mime: 'application/pdf', body: PDF }]);
  const res = await h.svc.importPackage(h.caseId, pkg.packageId);
  const documentId = res.documents[0]!.documentId;
  const blob = join(h.dataDir, 'expediente', 'blobs', sha(PDF).slice(0, 2), sha(PDF));
  return { ...h, documentId, blob, url: `fodibo-doc://doc/${documentId}` };
}

describe('serveDocument', () => {
  it('sirve el PDF con 200 y las cabeceras de seguridad', async () => {
    const { svc, url } = await setup();
    const r = await serveDocument(svc, url, null);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/pdf');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('accept-ranges')).toBe('bytes');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(Buffer.from(await r.arrayBuffer()).equals(PDF)).toBe(true);
  });

  it('expone CORS para el renderer (200, 206, 404 y 409) con las cabeceras de rango visibles', async () => {
    const { svc, url } = await setup();
    const rs = [await serveDocument(svc, url, null), await serveDocument(svc, url, 'bytes=0-9'), await serveDocument(svc, 'fodibo-doc://doc/nope', null)];
    for (const r of rs) {
      expect(r.headers.get('access-control-allow-origin')).toBe('*');
      expect(r.headers.get('access-control-expose-headers')).toBe('Content-Range, Accept-Ranges, Content-Length');
    }
  });

  it('Range bytes=0-9 da 206 con 10 bytes y Content-Range', async () => {
    const { svc, url } = await setup();
    const r = await serveDocument(svc, url, 'bytes=0-9');
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe(`bytes 0-9/${PDF.length}`);
    const body = Buffer.from(await r.arrayBuffer());
    expect(body.length).toBe(10);
    expect(body.equals(PDF.subarray(0, 10))).toBe(true);
  });

  it('admite rangos abiertos y de sufijo, y recorta el final al tamaño', async () => {
    const { svc, url } = await setup();
    const open = await serveDocument(svc, url, 'bytes=5-');
    expect(open.headers.get('content-range')).toBe(`bytes 5-${PDF.length - 1}/${PDF.length}`);
    expect(Buffer.from(await open.arrayBuffer()).equals(PDF.subarray(5))).toBe(true);
    const suffix = await serveDocument(svc, url, 'bytes=-4');
    expect(Buffer.from(await suffix.arrayBuffer()).equals(PDF.subarray(PDF.length - 4))).toBe(true);
    const over = await serveDocument(svc, url, 'bytes=0-99999');
    expect(over.status).toBe(206);
    expect(Buffer.from(await over.arrayBuffer()).length).toBe(PDF.length);
  });

  it('un rango imposible da 416', async () => {
    const { svc, url } = await setup();
    const r = await serveDocument(svc, url, `bytes=${PDF.length}-${PDF.length + 5}`);
    expect(r.status).toBe(416);
    expect(r.headers.get('content-range')).toBe(`bytes */${PDF.length}`);
  });

  it('una cabecera Range que no es un rango simple se ignora', async () => {
    const { svc, url } = await setup();
    expect((await serveDocument(svc, url, 'bytes=0-1,3-4')).status).toBe(200);
    expect((await serveDocument(svc, url, 'items=0-1')).status).toBe(200);
  });

  it.each([
    ['recorrido de ruta', 'fodibo-doc://doc/../../etc/passwd'],
    ['host distinto', `fodibo-doc://otro/${randomUUID()}`],
    ['UUID inexistente', `fodibo-doc://doc/${randomUUID()}`],
    ['mayúsculas', `fodibo-doc://doc/${randomUUID().toUpperCase()}`],
    ['otro esquema', `file:///etc/passwd`],
  ])('404: %s', async (_n, url) => {
    const { svc } = await setup();
    const r = await serveDocument(svc, url, null);
    expect(r.status).toBe(404);
    expect(await r.text()).toBe('');
  });

  it('404 con sufijos tras el UUID', async () => {
    const { svc, url } = await setup();
    for (const extra of ['/', '?x=1', '#a', '/../x', '%2e']) expect((await serveDocument(svc, url + extra, null)).status).toBe(404);
  });

  it('un blob alterado da 409 con cuerpo vacío y el documento queda no disponible', async () => {
    const { svc, url, blob, caseId, documentId } = await setup();
    chmodSync(blob, 0o644);
    const bad = Buffer.from(PDF);
    bad[bad.length - 2] ^= 0xff;
    writeFileSync(blob, bad);
    const r = await serveDocument(svc, url, null);
    expect(r.status).toBe(409);
    expect(await r.text()).toBe('');
    expect(svc.getCase(caseId).documents.find((d) => d.documentId === documentId)!.available).toBe(false);
    expect((await serveDocument(svc, url, 'bytes=0-3')).status).toBe(409);
  });

  it('un blob borrado da 404 y el siguiente getCase lo marca available:false', async () => {
    const { svc, url, blob, caseId, documentId } = await setup();
    expect(svc.getCase(caseId).documents[0]!.available).toBe(true);
    chmodSync(blob, 0o644);
    rmSync(blob);
    const r = await serveDocument(svc, url, null);
    expect(r.status).toBe(404);
    expect(svc.getCase(caseId).documents.find((d) => d.documentId === documentId)!.available).toBe(false);
  });

  it('no registra ni devuelve rutas o nombres', async () => {
    const { svc, url, blob } = await setup();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    chmodSync(blob, 0o644);
    rmSync(blob);
    const r = await serveDocument(svc, url, null);
    expect([...r.headers.values()].join(' ')).not.toMatch(/Lohn|blobs/);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/Lohn|blobs/);
  });
});

describe('documentLocation', () => {
  it('devuelve la copia de originales/ con el nombre saneado y deduplicado', async () => {
    const h = await mk();
    const pkg = writePackage(h.inboxDir, [
      { name: 'foto.png', mime: 'image/png', body: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('a')]) },
      { name: 'FOTO.png', mime: 'image/png', body: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('b')]) },
    ]);
    // originales/ lo crea la transferencia: se simula con los nombres que ella produciría.
    const { mkdirSync, linkSync } = await import('node:fs');
    mkdirSync(join(pkg.dir, 'originales'));
    const names = ['foto.png', 'FOTO (2).png'];
    pkg.entries.forEach((e, i) => linkSync(join(pkg.dir, 'files', e.sha256), join(pkg.dir, 'originales', names[i]!)));
    const res = await h.svc.importPackage(h.caseId, pkg.packageId);
    expect(await h.svc.documentLocation(res.documents[0]!.documentId)).toBe(join(pkg.dir, 'originales', 'foto.png'));
    expect(await h.svc.documentLocation(res.documents[1]!.documentId)).toBe(join(pkg.dir, 'originales', 'FOTO (2).png'));
  });

  it('cae al blob si originales/ no existe, y falla con not_found si no hay documento', async () => {
    const { svc, documentId, blob } = await setup();
    expect(await svc.documentLocation(documentId)).toBe(blob);
    await expect(svc.documentLocation(randomUUID())).rejects.toMatchObject({ code: 'not_found' });
  });

  it('cae al blob si el nombre de originales/ es un directorio o un enlace roto', async () => {
    const { svc, documentId, blob, inboxDir } = await setup();
    const pkgId = readdirSync(inboxDir)[0]!;
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(inboxDir, pkgId, 'originales', 'Lohn.pdf'), { recursive: true });
    expect(lstatSync(join(inboxDir, pkgId, 'originales', 'Lohn.pdf')).isDirectory()).toBe(true);
    expect(await svc.documentLocation(documentId)).toBe(blob);
  });
});
