# Expediente (primera versión) — Diseño

**Fecha:** 12 de noviembre de 2026
**Estado:** aprobada por el usuario el 12 de noviembre de 2026 (preguntas de §19 resueltas con las propuestas)
**Referencia:** `docs/system/FODIBO_Arquitectura_actualizada.md` (v2.1), §2, §3, §4.2, §4.4, §5, §7, §8 y §9
**Specs relacionadas:** `2026-11-10-prototipo-transferencia-movil-pc-design.md` y `2026-11-10-prototipo-agente-navegador-design.md`

Las decisiones marcadas **«Decisión del autor»** son propuestas de este diseño; el resto viene decidido por el usuario o por la arquitectura.

## 1. Intención

Hoy existen dos prototipos que no se tocan: la transferencia deja paquetes verificados en `<userData>/inbox/<package_id>/` y el agente navegador rellena el portal a partir de `apps/desktop/test-portal/declaracion.json`, un fichero escrito a mano. El expediente es la pieza que los une:

```
móvil → PC (inbox) → importar al expediente → revisar y completar campos con evidencia → aprobar → el agente rellena el portal
```

Corresponde al paso (1) del orden de entrega de la arquitectura («contrato, expediente, importación cifrada y revisión»), sin el cifrado, que es la ronda siguiente (§16).

El motivo de hacerlo ahora es fijar el modelo de datos sobre el que se apoyará todo lo demás (extracción, análisis, motor fiscal, sincronización) y sustituir la declaración escrita a mano por una **versión aprobada**, inmutable y con huella, que es lo único que el agente puede consumir según §2 y §7 de la arquitectura.

## 2. Objetivos, no-objetivos y anti-objetivos

**Objetivos**

1. Crear un expediente (ejercicio, jurisdicción, contribuyentes) y persistirlo en SQLite detrás de una capa de almacenamiento propia.
2. Importar al expediente paquetes completos de `inbox/`, con originales inmutables direccionados por SHA-256 e idempotencia por `package_id` y hash.
3. Revisar en la app: lista de documentos, visor, y alta y corrección manual de campos con su evidencia (documento y página), con validación por tipo e historial de correcciones.
4. Aprobar: crear una instantánea inmutable con huella de contenido cuya proyección es exactamente el formato `Declaration` del agente.
5. El agente navegador usa la versión aprobada vigente; si no la hay, no arranca. Un cambio posterior invalida la aprobación.
6. El núcleo del expediente queda aislado de Electron y de React, como `core/transfer` y `core/agent`.

**No-objetivos** (quedan para incrementos posteriores)

- Cifrado en reposo (SQLCipher, libsodium, almacén seguro de claves): siguiente ronda, §16.
- Extracción automática (OCR, extractores por tipo como el Lohnausweis), agente de análisis y motor fiscal.
- Transporte `.fodibo`, edición de campos en el móvil y resolución de conflictos de revisiones con el móvil (§5.3).
- Adjuntar documentos al portal (`adjuntarDocumento`) y persistencia de la sesión del portal.
- Exportar el expediente, copias de seguridad con restauración y borrado físico de expedientes o documentos.
- Búsqueda de texto (FTS5), paquetes normativos y `rules_version` (la columna existe, siempre `NULL`).
- Varios importes del mismo concepto y persona (p. ej. dos empleadores): un valor con varias evidencias (§6.4).

**Anti-objetivos** (harían fracasar esta versión aunque «funcione»)

- Que el agente rellene el portal con datos que no proceden de una aprobación vigente.
- Que un cambio en el expediente deje viva una aprobación anterior.
- Que reimportar un paquete duplique documentos, o que una interrupción pierda algo ya confirmado.
- Que un original cambie o se pierda después de importado.
- Que un valor con origen «regla» o «modelo» llegue a la declaración sin confirmación del usuario.
- Que aparezcan claves fiscales en español o fuera del catálogo.
- Que algún dato salga del equipo, o que un nombre de archivo o un dato del renderer acabe formando una ruta.
- Que el resto del código dependa del binding de SQLite y el paso a SQLCipher obligue a reescribirlo.

## 3. Decisiones de construcción

| Decisión | Valor | Origen |
| --- | --- | --- |
| Persistencia | SQLite detrás de una interfaz de almacenamiento propia; binding a elegir con los criterios de §4.3 | Usuario |
| Cifrado en reposo | Fuera de esta versión; diseño preparado (§16) | Usuario |
| Vocabulario fiscal | Ids del catálogo `CONCEPTS` (`bruttolohn_jahr`…); español solo en la interfaz | Usuario |
| Originales | Inmutables, direccionados por SHA-256; importación idempotente por `package_id` y hash | Usuario |
| Valores de los campos | Los introduce el usuario; el modelo admite ya origen `regla`, `modelo` y `usuario` | Usuario |
| Aprobación | Instantánea inmutable con huella; proyección = `Declaration`; un cambio la invalida | Usuario y arquitectura §3 |
| Unidad del expediente | Un expediente por hogar fiscal (unidad de tributación conjunta), ejercicio y cantón | Decisión del autor · pregunta 1 |
| Momento de la importación | Acción explícita del usuario por paquete | Decisión del autor · pregunta 2 |
| Estado del expediente | Derivado, no almacenado: se calcula de los datos y de la última aprobación (§7.2) | Decisión del autor |
| Invalidación | Contador `revision` del expediente; la aprobación vale solo si su revisión es la actual | Decisión del autor |
| Historial | Una tabla `changes` de solo inserción para todas las entidades; el historial de correcciones de un campo es su filtro | Decisión del autor |
| Almacén de originales | Copia propia en `expediente/blobs/`, independiente de `inbox/` (sin enlaces duros) | Decisión del autor |
| Evidencia | De cero a varias por campo; no bloquea la aprobación, pero se avisa y se pide confirmación | Decisión del autor · pregunta 3 |
| Estado `descartado` del documento | Añadido a los de la arquitectura para excluir un archivo sin borrar el original | Decisión del autor |
| Visor | PDF.js con recursos locales en su forma mínima (§10.2) | Arquitectura §8; alcance, decisión del autor |
| Declaración de desarrollo | `declaracion.json` solo en `--bench` y `--selftest-adapter`; la app normal usa el expediente | Decisión del autor |
| Contrato de la aprobación | Esquema JSON y vectores nuevos en `packages/contracts` | Decisión del autor |

