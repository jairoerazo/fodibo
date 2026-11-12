import { useCallback, useEffect, useState } from 'react';
import type { ReceivedPackage } from '../core/transfer/index.js';
import { AgentPanel } from './components/AgentPanel.js';
import { ExpedienteTab } from './components/expediente/ExpedienteTab.js';
import { PackageList } from './components/PackageList.js';
import { QrPanel } from './components/QrPanel.js';
import type { ImportResult, Result } from '../shared/expediente-ipc.js';
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

const CASE_KEY = 'fodibo.activeCaseId';

function readStoredCase(): string | undefined {
  try {
    return localStorage.getItem(CASE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function App() {
  const [view, setView] = useState<View>({ kind: 'idle' });
  const [packages, setPackages] = useState<ReceivedPackage[]>([]);
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<'recibir' | 'expediente' | 'portal'>('recibir');
  const [activeCaseId, setActiveCaseId] = useState<string | undefined>(readStoredCase);
  const [selectedDocumentId, setSelectedDocumentId] = useState<string>();
  const [pendingImport, setPendingImport] = useState<{ packageId: string; seq: number }>();
  const [notice, setNotice] = useState<string>();
  // Cuenta los paquetes llegados: la pestaña Expediente recarga con ello sus «Paquetes sin importar».
  const [receivedCount, setReceivedCount] = useState(0);

  const selectCase = useCallback((id: string | undefined) => {
    setActiveCaseId(id);
    setSelectedDocumentId(undefined);
    try {
      if (id) localStorage.setItem(CASE_KEY, id);
      else localStorage.removeItem(CASE_KEY);
    } catch {
      // Sin almacenamiento disponible: el expediente activo simplemente no se recuerda.
    }
  }, []);

  useEffect(() => {
    const off = window.fodibo.onEvent((e) => {
      if (e.type === 'paired') setView({ kind: 'paired', deviceName: e.deviceName });
      else if (e.type === 'closed') setView({ kind: 'idle', notice: CLOSED_NOTICE[e.reason] });
      else if (e.type === 'error') setError(e.message);
      else {
        // Un paquete que llega tras `closed` también se muestra: el recibo ya está en disco.
        setReceivedCount((n) => n + 1);
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

  // La importación la ejecuta ExpedienteTab (así pasa por la guarda de «anula la aprobación»); se muestra esa pestaña para que el aviso sea visible.
  const importToCase = useCallback((packageId: string) => {
    setNotice(undefined);
    setError(undefined);
    setPendingImport((p) => ({ packageId, seq: (p?.seq ?? 0) + 1 }));
    setTab('expediente');
  }, []);
  const onImportResult = useCallback((r: Result<ImportResult>) => {
    if (!r.ok) return setError(r.error.message);
    const fresh = r.value.documents.filter((d) => d.outcome === 'nuevo').length;
    setNotice(r.value.status === 'already_imported' ? 'Este paquete ya estaba importado.' : `Paquete importado: ${fresh} documento(s) nuevo(s).`);
  }, []);

  return (
    <main className={tab === 'recibir' ? undefined : 'wide'}>
      <h1>FODIBO</h1>
      <nav className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'recibir'} onClick={() => setTab('recibir')}>
          Recibir del móvil
        </button>
        <button type="button" role="tab" aria-selected={tab === 'expediente'} onClick={() => setTab('expediente')}>
          Expediente
        </button>
        <button type="button" role="tab" aria-selected={tab === 'portal'} onClick={() => setTab('portal')}>
          Prueba de portal
        </button>
      </nav>
      <div hidden={tab !== 'expediente'} className="tab-body">
        <ExpedienteTab
          caseId={activeCaseId}
          onSelectCase={selectCase}
          selectedDocumentId={selectedDocumentId}
          onSelectDocument={setSelectedDocumentId}
          pendingImport={pendingImport}
          onImportResult={onImportResult}
          visible={tab === 'expediente'}
          receivedCount={receivedCount}
        />
      </div>
      <AgentPanel visible={tab === 'portal'} caseId={activeCaseId} />
      <div hidden={tab !== 'recibir'} className="tab-body">
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
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
      <PackageList
        packages={packages}
        onOpen={open}
        onImport={importToCase}
        importHint={activeCaseId ? undefined : 'Selecciona o crea un expediente en la pestaña Expediente.'}
      />
      </div>
    </main>
  );
}
