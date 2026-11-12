import { describe, expect, it } from 'vitest';
import { TopLevelMembers } from '../json-stream.js';

const feed = (chunks: string[]) => {
  const s = new TopLevelMembers();
  const out: [string, unknown][] = [];
  for (const c of chunks) out.push(...s.push(c));
  return out;
};

describe('TopLevelMembers', () => {
  it('emite cada miembro de primer nivel en cuanto su valor se cierra', () => {
    const s = new TopLevelMembers();
    expect(s.push('{"c1": {"sour')).toEqual([]);
    expect(s.push('ce": "x"}')).toEqual([['c1', { source: 'x' }]]);
    expect(s.push(', "c2": {"pending": "a}b\\"{", "candidates": ["k"]}')).toEqual([['c2', { pending: 'a}b"{', candidates: ['k'] }]]);
    expect(s.push('}')).toEqual([]);
  });

  it('carácter a carácter da el mismo resultado', () => {
    const text = '{ "a" : {"skip": true} ,\n "b\\u00e9": {"x": [1, {"y": "]"}]}, "n": 3, "s": "t"}';
    expect(feed([...text])).toEqual([
      ['a', { skip: true }],
      ['bé', { x: [1, { y: ']' }] }],
      ['n', 3],
      ['s', 't'],
    ]);
  });

  it('ignora lo que no es un objeto en el primer nivel', () => {
    expect(feed(['[1, 2]'])).toEqual([]);
  });
});
