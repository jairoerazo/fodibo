# Expediente (primera versión) — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un expediente local en SQLite que importa paquetes de `inbox/`, permite revisar documentos y registrar campos con evidencia, y produce una versión aprobada e inmutable que es lo único que el agente navegador puede usar.

**Architecture:** Núcleo en `apps/desktop/src/core/expediente/` (Node puro, sin Electron ni React). El SQL y el binding solo existen en `core/expediente/storage/`. `main` conecta el núcleo con el IPC validado por Ajv, con un protocolo `fodibo-doc:` para el visor y con el agente. El renderer añade la pestaña «Expediente».

**Tech Stack:**
- Electron 45.2.3 (Node 24.22) y Node del sistema ≥ 22 (hoy 25.2) para Vitest.
- `node:sqlite` (`DatabaseSync`, SQLite 3.53), React 19, Ajv 8.20 (`ajv/dist/2020.js`) y Vitest 5.1.
- `pdfjs-dist`, en versión fijada (Tarea 13).

**Spec:** `docs/superpowers/specs/2026-11-12-expediente-design.md`, aprobada el 12 de noviembre de 2026 con las propuestas de §19. Las referencias «§n» de este plan son a esa spec.

## Global Constraints

**Binding y almacenamiento**
- Binding: `node:sqlite` (`DatabaseSync`), ya incluido en Electron 45 y en Node ≥ 22.13. Verificado: carga en Electron 45.2.3 con `ELECTRON_RUN_AS_NODE=1` (Node 24.22.2, SQLite 3.53.4).
  - Cumple los criterios 1, 2 y 4 de §4.3. No cumple el 3 (SQLCipher): según §4.3 gana el 1, y el cambio de binding se hace en la ronda de cifrado.
  - Hay que anotarlo en el README (Tarea 14).
- Solo `src/core/expediente/storage/` importa `node:sqlite` y escribe SQL.
  - `src/core/expediente/` no importa `electron`, `react` ni módulos de red (`node:net`, `node:http`, `node:https`, `node:tls`, `node:dgram`, `undici`, `fetch(`).
- SQLite:
  - `PRAGMA journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`.
  - Tablas `STRICT`, sentencias siempre preparadas.
  - Versión del esquema en `PRAGMA user_version` (esta entrega crea la versión 1).

**Formatos de datos**
- Identificadores: UUID v4 en minúsculas (`randomUUID()`).
- Instantes: `new Date().toISOString()`. Fechas documentales: `AAAA-MM-DD`.
- Importes: texto `^-?\d+\.\d{2}$`, nunca `REAL`.

**Valores cerrados**
- Cantones (`jurisdiction`): `AG AI AR BE BL BS FR GE GL GR JU LU NE NW OW SG SH SO SZ TG TI UR VD VS ZG ZH`.
- `doc_type`: `lohnausweis`, `bankbeleg`, `krankenkasse`, `saeule_3a`, `quittung`, `sonstiges`.
- `documents.status`: `capturado`, `extraido`, `pendiente_de_revision`, `confirmado`, `descartado`. Esta versión solo escribe los tres últimos.
- `fields.origin`: `regla`, `modelo`, `usuario`. `fields.status`: `pendiente`, `confirmado`.
- `persons.role`: `hauptperson`, `partner`, `kind`. `slug`: `hauptperson`, `partner` o `kind_<ordinal>`. El `slug` nunca se reutiliza. Las variantes también admiten `familie`.
- `changes.entity`: `case`, `person`, `document`, `field`, `import`, `approval`.
- `actor`: siempre `usuario:local`.

**Límites**
- Archivo ≤ `MAX_FILE_BYTES` (52 428 800) y paquete ≤ `MAX_PACKAGE_BYTES` (524 288 000), de `core/transfer/types.ts`. Como mucho 100 archivos por paquete.
- Texto ≤ 200 caracteres. Hasta 20 evidencias por campo. Página entre 0 y 9999.
- Vista de JSON truncada a 262 144 bytes.

**Errores**
- Códigos del núcleo (§13):
  - `invalid_input`, `not_found`, `storage_error`;
  - `package_incomplete`, `package_invalid`, `package_in_other_case`, `integrity_error`;
  - `invalid_transition`, `person_in_use`;
  - `stale_revision`, `blocked`;
  - `no_approval`, `approval_stale`, `approval_corrupt`.
- Mensajes en español. Ni la consola ni los mensajes de error incluyen valores de campos ni nombres de archivo; solo identificadores y códigos.

**Vocabulario**
- Las claves de la declaración son ids del catálogo suizo `CONCEPTS`; no hay claves en español. Los textos de la interfaz van en español.

**Restricciones generales**
- Nada sale del equipo. `inbox/` no se modifica al importar.
- Commits:
  - mensajes en español, con estilo `feat(expediente): …`;
  - cada commit termina con las líneas de atribución de la sesión;
  - todas las pruebas de `apps/desktop` (`npx vitest run`) y `npm run typecheck` pasan antes de cada commit.

## Review Focus

1. **Doble pulsación de «Importar» o dos importaciones simultáneas del mismo paquete:** debe quedar una sola importación; la segunda devuelve `already_imported`. Prueba en la Tarea 7.
2. **Expediente activo recordado que ya no existe** (base restaurada o vacía): la pestaña arranca sin expediente seleccionado y no falla. Prueba en la Tarea 12.
3. **Quitar un hijo y añadir otro:** el nuevo recibe un `kind_<n>` mayor que cualquiera usado antes, y una variante antigua nunca se reinterpreta. Prueba en la Tarea 6.
4. **Una `case-changed` de otro expediente** durante un llenado no lo detiene; una del mismo sí. Prueba en la Tarea 11.
5. **Blob borrado o alterado a mano mientras la app está abierta:** el visor responde 404 o `integrity_error` sin tumbar `main`, y la vista del expediente muestra «original no disponible». Pruebas en las Tareas 10 y 9.

---

### Task 1: Bases compartidas (huella canónica, validación por tipo, catálogo)

**Files:**
- Create: `apps/desktop/src/core/common/canonical.ts`
- Modify: `apps/desktop/src/core/transfer/inbox.ts` (importar `canonical` en lugar de la función privada de la línea 16)
- Modify: `apps/desktop/src/core/agent/declaration.ts` (exportar `validateEntry`, `validDate` y `validIban`, sin cambiar su comportamiento)
- Modify: `apps/desktop/src/core/agent/catalog.ts`
- Modify: `apps/desktop/src/core/agent/index.ts`
- Test: `apps/desktop/src/core/common/__tests__/canonical.test.ts` y `apps/desktop/src/core/agent/__tests__/catalog.test.ts`

**Interfaces:**
- Produces:
  - `canonical(v: unknown): string`: claves ordenadas, sin espacios.
  - `validateEntry(key: string, raw: unknown): DeclEntry`, `validDate(s: string): boolean` y `validIban(s: string): boolean`, exportadas desde `core/agent/index.ts`.
  - `Concept.values?: string[]`.

