import type { ReceivedPackage } from '../../core/transfer/index.js';
import { formatSize } from '../format.js';

export function PackageCard({ pkg, onOpen }: { pkg: ReceivedPackage; onOpen: (packageId: string) => void }) {
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
    </article>
  );
}