**Nota sobre la spec del agente.** Su §4.1 describe claves en español (`salario_bruto`); el código actual ya usa los ids del catálogo suizo. Esta spec sigue al código y sustituye a esa sección en ese punto.

## 4. Arquitectura

### 4.1 Módulos

```
apps/desktop/src/
  core/expediente/              ← TypeScript sobre Node; no importa electron ni react
    storage/                    ← único sitio con SQL y con el binding: esquema, migraciones, BlobStore
    service.ts                  ← casos de uso (crear, importar, editar, aprobar); una cola serializa las escrituras
    import.ts                   ← importación desde inbox/
    status.ts                   ← estado derivado y lista de bloqueos
    projection.ts, approval.ts  ← proyección a Declaration, instantánea y huella
    validation.ts               ← normalización y validación de valores por tipo
  main/expediente-ipc.ts        ← controlador IPC (ipcMain inyectado, como agent-ipc.ts) y protocolo del visor
  shared/expediente-ipc.ts      ← canales y tipos de la API
  preload/index.ts              ← expone window.fodiboExpediente
  renderer/components/expediente/
packages/contracts/schemas/approved-declaration.schema.json  (+ vectores)
```

Dependencias: `core/expediente` lee de `core/agent` el catálogo y los tipos `Declaration`/`DeclEntry`, y de `core/transfer` los tipos del manifiesto y `sniffOk`. `core/agent` no conoce el expediente: `main` los conecta. La validación por tipo que hoy es privada en `declaration.ts` (`validateEntry`, fecha, IBAN, importe) se exporta y se reutiliza, de modo que expediente y agente apliquen una sola regla; `loadDeclaration` conserva su comportamiento.

### 4.2 Datos en disco

```
<userData>/
  inbox/<package_id>/…           ← sin cambios; la transferencia sigue siendo su dueña
  expediente/
    fodibo.db (+ -wal, -shm)     ← SQLite
    blobs/<aa>/<sha256>          ← originales; <aa> = dos primeros hex del hash; solo lectura
    blobs/tmp/<uuid>.part        ← copias en curso
    backups/                     ← copia de la base previa a cada migración
```

Con el servidor de desarrollo, lo mismo bajo `FODIBO_DATA_DIR`. `inbox/` no se borra ni se modifica al importar (**Decisión del autor**: se duplica espacio a cambio de no tocar la transferencia; la purga de `inbox/` se decide en la ronda de cifrado, cuando dejar copias en claro deje de ser aceptable).

### 4.3 Capa de almacenamiento

Dos interfaces; el resto del núcleo no ve SQL, rutas ni el binding:

- **`CaseStore`**: métodos por caso de uso de lectura y escritura más `transaction(fn)` **síncrona**. Se abre con `openStore({ dir, key? })`; `key` no se usa todavía.
- **`BlobStore`**: `has(sha256)`, `put(origen, { sha256, size })`, `open(sha256, rango?)`, `remove(sha256)`, `list()`. La clave es siempre el SHA-256 del contenido **en claro**, también cuando el contenido se cifre.

Configuración de SQLite: `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`, tablas `STRICT`, sentencias siempre preparadas. Versión del esquema en `PRAGMA user_version`; migraciones solo hacia delante, cada una en una transacción y precedida de una copia de la base en `backups/` (arquitectura §7). Si la base es de una versión posterior a la app, no se abre.

Una sola instancia: `main` debe adquirir `app.requestSingleInstanceLock()` (hoy no lo hace) para que dos procesos no abran la misma base.

**Elección del binding (a cargo del implementador).** Criterios, en este orden:

1. Carga y funciona con la versión de Electron del repositorio (`45.2.3`) en macOS, y también con el Node del sistema (≥ 22) con el que corre Vitest; si es un módulo nativo, hay que resolver las dos ABI.
2. Transacciones síncronas (la importación y la aprobación son una única transacción sin `await` en medio).
3. Camino a SQLCipher sin tocar nada fuera de `storage/`: un binding compatible con la misma API o un sustituto directo.
4. Empaquetado: recompilación o binarios precompilados reproducibles con versiones fijadas; sin descargas en tiempo de ejecución.

Si ningún candidato cumple a la vez el 1 y el 3, gana el 1 y el cambio de binding se hace en la ronda de cifrado: para eso existe la interfaz. El resultado de esta evaluación se anota en el README.

## 5. Modelo de datos

Identificadores UUID v4 en minúsculas; instantes en UTC ISO 8601; fechas documentales `AAAA-MM-DD`; importes como texto decimal, nunca `REAL`. La base no es formato de intercambio (arquitectura §3).

### 5.1 Tablas

| Tabla | Columnas | Claves y restricciones |
| --- | --- | --- |
| `cases` | `case_id`, `tax_year` (entero), `jurisdiction` (código de cantón, `ZH`…), `rules_version` (`NULL`), `revision` (entero ≥ 0), `created_at` | PK `case_id`; puede haber varios expedientes del mismo ejercicio y cantón |
| `persons` | `person_id`, `case_id`, `role`, `ordinal`, `slug`, `label` | PK `person_id`; FK `case_id`; `role ∈ {hauptperson, partner, kind}`; `UNIQUE(case_id, slug)`; exactamente una `hauptperson` y como mucho un `partner` por expediente |
| `documents` | `document_id`, `case_id`, `sha256`, `mime`, `size`, `original_name`, `doc_type` (nulo), `status`, `source_device`, `imported_at` | PK `document_id`; FK `case_id`; `UNIQUE(case_id, sha256)`; `status ∈ {capturado, extraido, pendiente_de_revision, confirmado, descartado}`; `mime` ∈ los cinco tipos de la transferencia |
| `imports` | `package_id`, `case_id`, `imported_at`, `device_name`, `manifest_sha256` | PK `package_id` (un paquete pertenece a un solo expediente); FK `case_id` |
| `import_files` | `package_id`, `file_id`, `document_id`, `name` | PK `(package_id, file_id)`; FK a `imports` y `documents` |
| `fields` | `field_id`, `case_id`, `concept_id`, `variant` (texto, `''` si no aplica), `tipo`, `valor`, `moneda` (nulo), `origin`, `status`, `updated_at` | PK `field_id`; FK `case_id`; `UNIQUE(case_id, concept_id, variant)`; `origin ∈ {regla, modelo, usuario}`; `status ∈ {pendiente, confirmado}`; `tipo` ∈ `DeclType`; `moneda` no nula si y solo si `tipo = 'amount'` |
| `field_evidence` | `field_id`, `document_id`, `page` (entero, `0` = documento entero) | PK `(field_id, document_id, page)`; FK a `fields` (borrado en cascada) y a `documents` |
| `changes` | `change_id` (autoincremental), `case_id`, `revision`, `at`, `actor`, `entity`, `entity_id`, `action`, `before` (JSON, nulo), `after` (JSON, nulo) | Solo inserción: disparadores que abortan `UPDATE` y `DELETE`; `entity ∈ {case, person, document, field, import, approval}` |
| `approvals` | `approval_id`, `case_id`, `case_revision`, `approved_at`, `approver`, `content_hash`, `snapshot` (JSON canónico) | PK `approval_id`; `UNIQUE(case_id, case_revision)`; inmutable por disparadores |

