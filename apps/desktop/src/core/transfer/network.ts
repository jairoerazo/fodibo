import os from 'node:os';

function isPrivate(address: string): boolean {
  const p = address.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n))) return false;
  const [a, b] = p as [number, number, number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function privateIPv4Addresses(
  ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string[] {
  const out: string[] = [];
  for (const list of Object.values(ifaces)) {
    for (const i of list ?? []) {
      if (i.family === 'IPv4' && !i.internal && isPrivate(i.address)) out.push(i.address);
    }
  }
  return out;
}
