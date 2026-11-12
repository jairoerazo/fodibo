import type { Declaration } from '../agent/types.js';
import { splitKey } from './fields.js';
import { ExpedienteError } from './errors.js';
import type { ExpedienteService } from './service.js';
import type { Canton } from './types.js';

/**
 * Crea un expediente con una `hauptperson`, guarda cada clave de la declaración como campo confirmado (sin evidencias)
 * y lo aprueba. Sirve para el expediente de prueba y para la equivalencia con `declaracion.json`.
 */
export async function seedFromDeclaration(
  svc: ExpedienteService,
  decl: Declaration,
  opts: { taxYear: number; jurisdiction: Canton; label: string },
): Promise<{ caseId: string }> {
  // Todo es síncrono (el servicio serializa por dentro); la firma async deja libre el contrato.
  const { caseId } = svc.createCase({ taxYear: opts.taxYear, jurisdiction: opts.jurisdiction, persons: [{ role: 'hauptperson', label: opts.label }] });
  for (const [key, entry] of Object.entries(decl)) {
    const parts = splitKey(key, svc.concepts);
    if (!parts) throw new ExpedienteError('invalid_input', 'La declaración tiene una clave que no está en el catálogo.', { field: 'key' });
    svc.saveField(caseId, {
      conceptId: parts.conceptId,
      variant: parts.variant,
      valor: entry.valor,
      ...(entry.moneda ? { moneda: entry.moneda } : {}),
      evidence: [],
    });
  }
  svc.approve(caseId, svc.getCase(caseId).revision);
  return { caseId };
}
