import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, test } from "vitest";
import { approvedDeclarationSchema, errorSchema, manifestSchema, qrSchema, receiptSchema } from "../index.js";

const vectorsDir = join(fileURLToPath(new URL("..", import.meta.url)), "vectors");

const ajv = new Ajv2020({ strict: true });
(addFormats as unknown as (a: Ajv2020) => void)(ajv);

const schemas = { qr: qrSchema, manifest: manifestSchema, receipt: receiptSchema, error: errorSchema, "approved-declaration": approvedDeclarationSchema };

function load(kind: string, outcome: "valid" | "invalid"): [string, unknown][] {
  const dir = join(vectorsDir, kind, outcome);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => [f, JSON.parse(readFileSync(join(dir, f), "utf8"))]);
}

for (const [kind, schema] of Object.entries(schemas)) {
  describe(`esquema ${kind}`, () => {
    const validate = ajv.compile(schema);
    const valid = load(kind, "valid");
    const invalid = load(kind, "invalid");

    test("hay vectores de ambos tipos", () => {
      expect(valid.length).toBeGreaterThan(0);
      expect(invalid.length).toBeGreaterThan(0);
    });
    test.each(valid)("valid/%s", (_name, data) => {
      expect(validate(data), JSON.stringify(validate.errors)).toBe(true);
    });
    test.each(invalid)("invalid/%s", (_name, data) => {
      expect(validate(data)).toBe(false);
    });
  });
}

// El límite de 500 MB (524 288 000 bytes) por paquete no lo cubre el esquema:
// se comprueba en validate.ts (Tarea 3), no en JSON Schema.
