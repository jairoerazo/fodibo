import type { ReceivedPackage } from '../../core/transfer/index.js';
import { PackageCard } from './PackageCard.js';

export function PackageList({
  packages,
  onOpen,
  onImport,
  importHint,
}: {
  packages: ReceivedPackage[];
  onOpen: (packageId: string) => void;
  onImport?: (packageId: string) => void;
  importHint?: string;
}) {
  if (packages.length === 0) return <p className="empty">Aún no has recibido ningún paquete.</p>;
  return (
    <section>
      {packages.map((p) => (
        <PackageCard key={p.receipt.package_id} pkg={p} onOpen={onOpen} onImport={onImport} importHint={importHint} />
      ))}
    </section>
  );
}