Notas:

- `documents.status` admite desde ya `capturado` y `extraido` para que la extracción futura no requiera migrar; esta versión no los escribe.
- `persons.slug` es `hauptperson`, `partner` o `kind_<ordinal>`; es estable y no se reutiliza. `label` es solo un rótulo de interfaz («Anna»): los datos personales (`nachname`, `vorname`, `geburtsdatum`, `ahv_nr`, `zivilstand`) son campos, no columnas.
- `doc_type` usa términos suizos; lista inicial cerrada (**Decisión del autor**): `lohnausweis`, `bankbeleg`, `krankenkasse`, `saeule_3a`, `quittung`, `sonstiges`. La interfaz los rotula en español.
- `actor` es `usuario:local` en esta versión; más adelante, `dispositivo:<id>`, `regla:<id>` o `modelo:<id>`.
- El texto OCR, la posición dentro de la página y `FTS5` llegarán por migración con tablas nuevas; no se reservan columnas.

### 5.2 Invariantes

1. **Originales.** Por cada fila de `documents` existe `blobs/<aa>/<sha256>` cuyo SHA-256 y tamaño coinciden. Ninguna operación modifica ni sobrescribe un blob.
2. **Sin duplicados.** Un mismo contenido es un único documento por expediente (`UNIQUE(case_id, sha256)`), venga en uno o en varios paquetes.
3. **Revisión.** Toda transacción que cambia el contenido del expediente (metadatos, personas, documentos, campos, evidencias) incrementa `cases.revision` exactamente en 1 y escribe sus filas en `changes` con esa revisión. Aprobar no la incrementa.
4. **Historial.** Cada alta, corrección, confirmación o baja de un campo deja en `changes` actor, fecha, valor anterior y nuevo (`before`/`after` con `tipo`, `valor`, `moneda`, `origin`, `status` y evidencias). Borrar un campo elimina la fila de `fields` y conserva su historial.
5. **Vocabulario.** `concept_id` existe en el catálogo y `fields.tipo` es el `tipo` de ese concepto; `variant` es `''` si el concepto no tiene `variants`, y en otro caso el `slug` de una persona del expediente o `familie`. Se comprueba en el núcleo al escribir y de nuevo al aprobar (el catálogo vive en el código, no en la base).
6. **Valores canónicos.** `valor` se guarda ya normalizado (§6.3); lo guardado siempre pasa `validateEntry`.
7. **Aprobación.** `content_hash` es el SHA-256 del contenido de `snapshot` (§8.2). Una aprobación está **vigente** si y solo si `approvals.case_revision = cases.revision`.
8. **Confirmación humana.** Solo los campos `confirmado` entran en la proyección. Un campo con origen `regla` o `modelo` nace `pendiente`; si el usuario lo confirma sin cambios conserva su origen, y si lo corrige pasa a `usuario`.

### 5.3 Por qué basta este modelo de revisiones por ahora

El escritorio es el único que escribe: el móvil solo aporta documentos nuevos, que son inmutables y se identifican por hash, así que añadirlos es idempotente y no puede entrar en conflicto con nada. Un contador de revisión por expediente más el registro `changes` ordenado ya da lo que la arquitectura pide para más adelante: una «revisión base» contra la que comparar los cambios del móvil y los valores anterior y nuevo de cada corrección para conservar ambas versiones en un conflicto. Cuando el móvil envíe cambios, se añadirá la revisión base al paquete y la detección de conflictos por entidad; ninguna tabla de esta versión tendrá que rehacerse.

## 6. Campos, catálogo, personas y variantes

### 6.1 Catálogo como vocabulario

El catálogo `CONCEPTS` de `catalog.ts` es la única lista de conceptos que la interfaz ofrece y que el núcleo acepta. Un campo cuyo concepto deje de existir en el catálogo se muestra como «concepto desconocido» y bloquea la aprobación.

Dos cambios aditivos en el catálogo (**Decisión del autor**), que no alteran el comportamiento del agente:

- `values?: string[]` en los conceptos `enum`, con los valores suizos admitidos. Para `zivilstand`, los mismos que ofrece el portal de prueba: `ledig`, `verheiratet`, `geschieden`, `verwitwet`, `eingetragene Partnerschaft`.
- Una prueba que garantice que ningún id de concepto empieza por `<id>_` de un concepto con `variants`, para que una clave proyectada no pueda leerse de dos maneras.

### 6.2 Personas y variantes

La clave de un campo en la declaración es `concept_id` si `variant = ''` y `<concept_id>_<variant>` en otro caso.

| Situación del concepto | `variant` permitido | Clave proyectada |
| --- | --- | --- |
| Sin `variants` (p. ej. `bruttolohn_jahr`) | Solo `''`; el dato se entiende de la `hauptperson` o del hogar | `bruttolohn_jahr` |
| Con `variants` (hoy solo `krankenkasse_praemie`) | Obligatorio: `hauptperson`, `partner`, `kind_<n>` (personas existentes) o `familie` (el hogar en conjunto) | `krankenkasse_praemie_hauptperson`, `…_familie` |

Consecuencias:

- El ejemplo `test-portal/declaracion.json` se reproduce tal cual: una `hauptperson` y dos campos de `krankenkasse_praemie` con variantes `hauptperson` y `familie`.
- Los datos propios de la pareja en conceptos sin `variants` (segundo salario, su `ahv_nr`) **no se pueden expresar todavía**. Para admitirlos basta marcar el concepto con `variants: true` en el catálogo: el esquema y la proyección ya lo soportan, pero cambia cómo el agente resuelve esos campos (deja pendiente si hay varias variantes), así que es una decisión de producto (pregunta 5).
- No se puede eliminar una persona mientras algún campo use su `slug` como variante.

