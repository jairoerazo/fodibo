import { createHash, X509Certificate } from 'node:crypto';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fingerprintOf, loadOrCreateCertificate } from '../certificate.js';

describe('certificate', () => {
  it('crea el certificado y lo reutiliza', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fodibo-cert-'));
    const a = await loadOrCreateCertificate(dir);
    const b = await loadOrCreateCertificate(dir);
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(b.certPem).toBe(a.certPem);
    expect((await stat(join(dir, 'key.pem'))).mode & 0o777).toBe(0o600);
  });

  it('la huella tiene el formato del contrato', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fodibo-cert-'));
    const { certPem, fingerprint } = await loadOrCreateCertificate(dir);
    expect(fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    const hex = createHash('sha256').update(new X509Certificate(certPem).raw).digest('hex');
    expect(fingerprint).toBe(`sha256:${hex}`);
    expect(fingerprintOf(certPem)).toBe(fingerprint);
  });
});