- [ ] **Paso 1: escribir las pruebas que fallan**
  - `canonical`:
    - `canonical({b:1,a:[{d:2,c:'x'}]}) === '{"a":[{"c":"x","d":2}],"b":1}'`;
    - `canonical({a:1,b:2}) === canonical({b:2,a:1})`.
  - En `catalog.test.ts`, «los conceptos enum declaran sus valores»: `CONCEPTS.find(c=>c.id==='zivilstand')!.values` es igual a `['ledig','verheiratet','geschieden','verwitwet','eingetragene Partnerschaft']`, y todo concepto con `tipo==='enum'` tiene `values` no vacío.
  - En `catalog.test.ts`, «ningún id empieza por el prefijo de un concepto con variantes»: para cada `c` con `variants`, ningún otro id empieza por `` `${c.id}_` ``.
- [ ] **Paso 2:** `npx vitest run src/core/common src/core/agent/__tests__/catalog.test.ts`. Resultado esperado: FALLA.
- [ ] **Paso 3: implementar**
  - Mover `canonical` de `inbox.ts` a `core/common/canonical.ts` y hacer que `inbox.ts` la importe.
  - Exportar las tres funciones de `declaration.ts`.
  - Añadir `values` a `zivilstand`. `resolveFromCatalog` no cambia.
- [ ] **Paso 4:** `npx vitest run && npm run typecheck`. Resultado esperado: todo PASA. Las pruebas de `inbox` siguen verdes.
- [ ] **Paso 5:** commit `feat(expediente): huella canónica común, validación exportada y valores enum del catálogo`.

### Task 2: Contrato `approved-declaration`

**Files:**
- Create: `packages/contracts/schemas/approved-declaration.schema.json`
- Create: `packages/contracts/vectors/approved-declaration/valid/basic.json` y `…/valid/declaracion-prueba.json`
- Create: `packages/contracts/vectors/approved-declaration/invalid/` con 6 vectores
- Modify: `packages/contracts/index.js`, `index.d.ts` y `test/vectors.test.ts` (añadir `"approved-declaration": approvedDeclarationSchema` al mapa)

**Interfaces:**
- Produces: `approvedDeclarationSchema: JsonSchema`, exportado por `@fodibo/contracts`.

- [ ] **Paso 1: esquema** (JSON Schema 2020-12, `additionalProperties: false` en todos los niveles) con la forma exacta de §8.2:
  - Raíz:
    - `schema_version` const 1;
    - `approval_id` y `case_id` con el patrón UUID en minúsculas;
    - `case_revision`: entero ≥ 0;
    - `approved_at`: `date-time`;
    - `approver`: string de 1 a 64;
    - `content_hash`: `^[0-9a-f]{64}$`;
    - `content`.
  - `content`:
    - `tax_year`: entero de 2000 a 2100;
    - `jurisdiction`: enum de los 26 cantones;
    - `rules_version`: null;
    - `fields`: objeto con `propertyNames` `^[a-z][a-z0-9_]*$` y valores `oneOf` por `tipo`. `amount` exige `moneda` `^[A-Z]{3}$` y `valor` `^-?\d+\.\d{2}$`; `boolean` exige `valor` booleano; el resto, string de 1 a 200;
    - `evidence`: objeto cuyos valores son arrays de hasta 20 elementos `{document_id, sha256, page}`, con `page` de 0 a 9999;
    - `documents`: array de `{document_id, sha256, mime, doc_type}`, con `mime` entre los cinco de la transferencia y `doc_type` en la lista cerrada.
- [ ] **Paso 2: vectores**
  - `declaracion-prueba.json` lleva en `content.fields` exactamente el contenido de `apps/desktop/test-portal/declaracion.json`.
  - Inválidos:
    - falta `content_hash`;
    - importe `"85400.5"`;
    - `jurisdiction: "XX"`;
    - propiedad extra en la raíz;
    - `rules_version: "2025"`;
    - campo `amount` sin `moneda`.
- [ ] **Paso 3:** `npm test -w @fodibo/contracts`. Resultado esperado: PASA, con los nuevos vectores incluidos.
- [ ] **Paso 4:** commit `feat(contracts): esquema approved-declaration con vectores`.

### Task 3: Almacén SQLite y migraciones

**Files:**
- Create: `apps/desktop/src/core/expediente/errors.ts` y `types.ts`
- Create: `apps/desktop/src/core/expediente/storage/schema.ts` (migración v1)
- Create: `apps/desktop/src/core/expediente/storage/case-store.ts`
- Create: `apps/desktop/src/core/expediente/storage/index.ts`
- Create: `apps/desktop/src/core/expediente/__tests__/isolation.test.ts`
- Test: `apps/desktop/src/core/expediente/storage/__tests__/case-store.test.ts`

**Interfaces:**
- Produces:
  - `class ExpedienteError extends Error { constructor(readonly code: ExpedienteErrorCode, message: string, readonly details?: unknown) }`, con los códigos de las Global Constraints.
  - `types.ts`: tipos de dominio (`Canton`, `PersonRole`, `DocStatus`, `DocType`, `FieldOrigin`, `FieldStatus`, `Evidence { documentId: string; page: number }`) y las filas de cada tabla.
  - `openStore(opts: { dir: string; key?: Uint8Array; now?: () => Date; migrations?: Migration[] }): CaseStore`, que:
    - crea `dir`;
    - abre `<dir>/fodibo.db`;
    - aplica los pragmas;
    - aplica las migraciones;
    - lanza `ExpedienteError('storage_error')` si `user_version` es mayor que la última migración conocida o si `PRAGMA integrity_check` no devuelve `ok`.
  - `CaseStore`:
    - `transaction<T>(fn: () => T): T`, síncrona, con `BEGIN IMMEDIATE`; revierte si `fn` lanza;
    - métodos de lectura y escritura por tabla;
    - `close()`.
  - Las tareas siguientes añaden a `CaseStore` los métodos que necesiten, siempre dentro de `storage/`.
  - `type Migration = { version: number; up(db): void }`.

- [ ] **Paso 1: escribir las pruebas que fallan**
  - «crea el esquema v1»: `user_version === 1` y existen las 9 tablas de §5.1. Ver `sqlite_master`; todas llevan `STRICT`.
  - «restricciones»:
    - `UNIQUE(case_id, sha256)` en `documents`;
    - `UNIQUE(case_id, concept_id, variant)` en `fields`;
    - `CHECK` de `status`, `origin`, `role` y `moneda IS NOT NULL` si y solo si `tipo='amount'`;
    - FK activa: un `field_evidence` a un documento inexistente falla.
  - «`changes` y `approvals` son solo inserción»: `UPDATE` y `DELETE` lanzan, porque los disparadores hacen `RAISE(ABORT)`.
  - «una sola `hauptperson` y como mucho un `partner`»: índices únicos parciales sobre `(case_id) WHERE role='hauptperson'` y sobre `WHERE role='partner'`.
  - «migración con copia previa»:
    - crear una base con `user_version=1` y abrirla con `migrations` que añade una v2 → existe `backups/fodibo-v1-*.db` y `user_version === 2`;
    - si la v2 lanza, `user_version` sigue en 1 y la base se puede abrir.
  - «rechaza una base de versión posterior»: con `user_version=99`, `openStore` lanza `storage_error` y no modifica el archivo (mismo `mtime` y tamaño).
  - «transaction revierte»: un `fn` que inserta y luego lanza no deja filas.
  - `isolation.test.ts`:
    - ningún `.ts` de `core/expediente` importa `electron`, `react` ni los módulos de red de las Global Constraints;
    - solo los archivos bajo `storage/` contienen `node:sqlite`.
