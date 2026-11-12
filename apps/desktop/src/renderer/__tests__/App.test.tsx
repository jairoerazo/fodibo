// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransferEvent } from '../../core/transfer/index.js';
import { App } from '../App.js';

vi.mock('../components/AgentPanel.js', () => ({ AgentPanel: () => null }));

const ok = <T,>(value: T) => ({ ok: true as const, value });
let emit: (e: TransferEvent) => void = () => {};
let listImportable: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  listImportable = vi.fn(async () => ok([]));
  (window as unknown as { fodibo: unknown }).fodibo = {
    onEvent: vi.fn((cb: (e: TransferEvent) => void) => {
      emit = cb;
      return () => {};
    }),
    listReceived: vi.fn(async () => []),
    startReceiving: vi.fn(),
    stopReceiving: vi.fn(),
    openPackage: vi.fn(async () => {}),
  };
  (window as unknown as { fodiboExpediente: unknown }).fodiboExpediente = {
    listCases: vi.fn(async () => ok([])),
    listConcepts: vi.fn(async () => ok([])),
    listImportable,
    getCase: vi.fn(),
    onEvent: vi.fn(() => () => {}),
  };
});
afterEach(cleanup);

describe('App: paquetes sin importar del expediente', () => {
  it('se recargan al abrir la pestaña Expediente y al llegar un paquete', async () => {
    render(<App />);
    await new Promise((r) => setTimeout(r, 10));
    expect(listImportable).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('tab', { name: 'Expediente' }));
    await waitFor(() => expect(listImportable).toHaveBeenCalledTimes(1));
    const pkg = { deviceName: 'Pixel 8', receipt: { schema_version: 1, package_id: 'p1', received_at: '2026-11-10T15:30:00.000Z', files: [] } };
    act(() => emit({ type: 'received', pkg } as unknown as TransferEvent));
    await waitFor(() => expect(listImportable).toHaveBeenCalledTimes(2));
  });
});
