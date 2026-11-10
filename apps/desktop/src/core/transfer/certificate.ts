import { X509Certificate, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generate } from 'selfsigned';

export interface Certificate {
  certPem: string;
  keyPem: string;
  fingerprint: string;
}

export function fingerprintOf(certPem: string): string {
  const der = new X509Certificate(certPem).raw;
  return `sha256:${createHash('sha256').update(der).digest('hex')}`;
}

export async function loadOrCreateCertificate(dir: string): Promise<Certificate> {
  const certPath = join(dir, 'cert.pem');
  const keyPath = join(dir, 'key.pem');
  try {
    const [certPem, keyPem] = await Promise.all([
      readFile(certPath, 'utf8'),
      readFile(keyPath, 'utf8'),
    ]);
    return { certPem, keyPem, fingerprint: fingerprintOf(certPem) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  const notBeforeDate = new Date();
  const notAfterDate = new Date(notBeforeDate);
  notAfterDate.setFullYear(notAfterDate.getFullYear() + 10);
  const pems = await generate([{ name: 'commonName', value: 'fodibo-desktop' }], {
    keyType: 'ec',
    curve: 'P-256',
    notBeforeDate,
    notAfterDate,
  });
  const certPem = pems.cert;
  const keyPem = pems.private;

  await mkdir(dir, { recursive: true });
  await writeFile(keyPath, keyPem, { mode: 0o600 });
  await writeFile(certPath, certPem);
  return { certPem, keyPem, fingerprint: fingerprintOf(certPem) };
}