- [ ] **Paso 2:** `npx vitest run src/core/expediente`. Resultado esperado: FALLA.
- [ ] **Paso 3: implementar**
  - La migración v1 crea las tablas, los índices y los disparadores de §5.1.
  - `revision` y `case_revision` llevan `CHECK (>= 0)`.
  - Cada migración se ejecuta en su propia transacción, después de copiar la base a `backups/fodibo-v<n>-<timestamp>.db`. La copia se hace con `VACUUM INTO` o con un checkpoint previo; no basta copiar el archivo con el WAL abierto.
  - Si la base es nueva, no hace falta copia.
- [ ] **Paso 4:** `npx vitest run && npm run typecheck`. Resultado esperado: PASA.
- [ ] **Paso 5:** commit `feat(expediente): almacén SQLite (node:sqlite) con esquema v1 y migraciones`.

### Task 4: Almacén de originales (`BlobStore`)

**Files:**
- Create: `apps/desktop/src/core/expediente/storage/blob-store.ts`
- Test: `apps/desktop/src/core/expediente/storage/__tests__/blob-store.test.ts`

**Interfaces:**
- Produces: `class BlobStore`, construida con `new BlobStore(dir: string)`, donde `dir = <dataDir>/expediente/blobs`.
- Métodos:
  - `has(sha256): Promise<boolean>`.
  - `put(source: string, expected: { sha256: string; size: number; mime: Mime }): Promise<void>`:
    - comprueba con `lstat` que `source` es un archivo regular y no un enlace simbólico;
    - copia a `tmp/<uuid>.part` calculando hash y tamaño;
    - comprueba `sniffOk(mime, primeros 12 bytes)`;
    - hace `fsync`, renombra a `<aa>/<sha256>` y aplica `chmod 0o444`;
    - si algo no coincide, borra el temporal y lanza `ExpedienteError('integrity_error')`;
    - si el blob ya existe, no hace nada.
  - `open(sha256, range?: { start: number; end: number }): Readable`.
  - `verify(sha256): Promise<{ ok: boolean; size?: number }>`: recalcula el hash completo.
  - `stat(sha256): Promise<{ size: number } | undefined>`.
  - `remove(sha256): Promise<void>`.
  - `list(): Promise<string[]>`.
  - `cleanTmp(): Promise<void>`.
  - `pathOf(sha256): string`, solo para `showDocumentInFolder`.
- Todos los métodos validan `sha256` con `^[0-9a-f]{64}$` antes de construir una ruta; si no cumple, lanzan `invalid_input`.

- [ ] **Paso 1: escribir las pruebas que fallan**
  - `put` + `has` + `open` devuelve los mismos bytes, y el modo del archivo es `0o444`.
  - Un `put` repetido no reescribe: el `mtime` no cambia.
  - Un hash que no coincide da `integrity_error`, no queda blob y `tmp/` queda vacío.
  - Un `source` que es un enlace simbólico da `integrity_error`.
  - Un PDF con `mime: 'image/png'` da `integrity_error`.
  - `open` con rango devuelve exactamente los bytes `start..end`, ambos inclusive.
  - `verify` detecta un blob alterado con `chmod` + `writeFile`.
  - `list` no incluye `tmp/`.
  - `cleanTmp` borra `.part`.
  - `has('../x')` lanza `invalid_input`.
- [ ] **Paso 2:** ejecutar las pruebas. Resultado esperado: FALLA. **Paso 3:** implementar. **Paso 4:** `npx vitest run && npm run typecheck`. Resultado esperado: PASA.
- [ ] **Paso 5:** commit `feat(expediente): almacén de originales direccionado por SHA-256`.

### Task 5: Normalización y validación por tipo

**Files:**
- Create: `apps/desktop/src/core/expediente/validation.ts`
- Test: `apps/desktop/src/core/expediente/__tests__/validation.test.ts`

**Interfaces:**
- Consumes: `validateEntry`, `validDate` y `validIban` (Tarea 1), y `Concept` con `values`.
- Produces: `normalizeValue(concept: Concept, input: { valor: unknown; moneda?: unknown }): DeclEntry`.
  - Devuelve la forma guardada de §6.3.
  - Si el valor no es válido, lanza `ExpedienteError('invalid_input', mensaje en español, { field: 'valor' })`.
  - El resultado siempre pasa `validateEntry`.

- [ ] **Paso 1: tabla de pruebas** (`it.each`) con exactamente estos casos:

  | `tipo` | Entrada | Resultado |
  | --- | --- | --- |
  | `text` | `'  Müller  '` | `'Müller'` |
  | `text` | `''` | rechazo |
  | `text` | `'a\u0007b'` | rechazo |
  | `text` | 201 caracteres | rechazo |
  | `text` | `'Müller'` | `'Müller'` en NFC |
  | `date` | `'07.03.1984'` | `'1984-03-07'` |
  | `date` | `'1984-03-07'` | `'1984-03-07'` |
  | `date` | `'31.02.2024'` | rechazo |
  | `date` | `'7.3.84'` | rechazo |
  | `amount` | `"85'400.00"` | `'85400.00'` |
  | `amount` | `'85’400,5'` | `'85400.50'` |
  | `amount` | `'85 400'` | `'85400.00'` |
  | `amount` | `'-12.3'` | `'-12.30'` |
  | `amount` | `'12.345'` | rechazo |
  | `amount` | `'CHF 100'` | rechazo |
  | `amount` | `'1,234.50'` | rechazo (dos separadores ambiguos) |

  - En `amount`, `moneda` es `'CHF'` por defecto y `'chf'` se guarda como `'CHF'`. `'CHFX'` se rechaza.
  - `iban`:

    | Entrada | Resultado |
    | --- | --- |
    | `'ch93 0076 2011 6238 5295 7'` | `'CH9300762011623852957'` |
    | `'CH9300762011623852958'` | rechazo |

  - `enum` (`zivilstand`):

    | Entrada | Resultado |
    | --- | --- |
    | `'verheiratet'` | `'verheiratet'` |
    | `'Verheiratet'` | rechazo (valor exacto de la lista) |
    | `'marié'` | rechazo |

  - `boolean`:

    | Entrada | Resultado |
    | --- | --- |
    | `true` | `true` |
    | `'true'` | rechazo |

- [ ] **Paso 2:** ejecutar las pruebas. Resultado esperado: FALLA. **Paso 3:** implementar. **Paso 4:** ejecutar las pruebas. Resultado esperado: PASA.
- [ ] **Paso 5:** commit `feat(expediente): normalización y validación de valores por tipo`.

### Task 6: Servicio: expedientes, personas, revisión e historial

**Files:**
- Create: `apps/desktop/src/core/expediente/service.ts`
- Create: `apps/desktop/src/core/expediente/index.ts`
- Modify: `apps/desktop/src/core/expediente/storage/case-store.ts`
- Test: `apps/desktop/src/core/expediente/__tests__/cases.test.ts`

