import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import { privateIPv4Addresses } from '../network.js';

const v4 = (address: string, internal = false) =>
  ({ address, family: 'IPv4', internal }) as NetworkInterfaceInfo;

describe('privateIPv4Addresses', () => {
  it('devuelve solo IPv4 privadas no internas', () => {
    const result = privateIPv4Addresses({
      lo: [v4('127.0.0.1', true)],
      en0: [v4('192.168.1.20'), { address: 'fe80::1', family: 'IPv6', internal: false } as NetworkInterfaceInfo],
      en1: [v4('10.0.0.5'), v4('172.32.0.1'), v4('8.8.8.8')],
      en2: [v4('172.20.1.1'), v4('192.168.9.9', true)],
      down: undefined,
    });
    expect(result).toEqual(['192.168.1.20', '10.0.0.5', '172.20.1.1']);
  });
});