### 6.3 Validación y forma canónica por tipo

| `tipo` | Entrada admitida en la interfaz | Forma guardada |
| --- | --- | --- |
| `text` | Texto no vacío tras recortar, NFC, hasta 200 caracteres, sin caracteres de control | Tal cual, recortado |
| `date` | Selector de fecha o `DD.MM.AAAA` | `AAAA-MM-DD`, fecha real |
| `amount` | Dígitos con `'`, `’` o espacio como separador de miles y `.` o `,` como decimal (1–2 cifras) | `^-?\d+\.\d{2}$`; `moneda` = `CHF` (única que ofrece la interfaz; la columna admite cualquier código de 3 letras) |
| `iban` | Con o sin espacios, mayúsculas o minúsculas | Sin espacios, en mayúsculas, con dígito de control válido |
| `enum` | Lista cerrada de `values` del concepto | El valor exacto de la lista |
| `boolean` | Casilla | `true` / `false` |

La validación definitiva ocurre en el núcleo; la del formulario es solo ayuda. No hay validadores por concepto en esta versión (p. ej. el dígito de control de `ahv_nr`).

### 6.4 Evidencia

Cada campo lleva de cero a varias evidencias `(documento, página)`. La página empieza en 1 (`0` = documento entero) y solo aplica a PDF. Un importe que suma varios justificantes (dos Lohnausweise) se introduce como un valor con ambas evidencias. Solo puede citarse un documento del mismo expediente que no esté `descartado`.

## 7. Estados y transiciones

### 7.1 Documento

```
(importación) → pendiente_de_revision ⇄ confirmado
                      ⇅                    │
                  descartado ←─────────────┘
```

| Transición | Quién | Condición |
| --- | --- | --- |
| Importación → `pendiente_de_revision` | Importación | Siempre. `capturado` y `extraido` quedan reservados a la captura y a la extracción automática. |
| `pendiente_de_revision` → `confirmado` | Usuario («Revisado») | Tiene `doc_type`. Significa: «he trasladado al expediente lo que este documento aporta». |
| `confirmado` → `pendiente_de_revision` | Usuario («Reabrir») | — |
| cualquiera → `descartado` | Usuario | Ninguna evidencia lo cita; si las hay, la interfaz indica qué campos. |
| `descartado` → `pendiente_de_revision` | Usuario («Recuperar») | — |

Reimportar un contenido que ya está en el expediente no cambia su estado (un `descartado` sigue descartado).

### 7.2 Expediente

El estado se **calcula** con una función pura `caseStatus(datos, última aprobación)`; no hay columna que pueda quedar desincronizada.

- **`aprobado`**: existe una aprobación vigente (su `case_revision` es la `revision` actual).
- **`revisable`**: no hay aprobación vigente y la lista de bloqueos está vacía.
- **`incompleto`**: hay algún bloqueo.

**Bloqueos** (cada uno con código estable y referencia a la entidad, para mostrarlo):

| Código | Condición |
| --- | --- |
| `sin_campos` | No hay ningún campo `confirmado`. |
| `documento_pendiente` | Algún documento está en `pendiente_de_revision`. |
| `campo_pendiente` | Algún campo está `pendiente` (origen `regla` o `modelo` sin confirmar). |
| `concepto_desconocido` | Algún campo no cumple el invariante 5 con el catálogo actual. |
| `evidencia_no_confirmada` | Algún campo cita un documento que no está `confirmado`. |
| `original_no_disponible` | Algún documento citado como evidencia no tiene su original en el almacén (§9). |

**Avisos** (no bloquean): campos `confirmado` sin evidencia.

Transiciones: `incompleto → revisable` al desaparecer el último bloqueo; `revisable → aprobado` solo con la acción «Aprobar»; `aprobado → revisable` o `incompleto` con **cualquier** cambio de contenido, porque incrementa la revisión (invariante 3). Importar un paquete con algún documento nuevo es un cambio; reimportar uno que no aporta nada no lo es.

## 8. Aprobación y proyección

### 8.1 Operación

`approve(caseId, expectedRevision)` en una transacción síncrona:

1. Falla con `stale_revision` si `expectedRevision` no es la revisión actual: se aprueba exactamente lo que el usuario vio.
2. Recalcula bloqueos; si hay alguno, falla con `blocked` y los devuelve.
3. Construye la proyección, la valida con `loadDeclaration` y con el esquema del contrato; si falla, `invalid_projection` (es un fallo interno: nada se guarda).
4. Inserta la fila en `approvals` y su entrada en `changes`. No incrementa la revisión.

Aprobar dos veces la misma revisión devuelve la aprobación existente.

### 8.2 Instantánea (contrato `approved-declaration`, `schema_version` 1)

```json
{
  "schema_version": 1,
  "approval_id": "…", "case_id": "…", "case_revision": 17,
  "approved_at": "2026-11-12T10:15:00Z", "approver": "usuario:local",
  "content_hash": "<sha256 hex de content>",
  "content": {
    "tax_year": 2025, "jurisdiction": "ZH", "rules_version": null,
    "fields": { "bruttolohn_jahr": { "tipo": "amount", "valor": "85400.00", "moneda": "CHF" } },
    "evidence": { "bruttolohn_jahr": [{ "document_id": "…", "sha256": "…", "page": 1 }] },
    "documents": [{ "document_id": "…", "sha256": "…", "mime": "application/pdf", "doc_type": "lohnausweis" }]
  }
}
```

- `content.fields` es **exactamente** un `Declaration`: una entrada por campo `confirmado`, con la clave de §6.2.
- `content.documents` son los documentos autorizados: los `confirmado`, ordenados por `sha256`.
- `content_hash` se calcula sobre la serialización canónica de `content` (claves ordenadas, sin espacios; la misma función `canonical` de `inbox.ts`, que pasa a un módulo común). No incluye fecha, aprobador ni revisión, de modo que el mismo contenido da la misma huella.
- La instantánea no depende de las tablas vivas: tras aprobar, leerla no consulta `fields`.

### 8.3 Lectura para el agente

`approvedDeclaration(caseId)` devuelve `{ declaration, approvalId, caseRevision, approvedAt, contentHash }` o un error tipado:

| Error | Cuándo |
| --- | --- |
| `no_approval` | El expediente nunca se aprobó. |
| `approval_stale` | La última aprobación es de una revisión anterior. |
| `approval_corrupt` | La huella recalculada no coincide o `loadDeclaration` rechaza el contenido. |

