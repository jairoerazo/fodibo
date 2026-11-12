import { describe, expect, it } from 'vitest';
import { canonical } from '../canonical.js';

describe('canonical', () => {
  it('ordena claves y no deja espacios', () => {
    expect(canonical({ b: 1, a: [{ d: 2, c: 'x' }] })).toBe('{"a":[{"c":"x","d":2}],"b":1}');
  });
  it('es independiente del orden de las claves', () => {
    expect(canonical({ a: 1, b: 2 })).toBe(canonical({ b: 2, a: 1 }));
  });
});
