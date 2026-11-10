import Ajv2020Module from 'ajv/dist/2020.js';
import type { Ajv2020 as Ajv2020Type } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { manifestSchema } from '@fodibo/contracts';
import { TransferError } from './errors.js';
import { MAX_FILE_BYTES, MAX_PACKAGE_BYTES, type Manifest } from './types.js';

const Ajv2020 = Ajv2020Module as unknown as typeof Ajv2020Type;
const ajv = new Ajv2020({ strict: true });
(addFormats as unknown as (a: Ajv2020Type) => void)(ajv);
const validate = ajv.compile<Manifest>(manifestSchema);

function exceedsLimits(body: unknown): boolean {
  const files = (body as { files?: unknown } | null)?.files;
  if (!Array.isArray(files)) return false;
  let total = 0;
  for (const f of files) {
    const size = (f as { size?: unknown } | null)?.size;
    if (typeof size !== 'number' || !Number.isFinite(size)) continue;
    if (size > MAX_FILE_BYTES) return true;
    total += size;
  }
  return total > MAX_PACKAGE_BYTES;
}

export function parseManifest(body: unknown): Manifest {
  // Los límites de tamaño tienen prioridad: el esquema también falla con un archivo > 50 MB.
  if (exceedsLimits(body)) throw new TransferError('too_large', 'El paquete supera los límites de tamaño');
  if (!validate(body)) throw new TransferError('invalid_manifest', 'Manifiesto inválido');
  return body;
}