## 9. Importación desde `inbox/`

**Cuándo.** Por acción del usuario: botón «Importar al expediente» en cada tarjeta de paquete de la pestaña de recepción y lista «Paquetes sin importar» en la pestaña del expediente. Se importa al expediente activo. Razones para no hacerlo automático (pregunta 2): con varios expedientes el destino es ambiguo, e importar invalida la aprobación y detiene un llenado en curso, lo que no debe ocurrir sin que el usuario lo pida.

**Qué es importable.** Solo un paquete con `receipt.json`. Uno sin recibo está incompleto: no aparece como importable y `importPackage` lo rechaza con `package_incomplete`; su reanudación o su limpieza a las 24 h siguen siendo cosa de `Inbox`.

**Pasos de `importPackage(caseId, packageId)`**

1. **Validar.** `packageId` con forma de UUID. Leer `manifest.json` y `receipt.json` y validarlos con los esquemas de `packages/contracts` (el disco es una entrada no confiable). Comprobar que `package_id` coincide con el directorio, que el recibo lista los mismos archivos que el manifiesto, y los límites `MAX_FILE_BYTES` y `MAX_PACKAGE_BYTES`.
2. **Idempotencia.** Si `imports` ya tiene el paquete en este expediente, devolver el resultado anterior con `status: 'already_imported'` sin escribir nada. Si lo tiene otro expediente, `package_in_other_case`.
3. **Persistir archivos.** Por cada hash distinto que no esté ya en `BlobStore`: comprobar que `inbox/<package_id>/files/<sha256>` es un archivo regular (no un enlace simbólico), copiarlo a `blobs/tmp/<uuid>.part` calculando SHA-256 y tamaño durante la copia, repetir la comprobación de firma de tipo (`sniffOk`), sincronizar a disco, renombrar a `blobs/<aa>/<sha256>` y dejarlo en solo lectura. Si el hash, el tamaño o el tipo no coinciden: `integrity_error`, se borra el temporal y no se toca la base.
4. **Confirmar metadatos.** Una transacción (`BEGIN IMMEDIATE`): fila en `imports`, filas en `import_files`, un `documents` por hash nuevo en el expediente (estado `pendiente_de_revision`, `original_name` saneado con `originalName` de `inbox.ts`, `source_device` = `device_name`), filas en `changes` e incremento de la revisión **solo si entró algún documento nuevo**.
5. **Notificar.** Tras el `COMMIT` se emite el evento y se devuelve `{ status: 'imported', documents: [{ documentId, sha256, name, outcome: 'nuevo' | 'existente' }] }`.

Dos archivos del paquete con el mismo hash dan un solo documento; `import_files` conserva ambos nombres.

**Interrupción y recuperación.** El orden es el de la arquitectura §4.2: archivos antes que metadatos.

| Momento del corte | Estado resultante | Recuperación |
| --- | --- | --- |
| Durante la copia | Temporales en `blobs/tmp/` | Se borran al arrancar. |
| Tras copiar, antes del `COMMIT` | Blobs sin fila en `documents` (huérfanos) | Al arrancar se borran los blobs que ningún documento referencia. El paquete sigue en `inbox/` y se puede reimportar. |
| Tras el `COMMIT` | Importación completa | Nada que hacer; reimportar devuelve `already_imported`. |

`recover()` se ejecuta al abrir el almacén, antes de aceptar operaciones, y además verifica que cada documento tiene su blob (existencia y tamaño; el hash completo se recalcula al abrir el documento y en una comprobación bajo demanda). Un documento sin blob se marca en la interfaz como «original no disponible» y bloquea la aprobación si se cita como evidencia.

**Relación con el recibo de la transferencia.** Hoy el móvil recibe su recibo cuando el paquete está completo en `inbox/`, antes de importarlo. Es aceptable porque `inbox/` es duradero y la importación es repetible; cuando el móvil necesite confirmaciones de revisión (sincronización PC → móvil) se unificará.

## 10. Interfaz de revisión

Una tercera pestaña, «Expediente», junto a «Recibir del móvil» y «Prueba de portal». Textos en español; ids de concepto y valores `enum` en su forma suiza, acompañados de las etiquetas alemanas del catálogo.

### 10.1 Pantalla

- **Cabecera.** Selector de expediente y «Nuevo expediente» (ejercicio, cantón, personas: titular obligatorio, pareja e hijos opcionales). Estado (`Incompleto`, `Revisable`, `Aprobado`), revisión y, si está aprobado, fecha y los 12 primeros caracteres de la huella. Botón «Aprobar». El expediente activo se recuerda entre arranques.
- **Documentos (izquierda).** Nombre original, tipo, estado, dispositivo y fecha. Acciones: asignar tipo, «Revisado», «Reabrir», «Descartar», «Recuperar». Debajo, «Paquetes sin importar» con su botón.
- **Visor (centro).** El documento seleccionado (§10.2).
- **Campos (derecha).** Lista agrupada por persona o variante, con valor, origen, estado y evidencias (al pulsar una, el visor salta al documento y la página). «Añadir campo»: buscador de concepto (por id y por etiqueta alemana), variante si el concepto la exige, valor con el control de su tipo, y evidencia prerrellenada con el documento y la página abiertos. Editar, eliminar y «Historial» (correcciones del campo, de `changes`).
- **Bloqueos y avisos.** Lista visible con enlace a la entidad que los causa.
- **Aprobar.** Diálogo con la tabla exacta que se va a proyectar (clave, valor, evidencias), los avisos (campos sin evidencia, con casilla de confirmación explícita si los hay) y el botón de confirmar. Con bloqueos, el botón está deshabilitado y se explica por qué.
- **Editar un expediente aprobado.** Antes del primer cambio se avisa de que anula la aprobación.

Accesible por teclado; cada campo de formulario muestra su error junto al control. React Hook Form y React Aria son la recomendación de la arquitectura; adoptarlos queda a criterio del implementador (§17).

### 10.2 Visor: lo mínimo viable

| Tipo | Vista |
| --- | --- |
| PDF | **PDF.js (`pdfjs-dist`) empaquetado localmente**, con su *worker* local: página a página en un `canvas`, anterior/siguiente, número de página y zoom. Sin capa de texto, búsqueda, miniaturas ni impresión. Scripts de PDF desactivados, `isEvalSupported: false`, sin fuentes ni recursos remotos. |
| JPEG, PNG | `<img>` con zoom. |
| HEIC | Sin vista previa (Chromium no lo decodifica): se muestra el aviso y «Mostrar en la carpeta». Convertirlo queda fuera. |
| JSON | Texto plano en `<pre>`, truncado a 256 KB. Nunca se interpreta como datos del expediente. |