**Interfaces:**
- Consumes: `openStore` y `CaseStore` (Tarea 3), y `BlobStore` (Tarea 4).
- Produces:
  - `ExpedienteService.open(opts: { dataDir: string; inboxDir: string; now?: () => Date; concepts?: readonly Concept[]; hooks?: { beforeImportCommit?: () => void } }): Promise<ExpedienteService>`.
    - Abre `<dataDir>/expediente/fodibo.db` y `blobs/`.
    - Ejecuta `recover()` (Tarea 7) antes de devolver el servicio.
  - `close(): void`.
  - `on(cb: (e: { type: 'case-changed'; caseId: string; revision: number }) => void): () => void`.
    - Se emite después del `COMMIT`, una vez por transacción que cambia la revisión.
  - `listCases(): CaseSummary[]`, con `{ caseId, taxYear, jurisdiction, revision, createdAt, hauptpersonLabel }`.
  - `createCase(input: CaseInput): CaseView`.
    - `CaseInput = { taxYear: number; jurisdiction: Canton; persons: Array<{ role: PersonRole; label: string }> }`.
    - Exige exactamente una `hauptperson` y como mucho un `partner`.
    - `label` va de 1 a 60 caracteres.
  - `updateCase(caseId, input: { taxYear?: number; jurisdiction?: Canton; persons?: Array<{ slug?: string; role: PersonRole; label: string }> }): CaseView`.
    - `persons` es la lista deseada completa:
      - una entrada sin `slug` es un alta;
      - un `slug` que ya existía y no aparece es una baja;
      - un `slug` con otro `label` es un cambio de rótulo.
    - Una baja con campos que usan el `slug` como variante lanza `person_in_use` con `details: { fieldIds }`.
  - `getCase(caseId): CaseView`. La Tarea 9 completa el estado, los bloqueos y los avisos.
  - El servicio serializa las operaciones asíncronas con una cola de promesas, como `TransferService.enqueue`. Las síncronas corren dentro de `store.transaction`.
- **Regla de revisión:** un ayudante interno `commitChange(caseId, entries: ChangeEntry[])` dentro de la transacción:
  - incrementa `cases.revision` exactamente en 1;
  - escribe cada entrada en `changes` con esa revisión, `actor: 'usuario:local'` y `at: now()`.
  - Todas las escrituras de contenido pasan por él. Crear un expediente deja `revision = 0` y una entrada `case/create`.
- **Ordinal de `kind`:** 1 + el mayor ordinal usado en ese expediente, contando también las personas dadas de baja. Se obtiene de `changes` (`entity='person'`), no solo de `persons`.

- [ ] **Paso 1: escribir las pruebas que fallan**
  - «crea un expediente con titular, pareja y dos hijos»: los slugs son `hauptperson`, `partner`, `kind_1` y `kind_2`; `revision 0`; `listCases` lo devuelve.
  - «rechaza dos titulares, ningún titular, dos parejas, un año fuera de 2000–2100, un cantón desconocido o un rótulo vacío»: todos lanzan `invalid_input`.
  - «`updateCase` incrementa la revisión en 1, emite `case-changed` y deja entradas en `changes` con `before` y `after`».
  - «baja de `kind_2` y alta de otro hijo → `kind_3`» (Review Focus 3).
  - «`person_in_use`»: con un campo `krankenkasse_praemie` en la variante `partner`, insertado con el método del almacén que añade la Tarea 8 o con SQL de prueba en el almacén, quitar `partner` lanza `person_in_use` y no cambia nada.
  - «dos instancias del mismo `dataDir` no corrompen»: queda fuera, porque el bloqueo de instancia única es de `main` (Tarea 11).
- [ ] **Paso 2:** ejecutar las pruebas. Resultado esperado: FALLA. **Paso 3:** implementar. **Paso 4:** `npx vitest run && npm run typecheck`. Resultado esperado: PASA.
- [ ] **Paso 5:** commit `feat(expediente): servicio con expedientes, personas y registro de cambios`.

### Task 7: Importación desde `inbox/` y recuperación

**Files:**
- Create: `apps/desktop/src/core/expediente/import.ts`
- Modify: `apps/desktop/src/core/expediente/service.ts`
- Modify: `apps/desktop/src/core/expediente/storage/case-store.ts`
- Test: `apps/desktop/src/core/expediente/__tests__/import.test.ts`

**Interfaces:**
- Consumes:
  - `manifestSchema` y `receiptSchema` (`@fodibo/contracts`), compilados con Ajv2020 y `ajv-formats`, como en `contracts/test`;
  - `originalName` (`core/transfer/inbox.ts`);
  - `MAX_FILE_BYTES` y `MAX_PACKAGE_BYTES`;
  - `BlobStore.put`.
- Produces en `ExpedienteService`:
  - `listImportable(): Promise<ImportablePackage[]>`.
    - `ImportablePackage = { packageId; deviceName; receivedAt; fileCount }`.
    - Incluye los directorios de `inboxDir` con forma de UUID, con `receipt.json` y sin fila en `imports`.
    - Va ordenado por `receivedAt`, del más reciente al más antiguo.
  - `importPackage(caseId, packageId): Promise<ImportResult>`.
    - `ImportResult = { status: 'imported' | 'already_imported'; documents: Array<{ documentId; sha256; name; outcome: 'nuevo' | 'existente' }> }`.
    - Sigue los pasos de §9. Si no entró ningún documento nuevo, no incrementa la revisión.
    - `already_imported` reconstruye `documents` desde `import_files`.
  - `recover(): Promise<{ removedTmp: number; removedOrphans: number; missing: string[] }>`:
    - borra `tmp/`;
    - borra los blobs que ningún documento referencia;
    - lista los `document_id` cuyo blob falta o tiene otro tamaño, que conserva en memoria para la Tarea 9.

- [ ] **Paso 1: escribir las pruebas que fallan.** El ayudante de prueba escribe un paquete en un `inboxDir` temporal con `manifest.json`, `receipt.json` y `files/<sha>`, y usa un PDF mínimo válido, un PNG y un JSON.
  - «paquete completo»:
    - 3 documentos `nuevo` en estado `pendiente_de_revision`;
    - `original_name` saneado;
    - `source_device = device_name`;
    - `revision +1`;
    - existen los 3 blobs;
    - `inbox/` queda intacto (mismos archivos y `mtime`).
  - «sin recibo»: lanza `package_incomplete` y la base no cambia; además, no aparece en `listImportable`.
  - «manifiesto inválido o `package_id` distinto del directorio»: `package_invalid`.
  - «reimportación»: devuelve `already_imported`, la misma revisión y el mismo número de filas de `documents`.
  - «el mismo hash en dos paquetes»: un documento, un blob, `outcome: 'existente'` en el segundo; si el segundo no aporta nada nuevo, la revisión no cambia.
  - «hash repetido dentro del paquete»: un documento y dos filas de `import_files` con ambos nombres.
  - «archivo alterado en `inbox/`»: `integrity_error`, sin filas nuevas y sin blob.
  - «enlace simbólico en `files/`»: `integrity_error`.
  - «paquete ya importado en otro expediente»: `package_in_other_case`, con `details: { caseId }`.
  - «fallo inyectado antes del `COMMIT`» (`hooks.beforeImportCommit` lanza):
    - no hay filas;
    - quedan blobs huérfanos;
    - un servicio nuevo sobre el mismo `dataDir` (`recover()`) los borra;
    - la reimportación da `imported`.
  - «dos `importPackage` simultáneos del mismo paquete» (`Promise.all`): uno `imported` y otro `already_imported`; un solo registro en `imports` (Review Focus 1).
  - «`recover` detecta un blob borrado»: su `document_id` aparece en `missing`.
