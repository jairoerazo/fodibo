// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PackageCard } from '../components/PackageCard.js';
import type { ReceivedPackage } from '../../core/transfer/index.js';

afterEach(cleanup);

const file = (n: number, name: string, mime: string, size: number) => ({
  file_id: `00000000-0000-4000-8000-00000000000${n}`,
  name,
  mime,
  size,
  sha256: 'a'.repeat(64),
  status: 'stored' as const,
});

const pkg = {
  deviceName: 'Pixel 8',
  receipt: {
    schema_version: 1,
    package_id: '11111111-1111-4111-8111-111111111111',
    received_at: '2026-11-10T15:30:00.000Z',
    files: [
      file(1, 'Quittung Zürich 🧾.jpg', 'image/jpeg', 2_481_930),
      file(2, 'contrato.pdf', 'application/pdf', 20_480),
      file(3, 'datos.json', 'application/json', 512),
    ],
  },
} as ReceivedPackage;

describe('PackageCard', () => {
  it('muestra dispositivo, archivos, tamaños e integridad', () => {
    render(<PackageCard pkg={pkg} onOpen={() => {}} />);
    expect(screen.getByText(/Pixel 8/)).toBeTruthy();
    expect(screen.getByText('Quittung Zürich 🧾.jpg')).toBeTruthy();
    expect(screen.getByText('contrato.pdf')).toBeTruthy();
    expect(screen.getByText('datos.json')).toBeTruthy();
    expect(screen.getByText(/2,4 MB/)).toBeTruthy();
    expect(screen.getAllByText(/Integridad verificada/)).toHaveLength(3);
  });

  it('abre la carpeta del paquete', () => {
    const opened: string[] = [];
    render(<PackageCard pkg={pkg} onOpen={(id) => opened.push(id)} />);
    screen.getByRole('button', { name: 'Abrir carpeta' }).click();
    expect(opened).toEqual([pkg.receipt.package_id]);
  });
});
