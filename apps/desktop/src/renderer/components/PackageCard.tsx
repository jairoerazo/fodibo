import type { ReceivedPackage } from '../../core/transfer/index.js';
import { formatSize } from '../format.js';

export function PackageCard({
  pkg,
  onOpen,
  onImport,
  importHint,
}: {
  pkg: ReceivedPackage;
  onOpen: (packageId: string) => void;
  /** Si se pasa, se ofrece «Importar al expediente». */
  onImport?: (packageId: string) => void;
  /** Motivo por el que no se puede importar (p. ej. no hay expediente activo): deshabilita el botón. */
  importHint?: string;
}) {
  const { receipt, deviceName } = pkg;
  return (
    <article className="card">
      <header>
        <strong>{deviceName}</strong>
        <time dateTime={receipt.received_at}>{new Date(receipt.received_at).toLocaleString('es')}</time>
      </header>
      <ul>
        {receipt.files.map((f) => (
          <li key={f.file_id}>
            <span className="name">{f.name}</span>
            <span className="meta">
              {f.mime} · {formatSize(f.size)}
            </span>
            <span className="ok">✓ Integridad verificada</span>
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => onOpen(receipt.package_id)}>
        Abrir carpeta
      </button>
      {onImport && (
        <>
          {' '}
          <button
            type="button"
            disabled={importHint !== undefined}
            aria-describedby={importHint ? `import-hint-${receipt.package_id}` : undefined}
            onClick={() => onImport(receipt.package_id)}
          >
            Importar al expediente
          </button>
          {importHint && (
            <small id={`import-hint-${receipt.package_id}`} className="meta">
              {importHint}
            </small>
          )}
        </>
      )}
    </article>
  );
}
