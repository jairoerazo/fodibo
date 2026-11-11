// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentApi, AgentUiEvent } from '../../shared/agent-ipc.js';
import { AgentPanel } from '../components/AgentPanel.js';

let emit: (e: AgentUiEvent) => void;
let api: AgentApi;

beforeEach(() => {
  class RO {
    observe() {}
    disconnect() {}
    unobserve() {}
  }
  vi.stubGlobal('ResizeObserver', RO);
  api = {
    openPortal: vi.fn(async () => {}),
    closePortal: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    setBounds: vi.fn(),
    setVisible: vi.fn(),
    onEvent: (cb) => {
      emit = (e) => act(() => cb(e));
      return () => {};
    },
  };
  (window as unknown as { fodiboAgent: AgentApi }).fodiboAgent = api;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const pend = (step: number, stepTitle: string, label: string, reason: string, candidates: { key: string; valor: string }[] = []) => ({
  step,
  stepTitle,
  field_id: label,
  label,
  required: true,
  outcome: { kind: 'pending' as const, reason, candidates },
});

describe('AgentPanel', () => {
  it('muestra pendientes agrupados por paso con motivo y candidatos', () => {
    render(<AgentPanel visible />);
    const pending = [
      pend(2, 'Ingresos', 'Salario', 'ambiguo', [
        { key: 'salario_bruto', valor: '85400.00' },
        { key: 'salario_neto', valor: '74210.00' },
      ]),
      pend(2, 'Ingresos', 'Bonus', 'sin_dato'),
      pend(4, 'Banco', 'IBAN', 'no_verificado'),
    ];
    emit({ type: 'finished', results: pending, pending, blockedSubmits: 0 } as never);
    expect(screen.getByText('Ingresos')).toBeTruthy();
    expect(screen.getAllByText(/Paso \d/)).toHaveLength(2);
    expect(screen.getByText(/Varios candidatos/)).toBeTruthy();
    expect(screen.getByText(/salario_bruto: 85400\.00/)).toBeTruthy();
    expect(screen.getByText(/No hay dato en la declaración/)).toBeTruthy();
    expect(screen.getByText(/No se pudo verificar/)).toBeTruthy();
    expect(screen.getByText('Control entregado. Completa los pendientes, revisa y pulsa «Einreichen».')).toBeTruthy();
  });

  it('«Detener» llama a stop', () => {
    render(<AgentPanel visible />);
    fireEvent.click(screen.getByRole('button', { name: 'Detener' }));
    expect(api.stop).toHaveBeenCalled();
  });

  it('un evento model:error muestra el mensaje', () => {
    render(<AgentPanel visible />);
    emit({ type: 'model', status: 'error', message: 'No se encontró el modelo. Define FODIBO_MODEL con la ruta al archivo .gguf.' });
    expect(screen.getByRole('alert').textContent).toContain('No se encontró el modelo');
  });

  it('«Iniciar agente» y un rechazo muestran el error limpio', async () => {
    (api.start as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Error invoking remote method 'agent:start': Error: Ya hay una ejecución en curso."));
    render(<AgentPanel visible />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Iniciar agente' }));
    });
    expect(screen.getByRole('alert').textContent).toBe('Ya hay una ejecución en curso.');
  });

  it('al cambiar de pestaña oculta la vista sin encogerla y al volver la muestra con los límites actuales', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ x: 10, y: 100, width: 300, height: 200, top: 100, left: 10, right: 310, bottom: 300, toJSON() {} }) as DOMRect,
    );
    const { rerender } = render(<AgentPanel visible />);
    expect(api.setVisible).toHaveBeenLastCalledWith(true);
    const setBounds = api.setBounds as ReturnType<typeof vi.fn>;
    const setVisible = api.setVisible as ReturnType<typeof vi.fn>;
    setBounds.mockClear();
    rerender(<AgentPanel visible={false} />);
    expect(setVisible).toHaveBeenLastCalledWith(false);
    // Oculta no envía límites: la vista conserva su tamaño real y el agente sigue trabajando.
    expect(setBounds).not.toHaveBeenCalled();
    emit({ type: 'log', at: 'x', text: 'Paso 2/5: Einkünfte' });
    expect(setBounds).not.toHaveBeenCalled();
    rerender(<AgentPanel visible />);
    expect(setBounds).toHaveBeenLastCalledWith({ x: 10, y: 100, width: 300, height: 200 });
    expect(setVisible).toHaveBeenLastCalledWith(true);
    // Primero los límites, luego mostrar.
    expect(setBounds.mock.invocationCallOrder.at(-1)!).toBeLessThan(setVisible.mock.invocationCallOrder.at(-1)!);
    vi.restoreAllMocks();
  });

  it('la línea de estado muestra «Paso n/total» mientras rellena, o «Paso n» sin total', () => {
    render(<AgentPanel visible />);
    emit({ type: 'state', state: 'rellenando', step: 2, total: 5 });
    expect(screen.getByText(/Agente: Rellenando · Paso 2\/5/)).toBeTruthy();
    emit({ type: 'state', state: 'rellenando', step: 3 });
    expect(screen.getByText(/Agente: Rellenando · Paso 3$/)).toBeTruthy();
    emit({ type: 'state', state: 'entregado' });
    expect(screen.queryByText(/Paso 3/)).toBeNull();
  });

  it('un nuevo inicio borra el estado de la ejecución anterior', async () => {
    let release!: () => void;
    (api.start as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    render(<AgentPanel visible />);
    emit({ type: 'state', state: 'error', message: '«Weiter» no es visible o está tapado' });
    expect(screen.getByText(/Agente: Error — «Weiter»/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Iniciar agente' }));
    });
    expect(screen.queryByText(/Weiter/)).toBeNull();
    expect(screen.getByText(/Agente: Inactivo/)).toBeTruthy();
    await act(async () => release());
  });

  it('distribución fija: controles arriba; registro y pendientes en su propio panel desplazable, fuera del hueco', () => {
    render(<AgentPanel visible />);
    emit({ type: 'log', at: 'x', text: 'Observando el paso actual' });
    const pending = [pend(2, 'Ingresos', 'Bonus', 'sin_dato')];
    emit({ type: 'finished', results: pending, pending, blockedSubmits: 0 } as never);
    const holder = screen.getByLabelText('Vista del portal');
    const side = screen.getByRole('region', { name: 'Registro y pendientes' });
    expect(side.className).toContain('agent-side');
    expect(side.textContent).toContain('Observando el paso actual');
    expect(side.textContent).toContain('Pendientes');
    expect(holder.contains(side) || side.contains(holder)).toBe(false);
    // Los controles preceden al hueco del portal en el documento (quedan encima).
    const stop = screen.getByRole('button', { name: 'Detener' });
    expect(stop.compareDocumentPosition(holder) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('«No quedan pendientes» solo tras una entrega, no tras detener', () => {
    render(<AgentPanel visible />);
    emit({ type: 'state', state: 'detenido' });
    emit({ type: 'finished', results: [], pending: [], blockedSubmits: 0 } as never);
    expect(screen.queryByText('No quedan pendientes.')).toBeNull();
    emit({ type: 'state', state: 'entregado' });
    emit({ type: 'finished', results: [], pending: [], blockedSubmits: 0 } as never);
    expect(screen.getByText('No quedan pendientes.')).toBeTruthy();
  });

  it('reenvía los límites cuando aparece un error y desplaza el hueco', () => {
    let top = 100;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ x: 10, y: top, width: 300, height: 200, top, left: 10, right: 310, bottom: top + 200, toJSON() {} }) as DOMRect,
    );
    render(<AgentPanel visible />);
    expect(api.setBounds).toHaveBeenLastCalledWith({ x: 10, y: 100, width: 300, height: 200 });
    top = 160;
    emit({ type: 'model', status: 'error', message: 'fallo' });
    expect(api.setBounds).toHaveBeenLastCalledWith({ x: 10, y: 160, width: 300, height: 200 });
    vi.restoreAllMocks();
  });
});