- [ ] **Paso 2:** ejecutar las pruebas. Resultado esperado: FALLA. **Paso 3:** implementar. **Paso 4:** `npx vitest run && npm run typecheck`. Resultado esperado: PASA.
- [ ] **Paso 5:** commit `feat(expediente): importación idempotente desde inbox y recuperación al arrancar`.

### Task 8: Documentos y campos con evidencia

**Files:**
- Create: `apps/desktop/src/core/expediente/fields.ts` (vocabulario, claves y variantes)
- Modify: `apps/desktop/src/core/expediente/service.ts`
- Modify: `apps/desktop/src/core/expediente/storage/case-store.ts`
- Test: `apps/desktop/src/core/expediente/__tests__/fields.test.ts` y `__tests__/documents.test.ts`

**Interfaces:**
- Consumes: `normalizeValue` (Tarea 5) y `commitChange` (Tarea 6).
- Produces en `fields.ts`:
  - `keyFor(conceptId: string, variant: string): string`. Devuelve `conceptId` si `variant===''` y `` `${conceptId}_${variant}` `` en otro caso.
  - `splitKey(key: string, concepts): { conceptId: string; variant: string } | undefined`.
  - `checkVocabulary(concepts, personSlugs: string[], conceptId, variant): Concept`.
    - Lanza `invalid_input` si la combinación no es válida.
    - Reglas: un concepto sin `variants` exige `variant===''`; uno con `variants` exige un `slug` existente o `familie`.
- Produces en el servicio:
  - `setDocument(documentId, patch: { docType?: DocType; status?: 'pendiente_de_revision' | 'confirmado' | 'descartado' }): CaseView`. Sigue las transiciones de §7.1:
    - `confirmado` exige `doc_type`;
    - `descartado` con evidencias lanza `invalid_transition`, con `details: { fieldIds }`;
    - una transición no listada lanza `invalid_transition`.
  - `saveField(caseId, input: FieldInput): CaseView`.
    - `FieldInput = { fieldId?: string; conceptId: string; variant: string; valor: string | boolean; moneda?: string; evidence: Evidence[] }`.
    - Sin `fieldId` es un alta; si ya existe la combinación `(concepto, variante)`, lanza `invalid_input`.
    - Con `fieldId` es una corrección.
    - El resultado queda en estado `confirmado`.
    - El origen pasa a `usuario`, salvo que el campo estuviera `pendiente` y el valor y la moneda normalizados no cambien; en ese caso conserva su origen (invariante 8).
  - `proposeField(caseId, input: FieldInput & { origin: 'regla' | 'modelo' }): CaseView`.
    - Es solo del núcleo y no se expone por IPC.
    - Crea el campo en estado `pendiente`.
  - `deleteField(fieldId): CaseView`.
  - `listConcepts(): ConceptView[]` (`{ id; tipo; labels; variants: boolean; values?: string[] }` de `CONCEPTS`).
  - `fieldHistory(fieldId): Array<{ at; actor; action: 'create' | 'update' | 'delete'; before; after; revision }>`.
  - Las evidencias deben citar documentos del mismo expediente que no estén `descartado`. Hay como mucho 20, sin duplicados, y la página va de 0 a 9999. Si se incumple, lanza `invalid_input`.
  - Cada escritura llama a `commitChange` con `before` y `after`, que incluyen `tipo`, `valor`, `moneda`, `origin`, `status` y `evidence`.

- [ ] **Paso 1: escribir las pruebas que fallan**
  - Campos:
    - «concepto fuera del catálogo» → `invalid_input`;
    - «variante en un concepto sin variantes» → `invalid_input`;
    - «`krankenkasse_praemie` sin variante, o con `kind_9` inexistente» → `invalid_input`;
    - «`familie` válida».
  - «corregir dos veces deja tres entradas en el historial (alta y dos correcciones)», con `before` y `after` exactos y `actor: 'usuario:local'` (criterio 10).
  - «confirmar sin cambios un campo propuesto por regla conserva `origin: 'regla'`; corregirlo lo pasa a `usuario`».
  - «evidencia a un documento descartado o de otro expediente» → `invalid_input`.
  - «borrar un campo conserva su historial» (`fieldHistory` sigue devolviendo las entradas).
  - Documentos:
    - «`confirmado` sin tipo» → `invalid_transition`;
    - «descartar uno citado» → `invalid_transition` con los `fieldIds`;
    - «descartado → `pendiente_de_revision`»;
    - «reimportar un descartado no cambia su estado».
  - Fuera de `fields.test.ts`: «`splitKey(keyFor(c, v)) = {c, v}` para todos los conceptos del catálogo y las variantes `hauptperson`, `partner`, `kind_1` y `familie`».
- [ ] **Paso 2:** ejecutar las pruebas. Resultado esperado: FALLA. **Paso 3:** implementar. **Paso 4:** `npx vitest run && npm run typecheck`. Resultado esperado: PASA.
- [ ] **Paso 5:** commit `feat(expediente): documentos, campos con evidencia e historial de correcciones`.

### Task 9: Estado, aprobación y lectura para el agente

**Files:**
- Create: `apps/desktop/src/core/expediente/status.ts`
- Create: `apps/desktop/src/core/expediente/projection.ts`
- Create: `apps/desktop/src/core/expediente/approval.ts`
- Modify: `apps/desktop/src/core/expediente/service.ts`
- Test: `apps/desktop/src/core/expediente/__tests__/status.test.ts`
- Test: `__tests__/approval.test.ts`
- Test: `__tests__/invalidation.test.ts`

**Interfaces:**
- Produces:
  - `caseStatus(input: StatusInput, concepts): { status: 'incompleto' | 'revisable' | 'aprobado'; blockers: Blocker[]; warnings: Warning[] }`.
    - Es una función pura.
    - `StatusInput = { revision; persons; documents (con `available: boolean`); fields (con evidencias); lastApproval?: { caseRevision } }`.
    - `Blocker = { code: 'sin_campos' | 'documento_pendiente' | 'campo_pendiente' | 'concepto_desconocido' | 'evidencia_no_confirmada' | 'original_no_disponible'; entity: 'case' | 'document' | 'field'; id?: string }`.
    - `Warning = { code: 'sin_evidencia'; fieldId: string }`.
  - `buildContent(caseRow, fields, documents, concepts): ApprovalContent`. Tiene la forma `content` de §8.2:
    - `fields` = `Declaration`, solo con los campos confirmados;
    - `documents` = los confirmados, ordenados por `sha256`;
    - `evidence` va con la misma clave que `fields`.
  - `contentHash(content): string`, que es el SHA-256 hex de `canonical(content)`.
  - En el servicio:
    - `getCase` añade `status`, `blockers`, `warnings` y `lastApproval?: { approvalId; caseRevision; approvedAt; contentHash }`. El documento lleva `available: false` si figura en `missing` de `recover()` o si falló una lectura posterior.
    - `approve(caseId, expectedRevision): ApprovalSummary`. Sigue §8.1. Valida la instantánea con `loadDeclaration` y con `approvedDeclarationSchema`; si falla, lanza `ExpedienteError('storage_error')` con `details.reason='invalid_projection'` (fallo interno; nada se guarda). No incrementa la revisión. Aprobar dos veces la misma revisión devuelve la aprobación existente.
    - `approvedDeclaration(caseId): { declaration: Declaration; approvalId; caseRevision; approvedAt; contentHash }`. Lanza `no_approval`, `approval_stale` o `approval_corrupt` según §8.3. Lee solo `approvals.snapshot`, recalcula la huella y aplica `loadDeclaration`.

