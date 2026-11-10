import { useCallback, useEffect, useState } from 'react';
import type { ReceivedPackage } from '../core/transfer/index.js';
import { AgentPanel } from './components/AgentPanel.js';
import { PackageList } from './components/PackageList.js';
import { QrPanel } from './components/QrPanel.js';
import { cleanIpcError } from './format.js';

type View =
  | { kind: 'idle'; notice?: string }
  | { kind: 'starting' }
  | { kind: 'waiting'; qrDataUrl: string; expiresAt: string }
  | { kind: 'paired'; deviceName: string };

const CLOSED_NOTICE = {
  stopped: 'Recepción detenida.',
  'too-many-attempts': 'Se cerró la sesión por demasiados intentos fallidos. Genera otro código.',
  inactive: 'Se cerró la sesión por inactividad.',
} as const;

export function App() {
  const [view, setView] = useState<View>({ kind: 'idle' });
  const [packages, setPackages] = useState<ReceivedPackage[]>([]);
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<'recibir' | 'portal'>('recibir');

  useEffect(() => {
    const off = window.fodibo.onEvent((e) => {
      if (e.type === 'paired') setView({ kind: 'paired', deviceName: e.deviceName });
      else if (e.type === 'closed') setView({ kind: 'idle', notice: CLOSED_NOTICE[e.reason] });
      else if (e.type === 'error') setError(e.message);
      else {
        // Un paquete que llega tras `closed` también se muestra: el recibo ya está en disco.
        setPackages((prev) =>
          prev.some((p) => p.receipt.package_id === e.pkg.receipt.package_id) ? prev : [e.pkg, ...prev],
        );
      }
    });
    window.fodibo
      .listReceived()
      .then((list) =>
        setPackages((prev) => [...prev, ...list.filter((p) => !prev.some((q) => q.receipt.package_id === p.receipt.package_id))]),
      )
      .catch((err: unknown) => setError(cleanIpcError(err)));
    return off;
  }, []);

  const start = useCallback(async () => {
    setError(undefined);
    setView({ kind: 'starting' });
    try {
      const { qrDataUrl, expiresAt } = await window.fodibo.startReceiving();
      setView({ kind: 'waiting', qrDataUrl, expiresAt });
    } catch (err) {
      setView({ kind: 'idle', notice: cleanIpcError(err) });
    }
  }, []);

  const stop = useCallback(async () => {
    try {
      await window.fodibo.stopReceiving();
    } catch (err) {
      setError(cleanIpcError(err));
    }
    setView({ kind: 'idle' });
  }, []);

  const open = useCallback((id: string) => {
    window.fodibo.openPackage(id).catch((err: unknown) => setError(cleanIpcError(err)));
  }, []);

  return (
    <main>
      <h1>FODIBO</h1>
      <nav className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'recibir'} onClick={() => setTab('recibir')}>
          Recibir del móvil
        </button>
        <button type="button" role="tab" aria-selected={tab === 'portal'} onClick={() => setTab('portal')}>
          Prueba de portal
        </button>
      </nav>
      <AgentPanel visible={tab === 'portal'} />
      <div hidden={tab !== 'recibir'}>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {view.kind === 'idle' && (
        <div className="panel">
          {view.notice && <p>{view.notice}</p>}
          <button type="button" onClick={() => void start()}>
            Recibir del móvil
          </button>
        </div>
      )}
      {view.kind === 'starting' && <p>Iniciando…</p>}
      {view.kind === 'waiting' && (
        <QrPanel qrDataUrl={view.qrDataUrl} expiresAt={view.expiresAt} onStop={() => void stop()} onRegenerate={() => void start()} />
      )}
      {view.kind === 'paired' && (
        <div className="panel">
          <p>
            Conectado con <em>{view.deviceName}</em>
          </p>
          <button type="button" onClick={() => void stop()}>
            Detener
          </button>
        </div>
      )}
      <h2>Paquetes recibidos</h2>
      <PackageList packages={packages} onOpen={open} />
      </div>
    </main>
  );
}
