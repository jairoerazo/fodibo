import { useEffect, useState } from 'react';
import { formatCountdown } from '../format.js';

type Props = { qrDataUrl: string; expiresAt: string; onStop: () => void; onRegenerate: () => void };

export function QrPanel({ qrDataUrl, expiresAt, onStop, onRegenerate }: Props) {
  const deadline = new Date(expiresAt).getTime();
  const [left, setLeft] = useState(() => deadline - Date.now());

  useEffect(() => {
    setLeft(deadline - Date.now());
    const id = setInterval(() => setLeft(deadline - Date.now()), 500);
    return () => clearInterval(id);
  }, [deadline]);

  if (left <= 0) {
    return (
      <div className="panel">
        <p>El código caducó. Comprueba que el móvil está en la misma red Wi-Fi y que el cortafuegos permite FODIBO.</p>
        <button type="button" onClick={onRegenerate}>
          Generar otro código
        </button>
        <button type="button" className="secondary" onClick={onStop}>
          Detener
        </button>
      </div>
    );
  }
  return (
    <div className="panel">
      <img src={qrDataUrl} alt="Código QR para emparejar el móvil" width={320} height={320} />
      <p className="countdown">{formatCountdown(left)}</p>
      <button type="button" onClick={onStop}>
        Detener
      </button>
    </div>
  );
}