- [ ] **Paso 1: escribir las pruebas que fallan**
  - `status.test.ts`: un caso por bloqueo, cada uno aislado, más:
    - «sin bloqueos → `revisable`»;
    - «aprobación de la revisión actual → `aprobado`»;
    - «aprobación de una revisión anterior → `revisable` o `incompleto`»;
    - «campo confirmado sin evidencia → aviso, sin bloqueo»;
    - «documento citado y no disponible → `original_no_disponible`» (Review Focus 5).
  - `approval.test.ts`:
    - «`stale_revision` si la revisión esperada no es la actual».
    - «`blocked` devuelve la lista de bloqueos».
    - «la huella no depende del orden de inserción»: dos expedientes con los mismos campos, insertados en orden inverso, dan el mismo `content_hash`.
    - «la instantánea cumple el contrato y `content.fields` pasa `loadDeclaration`».
    - «`approvedDeclaration`»:
      - `no_approval` si nunca se aprobó;
      - `approval_stale` tras un cambio;
      - `approval_corrupt` si el snapshot se altera por SQL directo en la prueba. Para alterarlo hay que deshabilitar el disparador en una conexión aparte: es una manipulación simulada.
    - «propiedad de proyección»: 50 expedientes generados con semilla fija y combinaciones aleatorias de conceptos y variantes válidas → la proyección pasa `loadDeclaration` y sus claves son únicas y del catálogo (criterio 11).
  - `invalidation.test.ts`: recorre **todas** las operaciones de escritura sobre un expediente aprobado y comprueba que cada una lo saca de `aprobado` y que `approvedDeclaration` lanza `approval_stale`. Las operaciones son:
    - `updateCase` de metadatos;
    - alta, baja y cambio de rótulo de persona;
    - `importPackage` con un documento nuevo;
    - cada transición de `setDocument`;
    - `saveField` de alta y de corrección;
    - `deleteField`;
    - `proposeField`.
    - Además, `importPackage` sin documentos nuevos **no** la invalida (criterio 7).
- [ ] **Paso 2:** ejecutar las pruebas. Resultado esperado: FALLA. **Paso 3:** implementar. **Paso 4:** `npx vitest run && npm run typecheck`. Resultado esperado: PASA.
- [ ] **Paso 5:** commit `feat(expediente): estado derivado, aprobación con huella y lectura para el agente`.

### Task 10: IPC validado y protocolo `fodibo-doc:`

**Files:**
- Create: `apps/desktop/src/shared/expediente-ipc.ts`
- Create: `apps/desktop/src/main/expediente-ipc.ts`
- Create: `apps/desktop/src/main/doc-protocol.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/renderer/env.d.ts`
- Modify: `apps/desktop/src/core/expediente/service.ts`
- Test: `apps/desktop/src/main/__tests__/expediente-ipc.test.ts` y `apps/desktop/src/main/__tests__/doc-protocol.test.ts`

**Interfaces:**
- Produces en `shared/expediente-ipc.ts`:
  - Canales `CASE_CHANNELS`:
    - `case:list`, `case:create`, `case:update`, `case:get`, `case:concepts`;
    - `case:importable`, `case:import`;
    - `case:set-document`, `case:save-field`, `case:delete-field`, `case:field-history`;
    - `case:approve`, `case:show-document`;
    - `case:event`.
  - `type Result<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string; details?: unknown } }`.
  - `interface ExpedienteApi`, con los métodos de §10.3 devolviendo `Promise<Result<…>>` y `onEvent(cb): () => void`.
  - Los tipos de vista: `CaseView`, `CaseSummary`, `ConceptView = { id; tipo; labels; variants: boolean; values?: string[] }`, `ImportablePackage` e `ImportResult`. Se reexportan desde `core/expediente`.
- Produces en `main/expediente-ipc.ts`:
  - `registerExpedienteIpc(ipc: IpcMainLike, svc: ExpedienteFacade, opts: { showItemInFolder(path: string): void }): () => void`.
    - No importa `electron` en tiempo de ejecución, como `agent-ipc.ts`.
    - Cada canal tiene un esquema Ajv2020 con UUID en minúsculas, longitudes máximas y `additionalProperties: false`. Un fallo de validación devuelve `{ ok:false, error:{ code:'invalid_input' } }` **sin llamar al servicio**.
    - Un `ExpedienteError` se convierte en `{ ok:false, error:{ code, message, details } }`. Cualquier otra excepción da `storage_error` con un mensaje genérico, y la consola registra solo el código.
  - `ExpedienteFacade` es el subconjunto público de `ExpedienteService`, más `documentLocation(documentId): Promise<string>`.
    - `documentLocation` devuelve `inbox/<package_id>/originales/<nombre>` si existe, según el primer `import_files` del documento, el nombre saneado de `originales/` y el `originalName` de la transferencia. Si no, devuelve `BlobStore.pathOf`.
- Produces en `main/doc-protocol.ts`:
  - `DOC_SCHEME = 'fodibo-doc'`.
  - `serveDocument(svc, url: string, rangeHeader: string | null): Promise<Response>`, una función pura sobre `Response` de la web.
    - Acepta solo `fodibo-doc://doc/<uuid>`; todo lo demás da 404.
    - Busca el documento y ejecuta `BlobStore.verify`. Si la verificación falla, responde 409 con cuerpo vacío y marca el documento como no disponible en memoria. Si no hay blob, 404.
    - Responde con `Content-Type` = `mime`, `X-Content-Type-Options: nosniff`, `Accept-Ranges: bytes` y `Cache-Control: no-store`.
    - Con `Range: bytes=a-b`, responde 206 con `Content-Range`. Un rango imposible da 416.
  - `registerDocProtocol(ses: Session, svc)`, que usa `ses.protocol.handle(DOC_SCHEME, …)`.
  - El esquema se declara privilegiado (`standard`, `secure`, `supportFetchAPI`, `stream`) **en la misma llamada** de `protocol.registerSchemesAsPrivileged` que `PORTAL_SCHEME`, porque Electron solo admite una llamada.
  - Hay que modificar `main/portal/protocol.ts` para que `registerPortalScheme` registre ambos esquemas, o extraer una función común.
- Preload: `contextBridge.exposeInMainWorld('fodiboExpediente', api)`.

- [ ] **Paso 1: escribir las pruebas que fallan**
  - `expediente-ipc.test.ts`, con `ipcMain` simulado y un servicio falso que registra las llamadas:
    - para cada canal, un argumento mal formado no llega al servicio y devuelve `invalid_input`. Casos: UUID en mayúsculas o con `../`, propiedad extra, `valor` de 10 000 caracteres, 21 evidencias y `page: -1`;
    - una llamada válida devuelve `{ ok:true, value }`;
    - un `ExpedienteError('person_in_use')` se convierte en `{ ok:false, error:{ code:'person_in_use', … } }`;
    - un error genérico da `storage_error` y su mensaje no se filtra al renderer.
  - `doc-protocol.test.ts`, con el servicio real sobre un directorio temporal y un PDF importado:
    - 200 con `Content-Type: application/pdf` y `nosniff`;
    - un `Range: bytes=0-9` da 206 con 10 bytes;
    - `fodibo-doc://doc/../../etc/passwd`, `fodibo-doc://otro/<uuid>` y un UUID inexistente dan 404;
    - un blob alterado da 409;
    - un blob borrado da 404 y el siguiente `getCase` lo marca `available:false` (Review Focus 5).
