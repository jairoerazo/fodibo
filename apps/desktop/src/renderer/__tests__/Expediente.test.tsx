// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReceivedPackage } from '../../core/transfer/index.js';
import type { CaseView, ConceptView, ExpedienteApi, Result } from '../../shared/expediente-ipc.js';
import { PackageCard } from '../components/PackageCard.js';
import { ExpedienteTab } from '../components/expediente/ExpedienteTab.js';

vi.mock('../components/expediente/DocumentViewer.js', () => ({
  DocumentViewer: ({ document, page }: { document: { documentId: string; mime: string }; page?: number }) => (
    <span>{`visor:${document.documentId}:${document.mime}:${page ?? '-'}`}</span>
  ),
}));

const CASE = '3f2b8c1e-5a4d-4e6f-9a1b-2c3d4e5f6a7b';
const DOC1 = '11111111-1111-4111-8111-111111111111';
const DOC2 = '22222222-2222-4222-8222-222222222222';
const PKG = '99999999-9999-4999-8999-999999999999';

const ok = <T,>(value: T): Result<T> => ({ ok: true, value });
const fail = (code: string, message: string, details?: unknown): Result<never> => ({ ok: false, error: { code, message, details } });

const doc = (id: string, name: string, over: Partial<CaseView['documents'][number]> = {}): CaseView['documents'][number] => ({
  documentId: id,
  sha256: 'a'.repeat(64),
  mime: 'application/pdf',
  size: 1000,
  originalName: name,
  docType: 'lohnausweis',
  status: 'confirmado',
  sourceDevice: 'Pixel 8',
  importedAt: '2026-11-10T15:30:00.000Z',
  available: true,
  ...over,
});

const field = (over: Partial<CaseView['fields'][number]> = {}): CaseView['fields'][number] => ({
  fieldId: 'f1',
  conceptId: 'bruttolohn_jahr',
  variant: '',
  key: 'bruttolohn_jahr',
  tipo: 'amount',
  valor: '85400.00',
  moneda: 'CHF',
  origin: 'usuario',
  status: 'confirmado',
  updatedAt: '2026-11-10T15:30:00.000Z',
  evidence: [{ documentId: DOC1, page: 1 }],
  ...over,
});

const view = (over: Partial<CaseView> = {}): CaseView => ({
  caseId: CASE,
  taxYear: 2025,
  jurisdiction: 'ZH',
  revision: 3,
  createdAt: '2026-11-01T10:00:00.000Z',
  persons: [{ personId: 'p1', role: 'hauptperson', ordinal: 0, slug: 'hauptperson', label: 'Anna Muster' }],
  documents: [doc(DOC1, 'lohn.pdf')],
  fields: [field()],
  status: 'revisable',
  blockers: [],
  warnings: [],
  ...over,
});

const concepts: ConceptView[] = [
  { id: 'bruttolohn_jahr', tipo: 'amount', labels: ['Bruttolohn'], variants: false },
  { id: 'krankenkasse_praemie', tipo: 'amount', labels: ['Krankenkassenprämie'], variants: true },
  { id: 'zivilstand', tipo: 'enum', labels: ['Zivilstand'], variants: false, values: ['ledig', 'verheiratet'] },
];

let api: { [K in keyof ExpedienteApi]: ReturnType<typeof vi.fn> };

function setup(over: Partial<{ [K in keyof ExpedienteApi]: ReturnType<typeof vi.fn> }> = {}) {
  api = {
    listCases: vi.fn(async () => ok([{ caseId: CASE, taxYear: 2025, jurisdiction: 'ZH', revision: 3, createdAt: '', hauptpersonLabel: 'Anna Muster' }])),
    createCase: vi.fn(async () => ok(view())),
    updateCase: vi.fn(async () => ok(view())),
    getCase: vi.fn(async () => ok(view())),
    listConcepts: vi.fn(async () => ok(concepts)),
    listImportable: vi.fn(async () => ok([])),
    importPackage: vi.fn(async () => ok({ status: 'imported', documents: [] })),
    setDocument: vi.fn(async () => ok(view())),
    saveField: vi.fn(async () => ok(view())),
    deleteField: vi.fn(async () => ok(view())),
    fieldHistory: vi.fn(async () => ok([])),
    approve: vi.fn(async () => ok({ approvalId: 'x', caseRevision: 3, approvedAt: '2026-11-12T10:00:00.000Z', contentHash: 'abcdef012345678' })),
    showDocumentInFolder: vi.fn(async () => ok(undefined)),
    onEvent: vi.fn(() => () => {}),
    ...over,
  };
  (window as unknown as { fodiboExpediente: unknown }).fodiboExpediente = api;
}