Los bytes llegan por un protocolo propio registrado solo en la sesión de la ventana principal: `fodibo-doc://doc/<document_id>` (**Decisión del autor**). El manejador acepta únicamente un UUID, busca el documento en la base, sirve el blob con el `Content-Type` guardado, `X-Content-Type-Options: nosniff` y soporte de rangos, y responde 404 a todo lo demás. Nunca recibe ni devuelve rutas. Cuando haya cifrado, este manejador es el punto donde se descifra en streaming.

El renderer añade una Content-Security-Policy (hoy `index.html` no tiene): `default-src 'self'`; `img-src` y `connect-src` con `fodibo-doc:`; `worker-src 'self'`; sin `unsafe-eval` ni orígenes remotos (con las excepciones que exija el servidor de desarrollo de Vite, solo sin empaquetar).

### 10.3 IPC tipado y validado

API `window.fodiboExpediente` (canales `case:*`), con el mismo patrón que `shared/ipc.ts` y `shared/agent-ipc.ts`:

| Método | Efecto |
| --- | --- |
| `listCases()` / `createCase(input)` / `updateCase(caseId, input)` | Expedientes y sus personas. |
| `getCase(caseId)` | Vista completa: metadatos, personas, documentos, campos con evidencias, `revision`, estado, bloqueos, avisos y resumen de la última aprobación. |
| `listConcepts()` | Catálogo para la interfaz: `id`, `tipo`, `labels`, `variants`, `values`. |
| `listImportable()` / `importPackage(caseId, packageId)` | Paquetes con recibo aún no importados; importación. |
| `setDocument(documentId, { docType?, status? })` | Tipo y transiciones de §7.1. |
| `saveField(caseId, { fieldId?, conceptId, variant, valor, moneda?, evidence[] })` / `deleteField(fieldId)` | Alta, corrección y baja; siempre con origen `usuario` y estado `confirmado`. |
| `fieldHistory(fieldId)` | Historial de correcciones. |
| `approve(caseId, expectedRevision)` | §8.1. |
| `showDocumentInFolder(documentId)` | Abre la carpeta del original (para HEIC). |
| `onEvent(cb)` | `{ type: 'case-changed', caseId, revision }` tras cada escritura confirmada. |

Reglas:

- Cada manejador valida sus argumentos en `main` con Ajv antes de llamar al núcleo: tipos, formas de UUID, longitudes máximas y sin propiedades adicionales. El renderer es una entrada no confiable.
- Respuesta uniforme `{ ok: true, value } | { ok: false, error: { code, message, details? } }` (**Decisión del autor**: los rechazos de `ipcRenderer.invoke` pierden el código). `message` va en español y es mostrable.
- Ningún método acepta rutas, SQL, ni el origen o el actor de un cambio: los fija el núcleo.

## 11. Integración con el agente navegador

- `AgentDeps.loadDeclaration` deja de leer `test-portal/declaracion.json` en la app normal y pasa a llamar a `approvedDeclaration(caseId)`. `agent:start` recibe el `caseId` del expediente activo (validado como UUID).
- **Sin aprobación vigente, el agente no arranca** y no hay alternativa silenciosa. Mensajes: `no_approval` → «No hay ninguna versión aprobada del expediente. Revísalo y apruébalo antes de rellenar el portal.»; `approval_stale` → «El expediente cambió después de la aprobación. Vuelve a aprobarlo.»; `approval_corrupt` → «La versión aprobada no supera la comprobación de integridad.» Se emiten como el estado `error` actual.
- El agente trabaja con la copia en memoria tomada al iniciar; nunca lee los campos vivos ni escribe en el expediente (arquitectura §2).
- Si llega `case-changed` del expediente en uso durante una ejecución, `main` detiene el agente (`stop()`) y registra «El expediente cambió: llenado detenido» (arquitectura §3: un cambio de datos pausa el llenado en curso).
- El panel del portal muestra qué versión usa: expediente, revisión, fecha y huella abreviada.
- `--bench` y `--selftest-adapter` siguen usando `declaracion.json` para que el banco sea reproducible. Un script de desarrollo crea un expediente aprobado equivalente a ese fichero para las pruebas manuales y de aceptación.
- `orchestrator.ts`, `mapping.ts` y `cdp-adapter.ts` no cambian.

## 12. Seguridad y privacidad

- **Todo local.** `core/expediente` no abre conexiones ni importa módulos de red. La prueba de aislamiento del núcleo se amplía a este módulo.
- **Entradas no confiables:** el contenido de `inbox/` (manifiesto, recibo, archivos), los documentos y cualquier argumento del renderer. Ninguna amplía permisos ni aprueba nada: aprobar solo ocurre por la acción del usuario en el diálogo.
- **Rutas.** Solo se construyen con valores validados por expresión regular: UUID (`package_id`) y 64 hex (`sha256`), bajo raíces fijas. El nombre original es un dato para mostrar, saneado, y nunca forma parte de una ruta. No se siguen enlaces simbólicos al importar.
- **Tamaños.** Archivo ≤ 50 MiB y paquete ≤ 500 MiB (constantes de la transferencia), hasta 100 archivos por paquete (esquema del manifiesto), texto ≤ 200 caracteres, hasta 20 evidencias por campo, página entre 0 y 9999, vista de JSON truncada.
- **Documentos.** Se muestran en el renderer con `sandbox`, aislamiento de contexto y la CSP de §10.2; PDF.js sin scripts ni `eval`. Los JSON recibidos nunca se analizan como declaración ni como campos.
- **Base de datos.** Sentencias preparadas siempre; claves foráneas activas; `changes` y `approvals` protegidas por disparadores.
- **Registro.** La consola y los mensajes de error incluyen identificadores y códigos, nunca valores de campos ni nombres de archivo.
- **Límite conocido de esta versión:** la base y los originales están **en claro** en el perfil del usuario, igual que `inbox/` hoy. Se corrige en §16 y debe constar en el README hasta entonces.

## 13. Errores y recuperación

Códigos estables del núcleo, transportados por IPC:

