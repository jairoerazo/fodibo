/**
 * Lector incremental de un objeto JSON: devuelve cada miembro de primer nivel (`clave`, valor) en cuanto
 * su valor está completo, sin esperar al final del texto. Pensado para la salida en streaming del modelo,
 * que la gramática de `llama-server` garantiza que es JSON válido; un miembro que no se puede interpretar
 * se descarta (la validación de la respuesta completa decide después).
 */
export class TopLevelMembers {
  private buf = '';
  private pos = 0;
  private depth = 0;
  private inString = false;
  private escape = false;
  private stringStart = -1;
  private key: string | undefined;
  private expectKey = false;
  private valueStart = -1;
  private notObject = false;

  push(chunk: string): [string, unknown][] {
    this.buf += chunk;
    const out: [string, unknown][] = [];
    for (; this.pos < this.buf.length; this.pos++) {
      if (this.notObject) break;
      const ch = this.buf[this.pos]!;
      if (this.inString) {
        if (this.escape) this.escape = false;
        else if (ch === '\\') this.escape = true;
        else if (ch === '"') {
          this.inString = false;
          if (this.depth === 1 && this.expectKey) {
            this.key = this.parse(this.buf.slice(this.stringStart, this.pos + 1)) as string | undefined;
            this.expectKey = false;
          } else if (this.depth === 1 && this.valueStart >= 0) this.emit(this.pos + 1, out);
        }
        continue;
      }
      if (/\s/.test(ch)) continue;
      if (this.depth === 0) {
        if (ch === '{') {
          this.depth = 1;
          this.expectKey = true;
        } else this.notObject = true;
        continue;
      }
      if (this.depth === 1 && this.valueStart < 0 && !this.expectKey && ch !== ':' && ch !== ',' && ch !== '}') {
        this.valueStart = this.pos;
      }
      switch (ch) {
        case '"':
          this.inString = true;
          this.stringStart = this.pos;
          break;
        case '{':
        case '[':
          this.depth++;
          break;
        case '}':
        case ']':
          this.depth--;
          // Objeto o array de primer nivel cerrado; o fin del objeto tras un primitivo.
          if (this.depth === 1 && this.valueStart >= 0) this.emit(this.pos + 1, out);
          else if (this.depth === 0 && this.valueStart >= 0) this.emit(this.pos, out);
          break;
        case ',':
          if (this.depth === 1) {
            if (this.valueStart >= 0) this.emit(this.pos, out); // primitivo
            this.expectKey = true;
          }
          break;
      }
    }
    return out;
  }

  /** Emite el valor entre `valueStart` y `end` (exclusivo) con la clave en curso. */
  private emit(end: number, out: [string, unknown][]): void {
    const value = this.parse(this.buf.slice(this.valueStart, end));
    if (this.key !== undefined && value !== undefined) out.push([this.key, value]);
    this.key = undefined;
    this.valueStart = -1;
  }

  private parse(text: string): unknown {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }
}