function Harness({
  initial,
  initialDoc,
  spy,
  pendingImport,
  visible,
  receivedCount,
}: {
  initial?: string;
  initialDoc?: string;
  spy?: (id: string | undefined) => void;
  pendingImport?: { packageId: string; seq: number };
  visible?: boolean;
  receivedCount?: number;
}) {
  const [id, setId] = useState<string | undefined>(initial);
  const [docId, setDocId] = useState<string | undefined>(initialDoc);
  return (
    <ExpedienteTab
      caseId={id}
      onSelectCase={(c) => {
        spy?.(c);
        setId(c);
      }}
      selectedDocumentId={docId}
      onSelectDocument={setDocId}
      pendingImport={pendingImport}
      visible={visible}
      receivedCount={receivedCount}
    />
  );
}

const CASE2 = '4a2b8c1e-5a4d-4e6f-9a1b-2c3d4e5f6a7c';
const summary = (caseId: string) => ({ caseId, taxYear: 2025, jurisdiction: 'ZH', revision: 1, createdAt: '', hauptpersonLabel: 'X' });
const approvedView = (over: Partial<CaseView> = {}) =>
  view({ status: 'aprobado', lastApproval: { approvalId: 'x', caseRevision: 3, approvedAt: '2026-11-12T10:00:00.000Z', contentHash: 'abcdef0123456789' }, ...over });

beforeEach(() => {
  localStorage.clear();
  setup();
});
afterEach(cleanup);