| Código | Situación | Comportamiento visible |
| --- | --- | --- |
| `invalid_input` | Argumentos o valor que no pasan la validación | Error junto al control; nada se guarda. |
| `not_found` | Expediente, documento, campo o paquete inexistente | Aviso y recarga de la vista. |
| `package_incomplete` | Paquete sin recibo | «El paquete aún no está completo.» |
| `package_invalid` | Manifiesto o recibo que no cumplen el contrato | Aviso; el paquete queda sin importar. |
| `package_in_other_case` | Ya importado en otro expediente | Aviso indicando cuál. |
| `integrity_error` | Hash, tamaño o tipo no coinciden al copiar, o al abrir un original | Aviso; no se importa o no se muestra. Nunca se «repara» en silencio. |
| `invalid_transition` | Transición de documento no permitida (p. ej. descartar uno citado) | Aviso con los campos afectados. |
| `person_in_use` | Eliminar una persona con campos | Aviso con los campos. |
| `stale_revision` / `blocked` | Aprobación sobre una vista obsoleta o con bloqueos | Recarga y lista de bloqueos. |
| `no_approval` / `approval_stale` / `approval_corrupt` | §8.3 | El agente no arranca. |
| `storage_error` | Disco lleno, base bloqueada o ilegible | Aviso; la transacción se revierte entera. |

Recuperación:

- Toda escritura es una transacción: tras un cierre brusco, la base queda en el último estado confirmado (WAL con `synchronous=FULL`).
- Al arrancar: `recover()` (§9). Si la base no abre o `PRAGMA integrity_check` falla, la pestaña «Expediente» muestra el error y la ruta de la última copia de `backups/`; **no** se crea una base vacía encima ni se borra nada. Transferencia y portal siguen funcionando.
- Un fallo de migración restaura la copia previa y deja la app en la versión de esquema anterior.

## 14. Pruebas

- **Contrato (`packages/contracts`):** vectores válidos e inválidos de `approved-declaration`; `content.fields` de los válidos pasa `loadDeclaration`.
- **Almacenamiento (Vitest, base en directorio temporal):** restricciones y `UNIQUE`; disparadores de solo inserción; migración desde una base de versión anterior con copia previa; rechazo de una base de versión posterior.
- **Importación:** paquete completo; sin recibo; manifiesto inválido; reimportación; mismo hash en dos paquetes; hash repetido dentro del paquete; archivo alterado en `inbox/`; enlace simbólico en `files/`; paquete ya importado en otro expediente; fallo inyectado tras la copia y antes del `COMMIT`, seguido de `recover()` y reimportación.
- **Campos:** tabla de normalización por tipo; variante obligatoria o prohibida según el catálogo; historial con valor anterior y nuevo; evidencia a documento descartado o de otro expediente.
- **Estado y aprobación:** cada bloqueo por separado; huella estable ante el orden de inserción; `approvedDeclaration` con cada error; toda operación de escritura incrementa la revisión e invalida la aprobación (prueba que recorre **todas** las operaciones de la API); manipulación directa de `snapshot` detectada.
- **Propiedad de proyección:** para expedientes generados, la proyección siempre pasa `loadDeclaration` y sus claves son únicas.
- **IPC (`main`, con `ipcMain` simulado):** argumentos mal formados rechazados sin llegar al núcleo; forma `{ ok, … }`.
- **Agente (`agent-ipc.test.ts`):** arranca con aprobación vigente; no arranca sin ella; se detiene ante `case-changed`.
- **Renderer (Testing Library):** alta de campo con error de validación; diálogo de aprobación con bloqueos y avisos; aviso al editar un expediente aprobado.
- **Aislamiento:** `core/expediente` no importa `electron`, `react` ni módulos de red; solo `storage/` importa el binding.
- **Manual, extremo a extremo:** móvil real → PC → importar → revisar un PDF, una foto y un JSON → aprobar → «Prueba de portal» rellena con esos datos. Repetir con captura de tráfico para comprobar que no hay egreso.

## 15. Criterios de aceptación

1. **Flujo completo.** Un paquete enviado desde el móvil se importa, sus documentos se ven en el visor, se introducen campos con evidencia, se aprueba y el agente rellena el portal de prueba con esos valores, sin leer `declaracion.json`.
2. **Equivalencia con el prototipo.** Un expediente con los mismos datos que `test-portal/declaracion.json` produce una proyección estrictamente igual a `loadDeclaration(declaracion.json)`, incluidas `krankenkasse_praemie_hauptperson` y `krankenkasse_praemie_familie`, y el agente obtiene con ella el mismo resultado que hoy contra `esperado.json`.
3. **Reimportación sin duplicados** (arquitectura §9). Importar dos veces el mismo paquete, o dos paquetes con un archivo idéntico, deja un único documento y un único blob por contenido; la segunda importación no cambia la revisión ni el número de filas de `documents`.
4. **Interrupción sin perder lo confirmado** (arquitectura §9). Matar el proceso en cualquier punto de una importación o de una edición y volver a arrancar deja: todo lo confirmado antes intacto, ningún documento sin blob, ningún blob huérfano ni temporal, y el paquete reimportable con el resultado correcto.
5. **Originales inmutables.** Tras cualquier secuencia de operaciones, el SHA-256 de cada blob coincide con su nombre y con `documents.sha256`. Alterar un blob a mano se detecta al abrirlo (`integrity_error`).
6. **Paquetes incompletos.** Un paquete sin `receipt.json` no aparece como importable y `importPackage` lo rechaza sin escribir nada.
7. **Invalidación.** Con el expediente aprobado, cada una de las operaciones de escritura de la API lo saca de `aprobado`, y a partir de ese momento el agente se niega a arrancar (`approval_stale`) hasta una nueva aprobación. Un llenado en curso se detiene.
8. **Sin aprobación no hay llenado.** Con un expediente nunca aprobado, «Iniciar» en el portal muestra el mensaje de §11 y no se escribe ningún campo.
9. **Aprobación verificable.** La instantánea cumple el contrato, su huella se recalcula igual desde `content`, y modificar un byte de `snapshot` en la base hace que el agente la rechace.
10. **Historial.** Corregir un campo dos veces deja tres entradas (alta y dos correcciones) con actor, fecha y valores anterior y nuevo; `changes` y `approvals` rechazan `UPDATE` y `DELETE`.
11. **Vocabulario suizo.** Es imposible guardar un campo cuyo concepto no esté en el catálogo o cuya variante no corresponda; ninguna clave de la proyección está fuera del catálogo.
12. **Validación por tipo.** Fecha imposible, IBAN con dígito de control erróneo, importe mal formado y valor `enum` fuera de lista se rechazan en el núcleo aunque el renderer los envíe.
13. **Aislamiento.** `core/expediente` pasa sus pruebas en Node sin Electron; el binding de SQLite solo se importa en `storage/`.
14. **Privacidad.** Importar, revisar, aprobar y rellenar el portal de prueba funcionan sin red, y una captura de tráfico con red disponible no muestra conexiones salientes.
15. **Regresión.** Las pruebas existentes de transferencia y del agente siguen pasando; el banco (`npm run bench`) no cambia de resultado.

