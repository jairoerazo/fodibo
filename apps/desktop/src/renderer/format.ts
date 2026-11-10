/** Tamaño legible con coma decimal: 2 481 930 bytes → «2,4 MB». */
export function formatSize(bytes: number): string {
  const one = (n: number) => n.toFixed(1).replace('.', ',');
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${one(bytes / 1024)} KB`;
  return `${one(bytes / (1024 * 1024))} MB`;
}

/** Segundos restantes → «mm:ss». */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/** Quita el prefijo que Electron añade a los errores de `invoke`. */
export function cleanIpcError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
}
