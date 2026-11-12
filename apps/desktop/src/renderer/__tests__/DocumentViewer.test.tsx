// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentViewer } from '../components/expediente/DocumentViewer.js';

const pdf = vi.hoisted(() => ({
  getDocument: vi.fn(),
  getPage: vi.fn(),
  render: vi.fn(),
  GlobalWorkerOptions: {} as { workerSrc?: string },
}));
vi.mock('pdfjs-dist', () => ({ getDocument: pdf.getDocument, GlobalWorkerOptions: pdf.GlobalWorkerOptions }));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '/assets/pdf.worker.min.mjs' }));

const ID = '11111111-1111-4111-8111-111111111111';
const showDocumentInFolder = vi.fn(async () => ({ ok: true, value: undefined }));

beforeEach(() => {
  pdf.getPage.mockImplementation(async () => ({
    getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 140 * scale }),
    render: pdf.render.mockReturnValue({ promise: Promise.resolve() }),
  }));
  pdf.getDocument.mockImplementation(() => ({ promise: Promise.resolve({ numPages: 3, getPage: pdf.getPage, destroy: vi.fn() }) }));
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([37, 80, 68, 70]))));
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({})) as never;
  (window as unknown as { fodiboExpediente: unknown }).fodiboExpediente = { showDocumentInFolder };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('DocumentViewer', () => {
  it('PDF: abre en la página de la evidencia, navega y no pasa de la última', async () => {
    render(<DocumentViewer document={{ documentId: ID, mime: 'application/pdf' }} page={2} />);
    await screen.findByText('Página 2 de 3');
    expect(fetch).toHaveBeenCalledWith(`fodibo-doc://doc/${ID}`);
    const opts = pdf.getDocument.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts).toMatchObject({ disableFontFace: true });
    expect(opts.data).toBeInstanceOf(Uint8Array);
    expect(opts).not.toHaveProperty('standardFontDataUrl');
    expect(pdf.GlobalWorkerOptions.workerSrc).toBe('/assets/pdf.worker.min.mjs');
    const next = screen.getByRole('button', { name: 'Siguiente' });
    fireEvent.click(next);
    await screen.findByText('Página 3 de 3');
    expect((next as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Anterior' }));
    await screen.findByText('Página 2 de 3');
    await waitFor(() => expect(pdf.getPage).toHaveBeenLastCalledWith(2));
  });

  it('PDF: el zoom va de 50 % a 300 %', async () => {
    render(<DocumentViewer document={{ documentId: ID, mime: 'application/pdf' }} />);
    await screen.findByText('Página 1 de 3');
    for (let i = 0; i < 20; i++) fireEvent.click(screen.getByRole('button', { name: 'Alejar' }));
    expect(screen.getByText('50 %')).toBeTruthy();
    for (let i = 0; i < 40; i++) fireEvent.click(screen.getByRole('button', { name: 'Acercar' }));
    expect(screen.getByText('300 %')).toBeTruthy();
  });

  it('imagen: <img> con la URL fodibo-doc', () => {
    render(<DocumentViewer document={{ documentId: ID, mime: 'image/jpeg' }} />);
    expect(screen.getByRole('img').getAttribute('src')).toBe(`fodibo-doc://doc/${ID}`);
  });

  it('HEIC: aviso y botón «Mostrar en la carpeta»', () => {
    render(<DocumentViewer document={{ documentId: ID, mime: 'image/heic' }} />);
    expect(screen.getByText(/no se puede mostrar/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar en la carpeta' }));
    expect(showDocumentInFolder).toHaveBeenCalledWith(ID);
  });

  it('JSON: <pre> truncado a 262 144 bytes con indicación', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('a'.repeat(300_000))));
    const { container } = render(<DocumentViewer document={{ documentId: ID, mime: 'application/json' }} />);
    await screen.findByText(/truncado/i);
    expect(container.querySelector('pre')!.textContent).toHaveLength(262_144);
  });

  it('JSON corto: sin indicación de truncado', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"a":1}')));
    const { container } = render(<DocumentViewer document={{ documentId: ID, mime: 'application/json' }} />);
    await waitFor(() => expect(container.querySelector('pre')?.textContent).toBe('{"a":1}'));
    expect(screen.queryByText(/truncado/i)).toBeNull();
  });
});