## 16. Siguiente ronda: cifrado en reposo

Queda fuera, pero el diseño lo deja a un cambio dentro de `storage/` y `main`:

1. **Validar primero el binding.** Confirmar que un SQLite con SQLCipher compila, carga y pasa las pruebas de almacenamiento con la versión de Electron del repositorio en los sistemas objetivo (macOS ahora; Windows x64 es la prioridad de la arquitectura), empaquetado incluido. Es el riesgo técnico más probable según la spec de transferencia; hasta validarlo no se depende de él.
2. **Base.** `openStore({ dir, key })` abre con SQLCipher. Migración de la base en claro: copia previa, exportación cifrada, verificación y sustitución; reversible.
3. **Archivos.** Implementación cifrada de `BlobStore` con libsodium `secretstream`; el nombre sigue siendo el SHA-256 del contenido en claro, verificado al descifrar. El protocolo `fodibo-doc:` descifra en streaming. Los blobs existentes se recifran con la misma disciplina de temporal y renombrado.
4. **Claves.** Generadas en el equipo y protegidas por el almacén seguro del sistema; `main` las obtiene y las inyecta, porque el núcleo no importa Electron. Recuperación independiente del dispositivo (Argon2id sobre una frase del usuario) y copias cifradas con restauración comprobada, según arquitectura §7.
5. **`inbox/`.** Decidir si los paquetes se cifran al recibirlos o se purgan tras importarlos; hoy quedan en claro.

## 17. A criterio de quien construya

- El binding de SQLite, con los criterios de §4.3, y la forma interna de `CaseStore` (repositorios, SQL, índices).
- Nombres de archivos y funciones dentro de la estructura de §4.1, y si el catálogo se mueve a un módulo neutral del núcleo.
- Biblioteca de formularios y de accesibilidad (React Hook Form y React Aria recomendados), y el diseño visual, siempre que cubra §10.
- Integración de `pdfjs-dist` con Vite y la versión exacta, fijada.
- Cómo se recuerda el expediente activo y cómo se pagina `getCase` si hiciera falta.
- Textos exactos de la interfaz y de los mensajes de error.
- El mecanismo para inyectar fallos en las pruebas de interrupción.
- La forma del script que crea el expediente de prueba.

Decisiones tomadas tras la revisión de constructor (de quien coordina, no del usuario):

- **`FODIBO_DATA_DIR` en la app.** El proceso `main` de Electron respeta `FODIBO_DATA_DIR` si está definida (y si no, `userData`), para que la app importe los paquetes que recibe el servidor de desarrollo, que ya la usa.
- **`showDocumentInFolder`.** Muestra la copia con nombre original de `inbox/<package_id>/originales/` si existe; si no, el blob. Se revisa en la ronda de cifrado, cuando `inbox/` deje de conservar copias en claro.

## 18. Riesgos conocidos

- **Módulo nativo y dos ABI.** Vitest corre en el Node del sistema y la app en el de Electron; un binding nativo necesita cargarse en ambos. Si se complica, es la primera cosa que hay que resolver, antes de escribir el resto.
- **PDF.js en el renderer principal.** Comparte proceso con la interfaz que tiene la API del expediente. Lo acotan el `sandbox`, la CSP y la validación en `main`; aislar el visor en un marco sin *preload* es el endurecimiento previsto si se amplía lo que el visor hace (capa de texto, extracción).
- **Catálogo como dependencia viva.** Renombrar o quitar un concepto deja campos «desconocidos» que bloquean la aprobación. Es deliberado (mejor bloquear que proyectar una clave huérfana), pero exige cuidado al tocar `catalog.ts`.
- **«Confirmado» sin extracción** depende de la disciplina del usuario: nada comprueba que haya trasladado todo lo relevante del documento.
- **Espacio en disco:** los originales quedan duplicados entre `inbox/` y `blobs/` hasta la ronda de cifrado.
- **Datos en claro** hasta la ronda siguiente (§12).

## 19. Preguntas abiertas para el usuario

Solo las que cambian lo que se construye. Si no hay respuesta, se aplica la propuesta.

1. **¿Qué es un expediente: un hogar fiscal y ejercicio, o un contribuyente y ejercicio?**
   Propuesta: un expediente por hogar (titular, pareja e hijos que tributan juntos), ejercicio y cantón; la app admite varios expedientes. Con «por contribuyente», la tabla de personas y las variantes `partner`/`familie` sobrarían y una pareja necesitaría dos expedientes enlazados.
2. **¿La importación es automática al recibir un paquete o requiere una acción del usuario?**
   Propuesta: acción del usuario por paquete, hacia el expediente activo. La automática solo es inequívoca con un único expediente, y anularía aprobaciones y detendría llenados sin que nadie lo pidiera.
3. **¿Se puede aprobar un campo sin evidencia?**
   Propuesta: sí, con aviso y confirmación explícita en el diálogo de aprobación (datos personales o un gasto sin justificante no tienen documento). La alternativa es bloquear la aprobación, al menos para los importes.
4. **¿Debe esta versión admitir varios valores del mismo concepto y persona (dos empleadores, varias cuentas bancarias)?**
   Propuesta: no; un valor por concepto y variante, con varias evidencias (el usuario suma). Admitirlo cambia el esquema de campos, la proyección y cómo el agente decide qué valor va en cada campo del portal.
5. **¿Debe cubrir ya los datos propios de la pareja (segundo salario, su AHV-Nr.)?**
   Propuesta: no; solo `krankenkasse_praemie` tiene variantes, como hoy. Hacerlo es marcar más conceptos con `variants` en el catálogo, lo que cambia el comportamiento del agente y el portal de prueba.
6. **¿Hace falta borrar físicamente documentos o expedientes en esta versión?**
   Propuesta: no; solo «descartar» (el original se conserva). El borrado real, con propagación al historial y a las aprobaciones, se diseña junto con el cifrado y las copias.
