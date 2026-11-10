import { describe, expect, it } from 'vitest';
import { TransferError } from '../errors.js';
import { PairingSession } from '../session.js';

const MIN = 60_000;

function make() {
  const clock = { t: 1_000_000 };
  const session = new PairingSession({ now: () => clock.t });
  return { clock, session };
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(TransferError);
    return (e as TransferError).code;
  }
  return undefined;
}

describe('PairingSession', () => {
  it('secreto de 22 caracteres base64url y caduca a los 5 minutos', () => {
    const { session } = make();
    expect(session.secret).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(session.expiresAt.getTime()).toBe(1_000_000 + 5 * MIN);
  });

  it('pair correcto devuelve token; el secreto es de un solo uso', () => {
    const { session } = make();
    const { sessionToken } = session.pair(session.secret, 'Pixel');
    expect(sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(codeOf(() => session.pair(session.secret, 'Pixel'))).toBe('invalid_secret');
  });

  it('pair tras 5 min + 1 ms falla', () => {
    const { session, clock } = make();
    clock.t += 5 * MIN + 1;
    expect(codeOf(() => session.pair(session.secret, 'Pixel'))).toBe('invalid_secret');
  });

  it('5 intentos fallidos cierran la sesión', () => {
    const { session } = make();
    let closed = 0;
    session.onClose(() => closed++);
    for (let i = 0; i < 5; i++) {
      expect(codeOf(() => session.pair('incorrecto', 'x'))).toBe('invalid_secret');
    }
    expect(session.closed).toBe(true);
    expect(closed).toBe(1);
    expect(codeOf(() => session.pair(session.secret, 'x'))).toBe('invalid_secret');
    expect(closed).toBe(1);
  });

  it('secreto de distinta longitud solo produce invalid_secret', () => {
    const { session } = make();
    expect(codeOf(() => session.pair('', 'x'))).toBe('invalid_secret');
    expect(codeOf(() => session.pair('a'.repeat(500), 'x'))).toBe('invalid_secret');
  });

  it('authenticate rechaza ausente o incorrecto', () => {
    const { session } = make();
    session.pair(session.secret, 'Pixel');
    expect(codeOf(() => session.authenticate(undefined))).toBe('unauthorized');
    expect(codeOf(() => session.authenticate('malo'))).toBe('unauthorized');
    expect(codeOf(() => session.authenticate('a'.repeat(43)))).toBe('unauthorized');
  });

  it('authenticate sin emparejar es unauthorized', () => {
    const { session } = make();
    expect(codeOf(() => session.authenticate('a'.repeat(43)))).toBe('unauthorized');
  });

  it('inactividad: 29 min vale y renueva; 30 min + 1 ms cierra', () => {
    const { session, clock } = make();
    let closed = 0;
    session.onClose(() => closed++);
    const { sessionToken } = session.pair(session.secret, 'Pixel');
    clock.t += 29 * MIN;
    session.authenticate(sessionToken);
    clock.t += 29 * MIN;
    session.authenticate(sessionToken);
    clock.t += 30 * MIN + 1;
    expect(codeOf(() => session.authenticate(sessionToken))).toBe('unauthorized');
    expect(session.closed).toBe(true);
    expect(closed).toBe(1);
  });

  it('close es idempotente y invalida el token', () => {
    const { session } = make();
    let closed = 0;
    session.onClose(() => closed++);
    const { sessionToken } = session.pair(session.secret, 'Pixel');
    session.close();
    session.close();
    expect(closed).toBe(1);
    expect(codeOf(() => session.authenticate(sessionToken))).toBe('unauthorized');
  });

  it('(R5) tras emparejar, los pair fallidos no cuentan para el cierre', () => {
    const { session } = make();
    const { sessionToken } = session.pair(session.secret, 'Pixel');
    for (let i = 0; i < 7; i++) {
      expect(codeOf(() => session.pair('incorrecto', 'x'))).toBe('invalid_secret');
    }
    expect(codeOf(() => session.pair(session.secret, 'x'))).toBe('invalid_secret');
    expect(session.closed).toBe(false);
    session.authenticate(sessionToken);
  });

  it('el motivo de cierre llega a onClose', () => {
    const reasons: string[] = [];
    const a = make().session;
    a.onClose((r) => reasons.push(r));
    for (let i = 0; i < 5; i++) codeOf(() => a.pair('incorrecto', 'x'));
    const b = make().session;
    b.onClose((r) => reasons.push(r));
    b.close();
    expect(reasons).toEqual(['too-many-attempts', 'stopped']);
  });

  it('(R6) checkIdle cierra por inactividad sin petición; antes de emparejar no hace nada', () => {
    const { session, clock } = make();
    const reasons: string[] = [];
    session.onClose((r) => reasons.push(r));
    clock.t += 4 * MIN;
    session.checkIdle();
    expect(session.closed).toBe(false);
    session.pair(session.secret, 'Pixel');
    clock.t += 30 * MIN;
    session.checkIdle();
    expect(session.closed).toBe(false);
    clock.t += 1;
    session.checkIdle();
    expect(session.closed).toBe(true);
    expect(reasons).toEqual(['inactive']);
  });

  it('inactividad detectada en authenticate informa "inactive"', () => {
    const { session, clock } = make();
    const reasons: string[] = [];
    session.onClose((r) => reasons.push(r));
    const { sessionToken } = session.pair(session.secret, 'Pixel');
    clock.t += 30 * MIN + 1;
    expect(codeOf(() => session.authenticate(sessionToken))).toBe('unauthorized');
    expect(reasons).toEqual(['inactive']);
  });
});
