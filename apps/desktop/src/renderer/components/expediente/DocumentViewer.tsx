import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

const MAX_TEXT_BYTES = 262_144;
const ZOOM_MIN = 50;
const ZOOM_MAX = 300;
const ZOOM_STEP = 25;
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const docUrl = (id: string): string => `fodibo-doc://doc/${id}`;

function ZoomControl({ zoom, onZoom }: { zoom: number; onZoom: (z: number) => void }) {
  const clamp = (z: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  return (
    <span className="viewer-zoom">
      <button type="button" aria-label="Alejar" disabled={zoom <= ZOOM_MIN} onClick={() => onZoom(clamp(zoom - ZOOM_STEP))}>
        −
      </button>
      <span>{zoom} %</span>
      <button type="button" aria-label="Acercar" disabled={zoom >= ZOOM_MAX} onClick={() => onZoom(clamp(zoom + ZOOM_STEP))}>
        +
      </button>
    </span>
  );
}

function PdfView({ documentId, page }: { documentId: string; page?: number | undefined }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  const [current, setCurrent] = useState(Math.max(1, page ?? 1));
  const [zoom, setZoom] = useState(100);
  const [error, setError] = useState<string>();
  const canvas = useRef<HTMLCanvasElement>(null);

  // La evidencia puede cambiar de página sin cambiar de documento.
  useEffect(() => setCurrent(Math.max(1, page ?? 1)), [page]);

  // Se descarga el PDF entero y se entrega a PDF.js como bytes: sin peticiones de rango desde el worker.
  useEffect(() => {
    let cancelled = false;
    let loaded: PDFDocumentProxy | undefined;
    setPdf(undefined);
    setError(undefined);
    void (async () => {
      try {
        const res = await fetch(docUrl(documentId));
        if (!res.ok) throw new Error(String(res.status));
        const data = new Uint8Array(await res.arrayBuffer());
        // Carga diferida: PDF.js necesita APIs del navegador (DOMMatrix) y solo se usa con PDF.
        // Sin `isEvalSupported`: pdfjs-dist 5.7 ya no evalúa código; sin fuentes ni CMaps remotos.
        const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist');
        GlobalWorkerOptions.workerSrc = workerUrl;
        const doc = await getDocument({ data, disableFontFace: true }).promise;
        if (cancelled) return void doc.destroy();
        loaded = doc;
        setPdf(doc);
      } catch {
        if (!cancelled) setError('No se pudo abrir el PDF.');
      }
    })();
    return () => {
      cancelled = true;
      void loaded?.destroy();
    };
  }, [documentId]);

  const last = pdf?.numPages ?? 1;
  const shown = Math.min(current, last);

  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    void (async () => {
      try {
        const p = await pdf.getPage(shown);
        const el = canvas.current;
        const ctx = el?.getContext('2d');
        if (cancelled || !el || !ctx) return;
        const viewport = p.getViewport({ scale: zoom / 100 });
        el.width = viewport.width;
        el.height = viewport.height;
        await p.render({ canvasContext: ctx, viewport } as never).promise;
      } catch {
        if (!cancelled) setError('No se pudo dibujar la página.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pdf, shown, zoom]);

  if (error) return <p className="error">{error}</p>;
  if (!pdf) return <p className="meta">Cargando…</p>;
  return (
    <div className="viewer">
      <div className="viewer-bar">
        <button type="button" disabled={shown <= 1} onClick={() => setCurrent(shown - 1)}>
          Anterior
        </button>
        <span>{`Página ${shown} de ${last}`}</span>
        <button type="button" disabled={shown >= last} onClick={() => setCurrent(shown + 1)}>
          Siguiente
        </button>
        <ZoomControl zoom={zoom} onZoom={setZoom} />
      </div>
      <canvas ref={canvas} />
    </div>
  );
}

function ImageView({ documentId }: { documentId: string }) {
  const [zoom, setZoom] = useState(100);
  return (
    <div className="viewer">
      <div className="viewer-bar">
        <ZoomControl zoom={zoom} onZoom={setZoom} />
      </div>
      <img src={docUrl(documentId)} alt="Documento" style={{ width: `${zoom}%`, maxWidth: 'none' }} />
    </div>
  );
}

function JsonView({ documentId }: { documentId: string }) {
  const [text, setText] = useState<{ body: string; truncated: boolean }>();
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setText(undefined);
    setError(false);
    void (async () => {
      try {
        const res = await fetch(docUrl(documentId));
        if (!res.ok) throw new Error(String(res.status));
        const bytes = new Uint8Array(await res.arrayBuffer());
        const body = new TextDecoder().decode(bytes.subarray(0, MAX_TEXT_BYTES));
        if (!cancelled) setText({ body, truncated: bytes.length > MAX_TEXT_BYTES });
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [documentId]);
  if (error) return <p className="error">No se pudo leer el documento.</p>;
  if (!text) return <p className="meta">Cargando…</p>;
  return (
    <div className="viewer">
      {text.truncated && <p className="meta">Contenido truncado a 256 KiB.</p>}
      <pre>{text.body}</pre>
    </div>
  );
}

/** Visor mínimo y local del original: PDF (PDF.js), imagen, JSON. HEIC y otros tipos se abren en la carpeta. */
export function DocumentViewer({ document, page }: { document: { documentId: string; mime: string }; page?: number | undefined }) {
  const { documentId, mime } = document;
  if (mime === 'application/pdf') return <PdfView documentId={documentId} page={page} />;
  if (IMAGE_MIMES.has(mime)) return <ImageView documentId={documentId} />;
  if (mime === 'application/json') return <JsonView documentId={documentId} />;
  return (
    <div className="viewer">
      <p className="meta">{mime === 'image/heic' || mime === 'image/heif' ? 'Este formato (HEIC) no se puede mostrar aquí.' : 'Este formato no se puede mostrar aquí.'}</p>
      <button type="button" onClick={() => void window.fodiboExpediente.showDocumentInFolder(documentId)}>
        Mostrar en la carpeta
      </button>
    </div>
  );
}