- [ ] **Paso 2:** ejecutar las pruebas. Resultado esperado: FALLA. **Paso 3:** implementar. **Paso 4:** `npx vitest run && npm run typecheck`. Resultado esperado: PASA.
- [ ] **Paso 5:** commit `feat(expediente): IPC validado con Ajv y protocolo fodibo-doc para el visor`.

### Task 11: `main` y el agente usan la versión aprobada

**Files:**
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/main/portal/agent-ipc.ts`
- Modify: `apps/desktop/src/shared/agent-ipc.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/renderer/components/AgentPanel.tsx`
- Test: `apps/desktop/src/main/portal/__tests__/agent-ipc.test.ts`
- Test: `apps/desktop/src/renderer/__tests__/AgentPanel.test.tsx`

**Interfaces:**
- Consumes: `ExpedienteService.approvedDeclaration` y `on` (Tareas 6 y 9), `registerExpedienteIpc` y `registerDocProtocol` (Tarea 10).
- Produces:
  - En `AgentDeps`: `loadDeclaration(caseId: string): { declaration: Declaration; approval?: { caseId; caseRevision; approvedAt; contentHash } }`.
    - Cambia la firma actual; actualizar las pruebas existentes.
  - `AgentController.start(caseId: string)`.
  - `AgentController.onCaseChanged(caseId: string): void`. Si hay una ejecución en curso con ese `caseId`, emite un `log` con el texto exacto `El expediente cambió: llenado detenido` y llama a `stop()`. Con otro `caseId` no hace nada.
  - `AgentApi.start(caseId: string)`. `registerAgentIpc` valida que `caseId` sea un UUID en minúsculas; si no lo es, rechaza con el mensaje de `no_approval`.
  - `AgentUiEvent` añade `{ type: 'declaration'; caseId; caseRevision; approvedAt; contentHash }`. Se emite justo después de cargar la declaración.
  - Los mensajes de §11 van como texto exacto, en un mapa `APPROVAL_MESSAGES` de `agent-ipc.ts`:
    - `no_approval` → «No hay ninguna versión aprobada del expediente. Revísalo y apruébalo antes de rellenar el portal.»;
    - `approval_stale` → «El expediente cambió después de la aprobación. Vuelve a aprobarlo.»;
    - `approval_corrupt` → «La versión aprobada no supera la comprobación de integridad.»;
    - `not_found` → mismo texto que `no_approval`.
- `main/index.ts`:
  - `const dataDir = process.env['FODIBO_DATA_DIR'] || app.getPath('userData')`, para `TransferService` y para el expediente.
  - `app.requestSingleInstanceLock()` solo en `startApp()`. Si no se obtiene, `app.quit()`. En `second-instance`, enfoca la ventana.
  - En `ready`, ejecuta `ExpedienteService.open({ dataDir, inboxDir: join(dataDir,'inbox') })`. Si falla, el IPC `case:*` responde `storage_error`, con `details.backup` igual a la ruta de la copia más reciente de `backups/` si existe, y transferencia y portal siguen funcionando.
  - `svc.on(e => { emitir CASE_CHANNELS.event; agent.onCaseChanged(e.caseId) })`.
  - `registerDocProtocol(session.defaultSession, svc)`.
  - `close()` en `shutdown`.
  - `--bench` y `--selftest-adapter` no cambian: siguen leyendo `declaracion.json` y no adquieren el bloqueo.
- `AgentPanel`:
  - recibe la propiedad `caseId?: string`;
  - «Iniciar» llama a `start(caseId)` o, sin expediente activo, muestra el mensaje de `no_approval`;
  - muestra «Expediente · revisión N · fecha · huella (12 caracteres)» al recibir `declaration`.

- [ ] **Paso 1: escribir las pruebas que fallan** en `agent-ipc.test.ts`:
  - «arranca con aprobación vigente y emite `declaration` antes de `model`».
  - «sin aprobación no arranca»: `loadDeclaration` lanza `ExpedienteError('no_approval')` → evento `state:error` con el texto exacto; `llama.start` no se llama; no hay `attach`.
  - «`approval_stale` y `approval_corrupt`» → sus textos.
  - «`onCaseChanged` del mismo expediente detiene una ejecución en curso (`hang: true`), emite el `log` exacto y termina `detenido`; uno de otro expediente no la detiene» (Review Focus 4).
  - «`agent:start` con `caseId` no válido rechaza sin llamar a `loadDeclaration`».
  - En `AgentPanel.test.tsx`: «sin `caseId`, Iniciar muestra el mensaje» y «muestra la huella abreviada al recibir `declaration`».
- [ ] **Paso 2:** ejecutar las pruebas. Resultado esperado: FALLA. **Paso 3:** implementar. **Paso 4:** `npx vitest run && npm run typecheck && npm run build`. Resultado esperado: PASA.
- [ ] **Paso 5:** commit `feat(expediente): main abre el expediente y el agente solo usa versiones aprobadas`.

### Task 12: Pestaña «Expediente»: expedientes, documentos, campos y aprobación

**Files:**
- Create: `apps/desktop/src/renderer/components/expediente/ExpedienteTab.tsx`, `CaseHeader.tsx`, `NewCaseForm.tsx`, `DocumentList.tsx`, `FieldList.tsx`, `FieldForm.tsx`, `ApproveDialog.tsx` y `labels.ts` (rótulos en español de estados, tipos de documento, códigos de bloqueo y de error)
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/renderer/components/PackageCard.tsx` (botón «Importar al expediente»)
- Modify: `apps/desktop/src/renderer/styles.css`
- Test: `apps/desktop/src/renderer/__tests__/Expediente.test.tsx` (jsdom, con `window.fodiboExpediente` falso)

**Interfaces:**
- Consumes: `ExpedienteApi` y sus tipos (Tarea 10).
- Produces:
  - `App` guarda `activeCaseId`, recordado en `localStorage` (`fodibo.activeCaseId`) dentro de `try/catch`, y lo pasa a `ExpedienteTab` y a `AgentPanel`.
  - `ExpedienteTab({ caseId, onSelectCase, selectedDocumentId, onSelectDocument })`. El visor de la Tarea 13 se monta en el hueco central con `selectedDocumentId` y `page`.
- Decisiones de interfaz:
  - Formularios con estado React propio; no se añaden React Hook Form ni React Aria. Los controles son nativos con `<label>` y `aria-describedby` para los errores. Es una decisión permitida por §17; el coste es más código de formulario.
  - El buscador de concepto es un `<input list>` con `<datalist>` de `id — etiqueta alemana`.