describe('Expediente', () => {
  it('crea un expediente con titular y lo selecciona', async () => {
    setup({ listCases: vi.fn(async () => ok([])) });
    const selected: Array<string | undefined> = [];
    render(<Harness spy={(c) => selected.push(c)} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Nuevo expediente' }));
    fireEvent.change(screen.getByLabelText('Año fiscal'), { target: { value: '2025' } });
    fireEvent.change(screen.getByLabelText('Cantón'), { target: { value: 'ZH' } });
    fireEvent.change(screen.getByLabelText('Titular'), { target: { value: 'Anna Muster' } });
    fireEvent.click(screen.getByRole('button', { name: 'Crear expediente' }));
    await waitFor(() => expect(selected).toEqual([CASE]));
    expect(api.createCase).toHaveBeenCalledWith({ taxYear: 2025, jurisdiction: 'ZH', persons: [{ role: 'hauptperson', label: 'Anna Muster' }] });
  });

  it('añadir campo con importe mal formado muestra el error del núcleo junto al control y no cierra el formulario', async () => {
    setup({ saveField: vi.fn(async () => fail('invalid_input', 'El importe no es válido.', { field: 'valor' })) });
    render(<Harness initial={CASE} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Añadir campo' }));
    fireEvent.change(screen.getByLabelText('Concepto'), { target: { value: 'bruttolohn_jahr — Bruttolohn' } });
    const valor = screen.getByLabelText('Valor');
    fireEvent.change(valor, { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar campo' }));
    const msg = await screen.findByText('El importe no es válido.');
    expect(valor.getAttribute('aria-describedby')).toBe(msg.id);
    expect(valor.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('button', { name: 'Guardar campo' })).toBeTruthy();
    expect(api.saveField).toHaveBeenCalledWith(CASE, expect.objectContaining({ conceptId: 'bruttolohn_jahr', variant: '', valor: 'abc', moneda: 'CHF' }));
  });

  it('el diálogo de aprobación lista clave, valor y evidencias; con avisos exige la casilla', async () => {
    setup({
      getCase: vi.fn(async () =>
        ok(
          view({
            fields: [field(), field({ fieldId: 'f2', conceptId: 'zivilstand', key: 'zivilstand', tipo: 'enum', valor: 'ledig', moneda: null, evidence: [] })],
            warnings: [{ code: 'sin_evidencia', fieldId: 'f2' }],
          }),
        ),
      ),
    });
    render(<Harness initial={CASE} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Aprobar' }));
    const dialog = await screen.findByRole('dialog', { name: 'Aprobar expediente' });
    expect(within(dialog).getByText('bruttolohn_jahr')).toBeTruthy();
    expect(within(dialog).getByText('85400.00 CHF')).toBeTruthy();
    expect(within(dialog).getByText(/lohn\.pdf/)).toBeTruthy();
    expect(within(dialog).getByText('ledig')).toBeTruthy();
    const confirm = within(dialog).getByRole('button', { name: 'Aprobar' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('checkbox'));
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(api.approve).toHaveBeenCalledWith(CASE, 3));
    // approve no emite case-changed: la vista se refresca sola.
    await waitFor(() => expect(api.getCase.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('con bloqueos el botón de aprobar está deshabilitado y se lista el motivo', async () => {
    setup({
      getCase: vi.fn(async () => ok(view({ status: 'incompleto', blockers: [{ code: 'documento_pendiente', entity: 'document', id: DOC1 }] }))),
    });
    render(<Harness initial={CASE} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Aprobar' }));
    const dialog = await screen.findByRole('dialog', { name: 'Aprobar expediente' });
    expect((within(dialog).getByRole('button', { name: 'Aprobar' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByText(/documento sin revisar/i)).toBeTruthy();
  });

  it('editar un expediente aprobado avisa de que anula la aprobación antes de enviar el primer cambio', async () => {
    setup({
      getCase: vi.fn(async () =>
        ok(view({ status: 'aprobado', lastApproval: { approvalId: 'x', caseRevision: 3, approvedAt: '2026-11-12T10:00:00.000Z', contentHash: 'abcdef0123456789' } })),
      ),
    });
    render(<Harness initial={CASE} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reabrir' }));
    const alert = await screen.findByRole('alertdialog');
    expect(alert.textContent).toMatch(/anula la aprobación/);
    expect(api.setDocument).not.toHaveBeenCalled();
    fireEvent.click(within(alert).getByRole('button', { name: 'Continuar' }));
    await waitFor(() => expect(api.setDocument).toHaveBeenCalledWith(DOC1, { status: 'pendiente_de_revision' }));
  });

  it('un expediente recordado que ya no existe deja sin expediente seleccionado y sin errores', async () => {
    const selected: Array<string | undefined> = [];
    render(<Harness initial="00000000-0000-4000-8000-000000000000" spy={(c) => selected.push(c)} />);
    await waitFor(() => expect(selected).toEqual([undefined]));
    expect(api.getCase).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('importar desde paquetes sin importar refresca documentos y revisión', async () => {
    const pkg = { packageId: PKG, deviceName: 'Pixel 8', receivedAt: '2026-11-10T15:30:00.000Z', fileCount: 2 };
    let imported = false;
    setup({
      listImportable: vi.fn(async () => ok(imported ? [] : [pkg])),
      getCase: vi.fn(async () => ok(imported ? view({ revision: 4, documents: [doc(DOC1, 'lohn.pdf'), doc(DOC2, 'bank.pdf', { status: 'pendiente_de_revision' })] }) : view())),
      importPackage: vi.fn(async () => {
        imported = true;
        return ok({ status: 'imported', documents: [] });
      }),
    });
    render(<Harness initial={CASE} />);
    expect(await screen.findByText('Revisión 3')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: /Importar paquete de Pixel 8/ }));
    await waitFor(() => expect(api.importPackage).toHaveBeenCalledWith(CASE, PKG));
    expect(await screen.findByText('Revisión 4')).toBeTruthy();
    expect(screen.getByText('bank.pdf')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: /Importar paquete/ })).toBeNull());
  });

  it('una importación pedida desde otra pestaña sobre un expediente aprobado avisa antes y Cancelar no importa', async () => {
    const approved = view({ status: 'aprobado', lastApproval: { approvalId: 'x', caseRevision: 3, approvedAt: '2026-11-12T10:00:00.000Z', contentHash: 'abcdef0123456789' } });
    setup({ getCase: vi.fn(async () => ok(approved)) });
    const { rerender } = render(<Harness initial={CASE} />);
    await screen.findByText('Revisión 3');
    rerender(<Harness initial={CASE} pendingImport={{ packageId: PKG, seq: 1 }} />);
    const alert = await screen.findByRole('alertdialog');
    expect(alert.textContent).toMatch(/anula la aprobación/);
    fireEvent.click(within(alert).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(api.importPackage).not.toHaveBeenCalled();
    rerender(<Harness initial={CASE} pendingImport={{ packageId: PKG, seq: 2 }} />);
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Continuar' }));
    await waitFor(() => expect(api.importPackage).toHaveBeenCalledWith(CASE, PKG));
  });

  it('si listCases falla no se olvida el expediente recordado y se muestra el error', async () => {
    setup({ listCases: vi.fn(async () => fail('storage_error', 'No se pudo leer la lista.')) });
    const selected: Array<string | undefined> = [];
    render(<Harness initial={CASE} spy={(c) => selected.push(c)} />);
    expect((await screen.findByRole('alert')).textContent).toContain('No se pudo leer la lista.');
    await waitFor(() => expect(api.getCase).toHaveBeenCalledWith(CASE));
    expect(selected).toEqual([]);
  });

  it('una respuesta tardía del expediente anterior no pisa la vista del nuevo', async () => {
    let releaseOld: (r: Result<CaseView>) => void = () => {};
    setup({
      listCases: vi.fn(async () => ok([summary(CASE), summary(CASE2)])),
      getCase: vi.fn((id: string) => (id === CASE ? new Promise<Result<CaseView>>((res) => (releaseOld = res)) : Promise.resolve(ok(view({ caseId: CASE2, revision: 7 }))))),
    });
    render(<Harness initial={CASE} />);
    await waitFor(() => expect(api.getCase).toHaveBeenCalledWith(CASE));
    fireEvent.change(screen.getByLabelText('Expediente'), { target: { value: CASE2 } });
    expect(await screen.findByText('Revisión 7')).toBeTruthy();
    releaseOld(ok(view({ revision: 3 })));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText('Revisión 7')).toBeTruthy();
    expect(screen.queryByText('Revisión 3')).toBeNull();
  });

  it('cambiar de expediente con el aviso de anulación abierto no escribe nada y muestra el nuevo', async () => {
    setup({
      listCases: vi.fn(async () => ok([summary(CASE), summary(CASE2)])),
      getCase: vi.fn(async (id: string) => ok(id === CASE ? approvedView() : view({ caseId: CASE2, revision: 7 }))),
    });
    render(<Harness initial={CASE} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reabrir' }));
    const alert = await screen.findByRole('alertdialog');
    // Mientras el aviso está abierto, el resto de la pestaña es inerte (no alcanzable con el teclado).
    expect(screen.getByLabelText('Expediente').closest('[inert]')).not.toBeNull();
    expect(alert.closest('[inert]')).toBeNull();
    // Si aun así se cambia de expediente, el aviso se cancela.
    fireEvent.change(screen.getByLabelText('Expediente'), { target: { value: CASE2 } });
    expect(await screen.findByText('Revisión 7')).toBeTruthy();
    const stale = screen.queryByRole('alertdialog');
    if (stale) fireEvent.click(within(stale).getByRole('button', { name: 'Continuar' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(api.setDocument).not.toHaveBeenCalled();
    expect(api.saveField).not.toHaveBeenCalled();
    expect(api.approve).not.toHaveBeenCalled();
    expect(screen.getByText('Revisión 7')).toBeTruthy();
    expect(screen.getByLabelText('Expediente').closest('[inert]')).toBeNull();
  });

  it('un segundo aviso cancela el primero: solo se ejecuta la última acción confirmada', async () => {
    setup({ getCase: vi.fn(async () => ok(approvedView())) });
    const { rerender } = render(<Harness initial={CASE} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reabrir' }));
    await screen.findByRole('alertdialog');
    rerender(<Harness initial={CASE} pendingImport={{ packageId: PKG, seq: 1 }} />);
    await waitFor(() => expect(screen.getAllByRole('alertdialog')).toHaveLength(1));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Continuar' }));
    await waitFor(() => expect(api.importPackage).toHaveBeenCalledWith(CASE, PKG));
    expect(api.setDocument).not.toHaveBeenCalled();
  });

  it('con la vista aún cargando, una importación sobre un expediente aprobado consulta el estado y avisa', async () => {
    let first = true;
    let releaseFirst: (r: Result<CaseView>) => void = () => {};
    setup({
      getCase: vi.fn(() => {
        if (!first) return Promise.resolve(ok(approvedView()));
        first = false;
        return new Promise<Result<CaseView>>((res) => (releaseFirst = res));
      }),
    });
    const { rerender } = render(<Harness initial={CASE} />);
    await waitFor(() => expect(api.getCase).toHaveBeenCalledTimes(1));
    rerender(<Harness initial={CASE} pendingImport={{ packageId: PKG, seq: 1 }} />);
    expect((await screen.findByRole('alertdialog')).textContent).toMatch(/anula la aprobación/);
    expect(api.importPackage).not.toHaveBeenCalled();
    releaseFirst(ok(approvedView()));
  });

  it('una respuesta de escritura con la vista de otro expediente no se aplica', async () => {
    setup({ setDocument: vi.fn(async () => ok(view({ caseId: CASE2, revision: 9 }))) });
    render(<Harness initial={CASE} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reabrir' }));
    await waitFor(() => expect(api.setDocument).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Revisión 9')).toBeNull();
    expect(screen.getByText('Revisión 3')).toBeTruthy();
  });

  it('«Paquetes sin importar» se recarga al mostrarse la pestaña y al llegar un paquete', async () => {
    const pkg = { packageId: PKG, deviceName: 'Pixel 8', receivedAt: '2026-11-10T15:30:00.000Z', fileCount: 2 };
    let list: (typeof pkg)[] = [];
    setup({ listImportable: vi.fn(async () => ok(list)) });
    const { rerender } = render(<Harness initial={CASE} visible={false} receivedCount={0} />);
    await screen.findByText('Revisión 3');
    expect(api.listImportable).not.toHaveBeenCalled();
    rerender(<Harness initial={CASE} visible receivedCount={0} />);
    await waitFor(() => expect(api.listImportable).toHaveBeenCalledTimes(1));
    expect(screen.getByText('No hay paquetes pendientes.')).toBeTruthy();
    list = [pkg];
    rerender(<Harness initial={CASE} visible receivedCount={1} />);
    expect(await screen.findByRole('button', { name: /Importar paquete de Pixel 8/ })).toBeTruthy();
    expect(api.listImportable).toHaveBeenCalledTimes(2);
  });

  it('un storage_error muestra la ruta de la última copia de seguridad', async () => {
    const backup = '/datos/expediente/backups/2026-11-11.db';
    setup({ listCases: vi.fn(async () => fail('storage_error', 'No se pudo abrir el expediente.', { backup })) });
    render(<Harness initial={CASE} />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('No se pudo abrir el expediente.');
    expect(alert.textContent).toContain(backup);
  });

  it('pulsar una evidencia selecciona su documento y su página', async () => {
    render(<Harness initial={CASE} />);
    fireEvent.click(await screen.findByRole('button', { name: 'lohn.pdf, página 1' }));
    const viewer = await screen.findByTestId('viewer-slot');
    expect(viewer.textContent).toContain('lohn.pdf');
    expect(viewer.textContent).toContain(`visor:${DOC1}:application/pdf:1`);
  });
});

describe('PackageCard: importar al expediente', () => {
  const pkg = {
    deviceName: 'Pixel 8',
    receipt: { schema_version: 1, package_id: PKG, received_at: '2026-11-10T15:30:00.000Z', files: [] },
  } as unknown as ReceivedPackage;

  it('importa el paquete cuando hay expediente activo', () => {
    const imported: string[] = [];
    render(<PackageCard pkg={pkg} onOpen={() => {}} onImport={(id) => imported.push(id)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Importar al expediente' }));
    expect(imported).toEqual([PKG]);
  });

  it('se deshabilita con una pista cuando no hay expediente activo', () => {
    render(<PackageCard pkg={pkg} onOpen={() => {}} onImport={() => {}} importHint="Selecciona un expediente en la pestaña Expediente." />);
    const btn = screen.getByRole('button', { name: 'Importar al expediente' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText('Selecciona un expediente en la pestaña Expediente.').id).toBe(btn.getAttribute('aria-describedby'));
  });
});