- [ ] **Paso 1: escribir las pruebas que fallan**
  - «crear un expediente con titular y seleccionarlo».
  - «añadir campo con importe mal formado muestra el error del núcleo junto al control (`invalid_input`) y no cierra el formulario».
  - «el diálogo de aprobación lista clave, valor y evidencias»:
    - con avisos exige marcar la casilla antes de habilitar «Aprobar»;
    - con bloqueos el botón está deshabilitado y se lista el motivo.
  - «editar un expediente aprobado avisa de que anula la aprobación antes de enviar el primer cambio».
  - «`activeCaseId` recordado que no existe en `listCases` → sin expediente seleccionado, sin errores» (Review Focus 2).
  - «importar desde la lista de paquetes sin importar refresca documentos y revisión».
  - «pulsar una evidencia selecciona su documento y su página».
- [ ] **Paso 2:** ejecutar las pruebas. Resultado esperado: FALLA. **Paso 3:** implementar §10.1, salvo el visor. **Paso 4:** `npx vitest run && npm run typecheck`. Resultado esperado: PASA.
- [ ] **Paso 5:** commit `feat(expediente): pestaña de revisión con documentos, campos y aprobación`.

### Task 13: Visor mínimo y CSP

**Files:**
- Create: `apps/desktop/src/renderer/components/expediente/DocumentViewer.tsx`
- Modify: `apps/desktop/package.json` (`pdfjs-dist` en versión exacta)
- Modify: `apps/desktop/electron.vite.config.ts` (CSP)
- Test: `apps/desktop/src/renderer/__tests__/DocumentViewer.test.tsx`

**Interfaces:**
- Consumes: `fodibo-doc://doc/<id>` (Tarea 10) y `showDocument` (IPC).
- Produces: `DocumentViewer({ document: { documentId; mime }, page?: number })`.

- [ ] **Paso 1: dependencia.** Elegir la última versión de `pdfjs-dist` 5.x publicada hace al menos dos semanas (`npm view pdfjs-dist time --json`) e instalarla con `npm i -w @fodibo/desktop --save-exact pdfjs-dist@<v>`.
  - Comprobar que no tiene scripts de instalación (`npm view pdfjs-dist@<v> scripts`).
  - Anotar la versión en el README.
- [ ] **Paso 2: escribir las pruebas que fallan**, con PDF.js simulado mediante `vi.mock('pdfjs-dist')`:
  - «PDF: navega con anterior/siguiente, no pasa de la última página y abre en la `page` de la evidencia»;
  - «imagen → `<img src="fodibo-doc://doc/<id>">`»;
  - «HEIC → aviso y botón “Mostrar en la carpeta”»;
  - «JSON → `<pre>` truncado a 262 144 bytes, con indicación de que está truncado».
- [ ] **Paso 3: implementar**
  - `getDocument({ url, isEvalSupported: false, disableAutoFetch: true, disableFontFace: true })`, sin `standardFontDataUrl` ni CMaps remotos.
  - El worker se importa con `?url` desde `pdfjs-dist/build/pdf.worker.min.mjs`, de modo que Vite lo emite como recurso local.
  - El zoom va de 50 % a 300 %, con el mismo control para imágenes.
- [ ] **Paso 4: CSP de compilación** en `electron.vite.config.ts`:
  - `default-src 'self'; script-src 'self'; img-src 'self' data: fodibo-doc:; connect-src 'self' fodibo-doc:; worker-src 'self'; object-src 'none'; base-uri 'none'`.
  - El servidor de desarrollo sigue sin CSP, como hoy.
- [ ] **Paso 5:** `npx vitest run && npm run typecheck && npm run build`. Resultado esperado: PASA. Después, `npm run dev`, abrir un PDF importado en la pestaña y comprobar en la consola que no hay errores de CSP ni peticiones fuera de `fodibo-doc:` y `'self'`.
- [ ] **Paso 6:** commit `feat(expediente): visor PDF.js local y CSP del renderer`.

### Task 14: Expediente de prueba, equivalencia con el prototipo y documentación

**Files:**
- Create: `apps/desktop/src/core/expediente/seed.ts`, con la función `seedFromDeclaration(svc, decl: Declaration, opts: { taxYear: number; jurisdiction: Canton; label: string }): Promise<{ caseId: string }>`. Crea el expediente con una `hauptperson`, traduce cada clave con `splitKey`, guarda los campos y aprueba.
- Create: `apps/desktop/scripts/seed-expediente.ts`, que se ejecuta con `tsx`, lee `FODIBO_DATA_DIR` (por defecto `./.dev-data`) e imprime el `caseId`.
- Modify: `apps/desktop/package.json` (script `"seed:expediente": "tsx scripts/seed-expediente.ts"`)
- Modify: `README.md`
- Test: `apps/desktop/src/core/expediente/__tests__/equivalence.test.ts`

- [ ] **Paso 1: escribir las pruebas que fallan**
  - «la proyección aprobada es estrictamente igual a `loadDeclaration(declaracion.json)`», con `toStrictEqual`; incluye `krankenkasse_praemie_hauptperson` y `_familie` (criterio 2).
  - «con esa proyección, `resolveFromCatalog` resuelve los 17 campos del portal como indica `esperado.json`». Reutiliza el ayudante de `catalog.test.ts` extrayéndolo a `src/core/agent/__tests__/portal-fields.ts`.
- [ ] **Paso 2:** ejecutar las pruebas. Resultado esperado: FALLA. **Paso 3:** implementar. **Paso 4:** ejecutar las pruebas. Resultado esperado: PASA. Después, `FODIBO_DATA_DIR=$(mktemp -d) npm run seed:expediente`: imprime un UUID.
- [ ] **Paso 5: README.** Añadir una sección «Expediente» con:
  - qué hace y dónde guarda (`expediente/fodibo.db`, `blobs/` y `backups/`);
  - **los datos están en claro hasta la ronda de cifrado**;
  - el binding `node:sqlite` y por qué no cumple aún el criterio de SQLCipher;
  - la versión de `pdfjs-dist`;
  - `seed:expediente`;
  - que el agente ya no lee `declaracion.json` fuera de `--bench` y `--selftest-adapter`.
- [ ] **Paso 6:** `npx vitest run && npm run typecheck && npm test -w @fodibo/contracts`, y `npm run bench` si el modelo está disponible en `FODIBO_MODEL`; si no, anotarlo como omitido. Resultado esperado: todo PASA y el banco da el mismo resultado (criterio 15).
- [ ] **Paso 7:** commit `feat(expediente): expediente de prueba, equivalencia con la declaración y documentación`.

### Task 15: Verificación de aceptación (manual, con el usuario)

No es tarea de un subagente: la conduce quien coordina, con el móvil real del usuario.

- [ ] Ejecutar `npm run dev` con `FODIBO_DATA_DIR` vacío, enviar desde el móvil un PDF, una foto y un JSON, e importarlos. En el visor, revisar cada uno, asignar tipo, introducir campos con evidencia y aprobar. Iniciar el portal, que debe rellenarse con esos valores (criterios 1 y 8; ver primero el mensaje sin aprobación).
- [ ] Cambiar un campo con el llenado en curso: el agente se detiene; «Iniciar» muestra `approval_stale` (criterio 7).
- [ ] Matar la app (`kill -9`) durante una importación de un paquete grande y volver a arrancar: no quedan temporales ni huérfanos, y la reimportación es correcta (criterio 4).
- [ ] Alterar a mano un blob (`chmod u+w` y editarlo): el visor muestra el error de integridad (criterio 5).
- [ ] Con la red desconectada, el flujo completo funciona. Con red, `nettop -p <pid>` o Little Snitch no muestran conexiones salientes (criterio 14).
