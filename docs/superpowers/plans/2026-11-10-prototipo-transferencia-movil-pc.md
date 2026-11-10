# Prototipo de transferencia móvil → PC — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Objetivo:** enviar fotos, PDF y JSON desde una app Flutter Android a una app Electron en el PC por HTTPS local con certificado fijado, y mostrar en el PC una confirmación verificada de lo recibido.

**Arquitectura:** monorepo con npm workspaces. `packages/contracts` contiene los JSON Schema y vectores de prueba compartidos. En el escritorio, `transfer-core` (TypeScript puro sobre Node, sin Electron) implementa sesión, servidor y almacén; Electron es solo carcasa (main + preload + React). En el móvil, `lib/transfer` (Dart puro, sin Flutter) implementa el cliente y `lib/ui` la interfaz.

**Stack:** Node ≥ 22, TypeScript, Vitest, Ajv (draft 2020-12), `selfsigned`, `qrcode`, Electron + `electron-vite` + React · Flutter estable, Dart, `crypto`, `mobile_scanner`, `file_picker`, `device_info_plus`.

**Spec:** `docs/superpowers/specs/2026-11-10-prototipo-transferencia-movil-pc-design.md` — leerla antes de empezar cualquier tarea; este plan argumenta desde ella.

## Restricciones globales

- Ningún dato sale de la LAN; ninguna dependencia hace llamadas de red en tiempo de ejecución.
- `apps/desktop/src/core/**` no importa `electron` ni `react`. `apps/mobile/lib/transfer/**` no importa `package:flutter`.
- Rutas bajo `/v1`; TLS 1.3 mínimo (`minVersion: 'TLSv1.3'`); puerto aleatorio (`listen(0)`); escucha solo durante una sesión.
- Huella: `"sha256:" + hex` en minúsculas del SHA-256 del certificado en DER.
- Secreto: 128 bits aleatorios en base64url; caduca a los 5 min; un solo uso; 5 intentos fallidos cierran la sesión.
- Token de sesión: válido hasta «Detener» o 30 min sin peticiones autenticadas.
- Tipos permitidos: `image/jpeg`, `image/png`, `image/heic`, `application/pdf`, `application/json`.
- Límites: 50 MB (52 428 800 bytes) por archivo, 100 archivos y 500 MB (524 288 000 bytes) por paquete.
- Paquetes todo o nada; `status` del recibo siempre `"stored"`.
- En disco los archivos se nombran por su hash; ninguna ruta se construye con texto del cliente.
- Cuerpo de error: `{ "error": { "code", "message" } }`. Códigos y HTTP: `invalid_secret` 401, `unauthorized` 401, `invalid_manifest` 400, `unsupported_type` 415, `too_large` 413, `hash_mismatch` 422, `package_conflict` 409, `incomplete_package` 409, `not_found` 404 (*`not_found` y los códigos HTTP son decisión de este plan*).
- Fechas en ISO 8601 UTC. Identificadores UUID v4.
- Commits terminan con:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01S4UrmcEjtoxL7TtaLoW2yf
  ```

## Foco de revisión

Fallos que la spec implica pero ninguna prueba obvia cubriría; cada uno tiene su prueba en la tarea indicada.

1. **El mismo archivo elegido dos veces** (dos entradas del manifiesto con igual `sha256`): se acepta, se almacena una vez y el recibo lista ambas entradas. → Tarea 3.
2. **Cuerpo de subida más largo que el `size` declarado**: se corta en cuanto excede, responde `too_large` y no queda ningún temporal. → Tarea 3.
3. **Dos `PUT` simultáneos del mismo hash** (reintento mientras el anterior sigue en vuelo): ambos terminan sin corromper el archivo final. → Tarea 3.
4. **Nombres con acentos, emoji, `../` o de 255+ caracteres**: el esquema limita a 255; se muestran tal cual y nunca tocan una ruta. → Tareas 1 y 4.
5. **Archivo vacío o JSON que no se puede interpretar**: rechazado con `unsupported_type`, no se confirma. → Tarea 3.

---

## Estructura de archivos

```
package.json                          workspaces: packages/*, apps/desktop
packages/contracts/
  package.json                        "@fodibo/contracts"; exporta schemas
  schemas/{qr,manifest,receipt,error}.schema.json
  vectors/<schema>/{valid,invalid}/*.json
  test/vectors.test.ts
apps/desktop/
  package.json, electron.vite.config.ts, tsconfig*.json, vitest.config.ts
  src/core/transfer/
    errors.ts        TransferError, códigos y estado HTTP
    validate.ts      validadores Ajv sobre @fodibo/contracts
    certificate.ts   crear/cargar certificado, huella
    network.ts       IPv4 privadas
    session.ts       PairingSession: secreto, token, intentos, inactividad
    sniff.ts         comprobación de tipo por contenido
    inbox.ts         Inbox: anunciar, guardar, confirmar, listar, limpiar
    server.ts        rutas HTTPS /v1
    service.ts       TransferService: start/stop/eventos/listado
    index.ts         reexporta la API pública
  src/core/transfer/__tests__/*.test.ts
  scripts/dev-server.ts             servidor sin Electron para pruebas de interoperabilidad
  src/main/index.ts, src/main/ipc.ts
  src/preload/index.ts
  src/renderer/{index.html,main.tsx,App.tsx,components/*.tsx}
apps/mobile/                        proyecto Flutter (Android)
  lib/transfer/{contracts.dart,local_file.dart,pinned_client.dart,transfer_client.dart,errors.dart}
  lib/ui/{app.dart,scan_screen.dart,send_screen.dart,receipt_view.dart}
  lib/main.dart
  test/transfer/*.dart, test/fixtures/
```

---

### Tarea 1: Monorepo y contratos

**Files:**
- Create: `package.json`, `packages/contracts/package.json`, `packages/contracts/schemas/*.schema.json`, `packages/contracts/vectors/**`, `packages/contracts/test/vectors.test.ts`

**Interfaces:**
- Produces: paquete `@fodibo/contracts` con `export { qrSchema, manifestSchema, receiptSchema, errorSchema }` (objetos JSON) desde `packages/contracts/index.js` (+ `index.d.ts`); vectores en `vectors/<qr|manifest|receipt|error>/{valid,invalid}/*.json` que leen TS (Tarea 1) y Dart (Tarea 6).

- [ ] **Paso 1: Commit inicial de lo existente**

```bash
git add .gitignore docs/
git commit -m "docs: arquitectura, spec y plan del prototipo de transferencia"
```

- [ ] **Paso 2: Raíz del monorepo**

`package.json` raíz: `"private": true`, `"workspaces": ["packages/*", "apps/desktop"]`, `"engines": {"node": ">=22"}`, script `"test": "npm test --workspaces --if-present"`. Dev deps en la raíz: `typescript`, `vitest`, `ajv`, `ajv-formats` con versiones exactas (sin `^`).

- [ ] **Paso 3: Escribir los vectores**

Mínimo por esquema (nombres de archivo descriptivos):
- `qr/valid`: `basic.json` (ejemplo de la spec §6), `multiple-hosts.json`. `qr/invalid`: `missing-fp.json`, `bad-fp-prefix.json` (`md5:`), `v2.json`, `port-zero.json`, `empty-hosts.json`.
- `manifest/valid`: `three-types.json` (jpeg + pdf + json), `duplicate-sha.json` (dos entradas, mismo `sha256`), `unicode-name.json` (`"Quittung Zürich 🧾.jpg"`). `manifest/invalid`: `no-files.json`, `101-files.json`, `name-256-chars.json`, `bad-mime.json` (`image/gif`), `size-over-50mb.json` (52 428 801), `sha-uppercase.json`, `not-uuid.json`, `extra-property.json`.
- `receipt/valid`: `basic.json`. `receipt/invalid`: `status-partial.json`.
- `error/valid`: uno por código. `error/invalid`: `unknown-code.json`.

- [ ] **Paso 4: Escribir la prueba que falla**

`test/vectors.test.ts`: para cada esquema y cada archivo de `valid/` → `expect(validate(data)).toBe(true)`; de `invalid/` → `false`. Además `test("el total de bytes por paquete no lo cubre el esquema")` queda documentado como comentario: el límite de 500 MB se comprueba en `validate.ts` (Tarea 3), no en JSON Schema.

- [ ] **Paso 5: Ejecutar y ver que falla**

Run: `npm test -w @fodibo/contracts` — Expected: FAIL (esquemas inexistentes).

- [ ] **Paso 6: Escribir los esquemas (draft 2020-12, `additionalProperties: false`)**

Valores que fijan: `v` const 1; `port` 1–65535; `hosts` 1+ IPv4; `fp` patrón `^sha256:[0-9a-f]{64}$`; `secret` patrón `^[A-Za-z0-9_-]{22}$`; `exp`/`created_at`/`received_at` `format: date-time`; `schema_version` const 1; `package_id`/`file_id` `format: uuid`; `name` 1–255; `mime` enum de tipos permitidos; `size` entero 0–52 428 800; `sha256` `^[0-9a-f]{64}$`; `files` 1–100; `device_name` 1–100; `status` enum `["stored"]`; `error.code` enum de los nueve códigos.

- [ ] **Paso 7: Ejecutar y ver que pasa**

Run: `npm install && npm test -w @fodibo/contracts` — Expected: PASS.

- [ ] **Paso 8: Commit** — `feat(contracts): esquemas JSON v1 y vectores de prueba`

---

### Tarea 2: Certificado, red y sesión de emparejamiento

**Files:**
- Create: `apps/desktop/package.json`, `apps/desktop/tsconfig.json`, `apps/desktop/vitest.config.ts`, `src/core/transfer/{errors,certificate,network,session}.ts`
- Test: `src/core/transfer/__tests__/{certificate,network,session}.test.ts`

**Interfaces:**
- Produces:
  - `type ErrorCode = 'invalid_secret' | 'unauthorized' | 'invalid_manifest' | 'unsupported_type' | 'too_large' | 'hash_mismatch' | 'package_conflict' | 'incomplete_package' | 'not_found'`; `class TransferError extends Error { code: ErrorCode; status: number }`; `httpStatusOf(code: ErrorCode): number`.
  - `loadOrCreateCertificate(dir: string): Promise<{ certPem: string; keyPem: string; fingerprint: string }>` — escribe/lee `dir/cert.pem` y `dir/key.pem` (modo 0600 para la clave).
  - `fingerprintOf(certPem: string): string` — usa `new crypto.X509Certificate(pem).raw`.
  - `privateIPv4Addresses(ifaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string[]` — solo no internas en 10/8, 172.16/12, 192.168/16.
  - `class PairingSession { constructor(opts?: { now?: () => number }); readonly secret: string; readonly expiresAt: Date; readonly closed: boolean; pair(secret: string, deviceName: string): { sessionToken: string }; authenticate(token: string | undefined): void /* renueva la inactividad */; close(): void; onClose(cb: () => void): void }`.

- [ ] **Paso 1: Escribir las pruebas que fallan**

`certificate.test.ts`:
- `crea el certificado y lo reutiliza`: dos llamadas sobre el mismo `tmpdir` devuelven la misma `fingerprint`.
- `la huella tiene el formato del contrato`: `toMatch(/^sha256:[0-9a-f]{64}$/)` y coincide con `sha256(X509Certificate.raw)`.

`network.test.ts` con interfaces simuladas:
- devuelve `['192.168.1.20', '10.0.0.5', '172.20.1.1']`; excluye `127.0.0.1`, `172.32.0.1`, `8.8.8.8`, IPv6 e `internal: true`.

`session.test.ts` (reloj inyectado):
- `secreto de 22 caracteres base64url`; `expiresAt = now + 5 min`.
- `pair` correcto devuelve token; segundo `pair` con el mismo secreto → `TransferError('invalid_secret')`.
- `pair` tras 5 min + 1 ms → `invalid_secret`.
- 5 `pair` con secreto incorrecto → `closed === true` y el `onClose` se llama una vez; el 6.º, aun con el secreto correcto, falla.
- `authenticate(undefined)` y token incorrecto → `unauthorized`.
- inactividad: token válido a los 29 min tras la última `authenticate`; a los 30 min + 1 ms → `unauthorized` y sesión cerrada.
- comparación de secreto y token con `crypto.timingSafeEqual` (prueba: secreto de distinta longitud no lanza excepción interna, solo `invalid_secret`).

- [ ] **Paso 2: Ejecutar y ver que fallan** — `npm test -w apps/desktop` → FAIL.

- [ ] **Paso 3: Implementar** `errors.ts`, `certificate.ts` (con `selfsigned`, RSA 2048 o EC P-256, validez 10 años, CN `fodibo-desktop`), `network.ts`, `session.ts` (secreto y token con `crypto.randomBytes`, token de 256 bits).

- [ ] **Paso 4: Ejecutar y ver que pasan** — Expected: PASS.

- [ ] **Paso 5: Commit** — `feat(desktop): certificado, direcciones LAN y sesión de emparejamiento`

---

### Tarea 3: Validación, comprobación de tipo y almacén `Inbox`

**Files:**
- Create: `src/core/transfer/{validate,sniff,inbox}.ts`
- Test: `__tests__/{validate,sniff,inbox}.test.ts`

**Interfaces:**
- Consumes: `TransferError` (Tarea 2); esquemas de `@fodibo/contracts`.
- Produces:
  - `type Manifest`, `type ManifestFile`, `type Receipt` (espejo de los esquemas).
  - `parseManifest(body: unknown): Manifest` — Ajv + suma de `size` ≤ 524 288 000; si no, `invalid_manifest` (esquema) o `too_large` (suma).
  - `sniffOk(mime: string, head: Buffer): boolean` — firmas: JPEG `FF D8 FF`; PNG `89 50 4E 47 0D 0A 1A 0A`; PDF `%PDF-`; HEIC `ftyp` en bytes 4–7 y marca en 8–11 ∈ {`heic`,`heix`,`heim`,`heis`,`hevc`,`hevx`,`mif1`,`msf1`}; JSON: siempre `true` aquí (se valida con `JSON.parse` al terminar la escritura).
  - `class Inbox { constructor(root: string, opts?: { now?: () => number }); announce(m: Manifest): Promise<{ package_id: string; missing: string[] }>; storeFile(packageId: string, sha256: string, body: Readable): Promise<void>; commit(packageId: string): Promise<Receipt>; list(): Promise<ReceivedPackage[]>; cleanup(): Promise<void> }`
  - `type ReceivedPackage = { receipt: Receipt; deviceName: string }`
  - Evento opcional: `commit` devuelve el recibo; quien llama emite eventos (Tarea 4).

Comportamiento que fija este plan:
- `announce`: guarda `manifest.json` si es nuevo. Si existe con contenido distinto (comparar JSON canónico con claves ordenadas) → `package_conflict`. Si ya tiene recibo → `missing: []`. `missing` = hashes únicos del manifiesto sin archivo final en `files/`.
- `storeFile`: paquete desconocido o hash fuera del manifiesto → `not_found`. Si el archivo final ya existe → consume el cuerpo y retorna. Escribe en `files/<sha256>.<uuid>.part` calculando SHA-256 en streaming; si los bytes superan el `size` declarado → aborta, borra el `.part`, `too_large`; si la longitud final difiere o el hash no coincide → borra, `hash_mismatch`; si el primer bloque no pasa `sniffOk` o el JSON no se interpreta → borra, `unsupported_type`. Con todo correcto, `fs.rename` a `files/<sha256>`.
- `commit`: con recibo → devuelve el mismo; si falta algún hash → `incomplete_package`; si no, escribe `receipt.json.part` y lo renombra a `receipt.json`.
- `cleanup`: borra todos los `*.part`; borra directorios de paquetes sin `receipt.json` cuyo `manifest.json` tenga más de 24 h (mtime).
- `list`: paquetes con recibo, más recientes primero; `deviceName` del manifiesto.

- [ ] **Paso 1: Escribir las pruebas que fallan**

`validate.test.ts`: acepta `three-types.json`; rechaza `extra-property.json` con `invalid_manifest`; manifiesto de 11 archivos de 50 MB → `too_large`.

`sniff.test.ts`: una prueba por firma válida; `image/png` con cabecera JPEG → `false`; HEIC con marca `avif` → `false`; búfer vacío → `false` para todo menos JSON.

`inbox.test.ts` (directorio temporal, contenidos pequeños reales: un JPEG mínimo de bytes, un PDF `%PDF-1.4…`, `{"a":1}`):
- flujo completo: `announce` → `missing` con 3 hashes → `storeFile` ×3 → `commit` devuelve recibo con 3 archivos `status: 'stored'`; los archivos en disco tienen su hash.
- reanudación: tras guardar 1 de 3, un nuevo `announce` devuelve solo los 2 que faltan.
- idempotencia: `announce` tras `commit` → `missing: []`; segundo `commit` devuelve recibo idéntico (`toEqual`).
- conflicto: mismo `package_id`, otro manifiesto → `package_conflict`.
- `commit` incompleto → `incomplete_package` y no existe `receipt.json`.
- hash incorrecto → `hash_mismatch`; no queda `*.part` ni archivo final.
- **(Foco 2)** cuerpo con `size + 1` bytes → `too_large`; el stream se destruye antes de leerlo entero (cuerpo de 10 MB con `size` 10 bytes: comprobar que se leyeron < 1 MB); sin `.part`.
- **(Foco 5)** archivo de 0 bytes declarado como `image/jpeg` → `unsupported_type`; `application/json` con `{oops` → `unsupported_type`.
- **(Foco 1)** `duplicate-sha.json`: `missing` tiene 1 hash; tras subirlo, `commit` devuelve recibo con 2 entradas.
- **(Foco 3)** dos `storeFile` simultáneos del mismo hash con `Promise.all` → ambos resuelven, el archivo final tiene el hash correcto, no quedan `.part`.
- hash fuera del manifiesto → `not_found`.
- `cleanup`: borra `.part` y paquetes sin recibo de 25 h; conserva uno sin recibo de 1 h y los confirmados.
- `list`: orden por `received_at` descendente con `deviceName`.

- [ ] **Paso 2: Ejecutar y ver que fallan** — FAIL.
- [ ] **Paso 3: Implementar** `validate.ts`, `sniff.ts`, `inbox.ts` según lo anterior (`stream/promises.pipeline` con un `Transform` que cuenta bytes y alimenta el hash).
- [ ] **Paso 4: Ejecutar y ver que pasan** — PASS.
- [ ] **Paso 5: Commit** — `feat(desktop): validación de manifiesto, comprobación de tipo y almacén inbox`

---

### Tarea 4: Servidor HTTPS y `TransferService`

**Files:**
- Create: `src/core/transfer/{server,service,index}.ts`, `apps/desktop/scripts/dev-server.ts`
- Test: `__tests__/service.test.ts`, `__tests__/core-isolation.test.ts`

**Interfaces:**
- Consumes: Tareas 2 y 3.
- Produces:
  - `type QrPayload = { v: 1; hosts: string[]; port: number; fp: string; secret: string; exp: string }`
  - `type TransferEvent = { type: 'paired'; deviceName: string } | { type: 'package-received'; pkg: ReceivedPackage } | { type: 'closed'; reason: 'stopped' | 'too-many-attempts' | 'inactive' } | { type: 'error'; code: ErrorCode; message: string }`
  - `class TransferService { constructor(opts: { dataDir: string; now?: () => number; hosts?: () => string[] }); start(): Promise<{ qr: QrPayload; qrText: string }>; stop(): Promise<void>; listReceived(): Promise<ReceivedPackage[]>; packageDir(packageId: string): string; on(listener: (e: TransferEvent) => void): () => void }`
  - `qrText` = `JSON.stringify(qr)`. `start()` con sesión activa la detiene y crea otra (regenerar QR). `packageDir` lanza si `packageId` no es UUID.
  - `dataDir/tls/` para el certificado; `dataDir/inbox/` para el almacén.

Reglas del servidor (`node:https`, sin framework): rutas exactas de la spec §6; `POST /v1/pair` sin token; resto con `Authorization: Bearer`; cuerpos JSON ≤ 1 MB (si no, `invalid_manifest`); `PUT` lee el cuerpo como stream hacia `Inbox.storeFile` y responde `204`; ruta desconocida → `not_found`; cualquier excepción no prevista → 500 con `{error:{code:"internal",…}}` sin traza. `start()` llama `inbox.cleanup()` antes de escuchar. `stop()` usa `server.close()` + `server.closeAllConnections()`. El cierre de `PairingSession` (intentos o inactividad) detiene el servidor y emite `closed`. *El cuerpo 500 con `internal` es decisión de este plan.*

- [ ] **Paso 1: Escribir las pruebas que fallan**

`service.test.ts` levanta `TransferService` real en un `tmpdir` con `hosts: () => ['127.0.0.1']` y usa `undici`/`https.request` con `ca: certPem` y `checkServerIdentity: () => undefined`:
- `qr` válido contra `qrSchema`; la huella coincide con el certificado que presenta el servidor (`socket.getPeerCertificate().raw`).
- TLS 1.2 forzado en el cliente (`maxVersion: 'TLSv1.2'`) → falla el handshake.
- flujo completo pair → packages → PUT ×3 → commit: respuesta `200` con recibo; se emiten `paired` y `package-received` en ese orden.
- `PUT` sin token → 401 `unauthorized`; con token → OK.
- secreto incorrecto ×5 → evento `closed` `too-many-attempts` y el puerto deja de aceptar conexiones (`ECONNREFUSED`).
- `stop()` → `ECONNREFUSED` en el mismo puerto (criterio 5 de la spec).
- reenvío del mismo paquete tras `commit`: `missing: []`, mismo recibo, un solo `package-received` (criterio 2).
- **(Foco 4)** manifiesto con `name: "../../etc/passwd"` se acepta; tras `commit`, ningún archivo existe fuera de `dataDir/inbox/<package_id>/` (recorrer `dataDir`).
- `packageDir('../x')` lanza.
- cuerpo JSON de 2 MB en `/v1/packages` → 400 `invalid_manifest`.

`core-isolation.test.ts`: recorre `src/core/**/*.ts` y falla si algún archivo contiene `from 'electron'`, `require('electron')` o `from 'react'` (criterio 6).

- [ ] **Paso 2: Ejecutar y ver que fallan** — FAIL.
- [ ] **Paso 3: Implementar** `server.ts`, `service.ts`, `index.ts`.
- [ ] **Paso 4: `scripts/dev-server.ts`** — arranca `TransferService` en `./.dev-data`, imprime `qrText` en una línea `QR:<json>` y cada evento como JSON; termina con SIGINT. Script `"dev:server": "tsx scripts/dev-server.ts"` (`tsx` como dev dep exacta). Añadir `.dev-data/` al `.gitignore`.
- [ ] **Paso 5: Ejecutar y ver que pasan** — `npm test -w apps/desktop` → PASS.
- [ ] **Paso 6: Commit** — `feat(desktop): servidor HTTPS /v1 y TransferService`

---

### Tarea 5: Carcasa Electron y UI del PC

**Files:**
- Create: `apps/desktop/electron.vite.config.ts`, `src/main/{index,ipc}.ts`, `src/preload/index.ts`, `src/renderer/{index.html,main.tsx,App.tsx}`, `src/renderer/components/{QrPanel,PackageCard,PackageList}.tsx`, `src/shared/ipc.ts`
- Test: `src/renderer/__tests__/PackageCard.test.tsx`

**Interfaces:**
- Consumes: `TransferService`, `TransferEvent`, `ReceivedPackage`, `QrPayload` (Tarea 4).
- Produces (`src/shared/ipc.ts`, expuesto como `window.fodibo` en el preload):
  ```ts
  interface FodiboApi {
    startReceiving(): Promise<{ qrDataUrl: string; expiresAt: string }>;
    stopReceiving(): Promise<void>;
    listReceived(): Promise<ReceivedPackage[]>;
    openPackage(packageId: string): Promise<void>;
    onEvent(cb: (e: TransferEvent) => void): () => void;
  }
  ```
  Canales: `transfer:start`, `transfer:stop`, `transfer:list`, `transfer:open`, `transfer:event`.

Requisitos: `BrowserWindow` con `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; CSP `default-src 'self'; img-src 'self' data:`; `setWindowOpenHandler` → deny; `will-navigate` bloqueado. El QR se genera en main con `qrcode.toDataURL(qrText)`. `transfer:open` valida UUID y usa `shell.openPath(service.packageDir(id))`. `window-all-closed` y `before-quit` → `service.stop()` y salir (también en macOS). `dataDir` = `app.getPath('userData')`.

UI según spec §7 (textos en español): botón «Recibir del móvil»; QR con cuenta atrás mm:ss y «Detener»; al caducar sin emparejar: «El código caducó. Comprueba que el móvil está en la misma red Wi-Fi y que el cortafuegos permite FODIBO.» con botón «Generar otro código»; al emparejar: «Conectado con *{deviceName}*» y el QR desaparece; `closed` → vuelve al estado inicial con el motivo; tarjeta por paquete: fecha local, dispositivo, filas con nombre, tipo, tamaño legible (KB/MB) y «✓ Integridad verificada», botón «Abrir carpeta». Lista cargada con `listReceived()` al iniciar; los paquetes nuevos se insertan arriba.

- [ ] **Paso 1: Escribir la prueba que falla**

`PackageCard.test.tsx` (Vitest + `@testing-library/react`, entorno `jsdom`): con un `ReceivedPackage` de 3 archivos renderiza `Pixel 8`, los 3 nombres (incluido `Quittung Zürich 🧾.jpg`), `2,4 MB` para 2 481 930 bytes (*formato decimal con coma: decisión de este plan*) y 3 marcas «Integridad verificada».

- [ ] **Paso 2: Ejecutar y ver que falla** — FAIL.
- [ ] **Paso 3: Implementar** main, preload, IPC y componentes.
- [ ] **Paso 4: Ejecutar pruebas** — `npm test -w apps/desktop` → PASS.
- [ ] **Paso 5: Comprobar la app**

Run: `npm run dev -w apps/desktop`. Expected: ventana abre; «Recibir del móvil» muestra QR y cuenta atrás; «Detener» lo quita; `lsof -iTCP -sTCP:LISTEN -P | grep -i electron` muestra el puerto solo con la sesión abierta. Con la sesión abierta, ejecutar el flujo de `service.test.ts` contra el puerto mostrado no es necesario: basta con la Tarea 7.

- [ ] **Paso 6: Commit** — `feat(desktop): carcasa Electron e interfaz de recepción`

---

### Tarea 6: Proyecto Flutter y contratos en Dart

**Files:**
- Create: `apps/mobile/` (con `flutter create --org ch.fodibo --project-name fodibo_transfer --platforms android apps/mobile`), `lib/transfer/{errors,contracts,local_file}.dart`
- Test: `test/transfer/contracts_test.dart`, `test/transfer/local_file_test.dart`

**Interfaces:**
- Produces:
  - `class TransferException implements Exception { final String code; final String message; }` — `code` usa los códigos del contrato más los del cliente: `fingerprint_mismatch`, `unreachable`, `expired_qr`, `invalid_qr`, `session_closed`.
  - `class QrPayload { final List<String> hosts; final int port; final String fp; final String secret; final DateTime exp; static QrPayload parse(String text); }` — lanza `TransferException('invalid_qr')` ante cualquier violación del esquema.
  - `class ManifestFile { fileId, name, mime, size, sha256; Map<String,Object?> toJson(); }`, `class Manifest { packageId, createdAt, deviceName, files; toJson(); }`
  - `class Receipt { packageId, receivedAt, files; static Receipt fromJson(Map<String,Object?>); }` — lanza `FormatException` si no cumple el esquema.
  - `class LocalFile { final String path, name, mime; final int size; final String sha256; static Future<LocalFile> fromPath(String path, {String? name}); }`
  - `String? mimeForName(String name)` — por extensión (sin distinguir mayúsculas): `jpg|jpeg`, `png`, `heic|heif`, `pdf`, `json`; otro → `null`.
  - `String newUuidV4()` — prueba: 1000 llamadas dan valores únicos que cumplen `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`.
  - `List<String> precheck(LocalFile f)` — devuelve códigos `unsupported_type` / `too_large` (50 MB).

- [ ] **Paso 1: Instalar Flutter**

Run: `brew install --cask flutter && flutter doctor && flutter doctor --android-licenses`. Expected: `flutter doctor` sin errores en *Flutter* ni *Android toolchain* (Xcode/Chrome pueden quedar en aviso).

- [ ] **Paso 2: Crear el proyecto** con el comando de arriba; dependencia `crypto`; dev `test`. Sin `uuid`: la spec limita `transfer_client` a `dart:io` y `crypto`, así que los UUID v4 se generan con `Random.secure()` en `contracts.dart` (`String newUuidV4()`). Fijar versiones exactas en `pubspec.yaml` y el SDK de Dart en `environment`.

- [ ] **Paso 3: Escribir las pruebas que fallan**

`contracts_test.dart` lee `../../packages/contracts/vectors/qr/**` y `receipt/**` (ruta relativa al paquete; `flutter test` corre con cwd en `apps/mobile`):
- cada `qr/valid/*` → `QrPayload.parse` no lanza; cada `qr/invalid/*` → `TransferException` con `code == 'invalid_qr'`.
- cada `receipt/valid/*` → `Receipt.fromJson` OK; `receipt/invalid/*` → `FormatException`.
- `Manifest.toJson()` de un manifiesto construido a partir de `manifest/valid/three-types.json` vuelve a dar exactamente ese JSON.
- `QrPayload.parse('no es json')` → `invalid_qr`.

`local_file_test.dart`: `fromPath` de un archivo temporal con `{"a":1}` da `size` 7 y el SHA-256 conocido (`015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862`); `mimeForName('FOTO.JPG') == 'image/jpeg'`; `mimeForName('x.gif') == null`; `precheck` marca `too_large` para `size` 52 428 801.

- [ ] **Paso 4: Ejecutar y ver que fallan** — `cd apps/mobile && flutter test test/transfer` → FAIL.
- [ ] **Paso 5: Implementar** `errors.dart`, `contracts.dart` (validación a mano, mismas reglas que los esquemas), `local_file.dart` (hash en streaming con `sha256.bind(file.openRead())`).
- [ ] **Paso 6: Ejecutar y ver que pasan** — PASS.
- [ ] **Paso 7: Commit** — `feat(mobile): proyecto Flutter y contratos v1 en Dart`

---

### Tarea 7: `TransferClient` en Dart con certificado fijado

**Files:**
- Create: `lib/transfer/{pinned_client,transfer_client}.dart`, `test/fixtures/` (certificados de prueba), `test/transfer/fake_server.dart`
- Test: `test/transfer/transfer_client_test.dart`, `test/transfer/interop_test.dart`

**Interfaces:**
- Consumes: Tarea 6; `dev-server.ts` (Tarea 4) para interoperabilidad.
- Produces:
  - `HttpClient createPinnedHttpClient(String fingerprint)` — `HttpClient(context: SecurityContext(withTrustedRoots: false))`, `badCertificateCallback` devuelve `true` solo si `"sha256:" + hex(sha256(cert.der)) == fingerprint`; `connectionTimeout` 3 s.
  - `class TransferClient { static Future<TransferClient> connect(QrPayload qr, {required String deviceName, DateTime Function()? now}); Future<Receipt> send(List<LocalFile> files, {String? packageId, void Function(String sha256, int sent, int total)? onProgress}); void close(); }`
  - `connect`: si `now() > qr.exp` → `expired_qr` sin conectar; prueba cada host en orden; huella distinta → `fingerprint_mismatch` (no prueba más hosts); ningún host responde → `unreachable`; `401` → `TransferException('invalid_secret')`.
  - `send`: genera `packageId` (UUID v4) si no se pasa; anuncia; sube solo `missing`; confirma. Errores de red o 5xx: hasta 4 reintentos con espera 1 s, 2 s, 4 s, 8 s y vuelve a anunciar antes de reanudar. `hash_mismatch` repetido 2 veces, `unsupported_type` y `too_large` son definitivos: lanza `TransferException` con `code` y, en un campo `String? fileSha256`, el archivo culpable. `401` en mitad → `session_closed`.

- [ ] **Paso 1: Certificados de prueba**

`openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 3650 -subj /CN=test -keyout test/fixtures/server.key -out test/fixtures/server.pem` y otro par `other.*`. Añadir con `git add -f` (el `.gitignore` excluye `*.pem` y `*.key`); son solo para pruebas.

- [ ] **Paso 2: Escribir las pruebas que fallan**

`fake_server.dart`: `HttpServer.bindSecure` en `127.0.0.1:0` con `server.pem`, implementa `/v1` en memoria con ganchos para inyectar fallos (cortar la conexión tras N bytes, responder 5xx una vez, devolver `missing` parcial).

`transfer_client_test.dart`:
- huella correcta → `send` de 3 archivos devuelve recibo con 3 entradas y el servidor tiene los 3 hashes.
- huella del certificado `other.pem` → `fingerprint_mismatch` y el servidor no recibe ninguna petición (spec §11).
- QR caducado → `expired_qr` sin conexiones.
- primer host `10.255.255.1` (no enrutable), segundo `127.0.0.1` → conecta con el segundo.
- corte a mitad del 2.º archivo → reintenta, reanuncia y no vuelve a subir el 1.º (contador de `PUT` por hash == 1).
- servidor rechaza un archivo con `unsupported_type` → `TransferException` con ese `code` y `fileSha256`.
- `send` dos veces con el mismo `packageId` → mismo recibo, sin `PUT` en la segunda.

`interop_test.dart` con `@Tags(['interop'])`: lanza `npm run dev:server -w apps/desktop` (`Process.start`, cwd raíz del repo), lee la línea `QR:`, envía un JPEG, un PDF y un JSON, y comprueba el recibo. Esta prueba valida la fijación de huella entre Node y Dart.

- [ ] **Paso 3: Ejecutar y ver que fallan** — `flutter test test/transfer --exclude-tags interop` → FAIL.
- [ ] **Paso 4: Implementar** `pinned_client.dart` y `transfer_client.dart` (subida en streaming con `request.contentLength = size` y `addStream(file.openRead())`).
- [ ] **Paso 5: Ejecutar y ver que pasan**

Run: `flutter test test/transfer --exclude-tags interop` → PASS; luego `flutter test test/transfer --tags interop` → PASS.

- [ ] **Paso 6: Aislamiento** — `grep -rn "package:flutter" lib/transfer` → sin resultados.
- [ ] **Paso 7: Commit** — `feat(mobile): cliente de transferencia con certificado fijado y reanudación`

---

### Tarea 8: UI móvil

**Files:**
- Create: `lib/main.dart`, `lib/ui/{app,scan_screen,send_screen,receipt_view}.dart`
- Modify: `android/app/src/main/AndroidManifest.xml` (permisos `INTERNET`, `CAMERA`), `pubspec.yaml` (`mobile_scanner`, `file_picker`, `device_info_plus`)
- Test: `test/ui/send_screen_test.dart`

**Interfaces:**
- Consumes: `QrPayload`, `TransferClient`, `LocalFile`, `precheck`, `Receipt`, `TransferException` (Tareas 6–7).
- `SendScreen` recibe por constructor `Future<Receipt> Function(List<LocalFile>, {String? packageId, ...}) send` para poder probarla sin red.

Pantallas según spec §7: «Escanear código del PC» → escáner (`mobile_scanner`) → `connect` con `deviceName` = modelo de `device_info_plus` → «Conectado» + «Elegir archivos» (`file_picker`, `allowMultiple: true`, extensiones jpg, jpeg, png, heic, heif, pdf, json) → lista con aviso por archivo si `precheck` falla (esos no se envían) → «Enviar» con progreso por archivo → recibo con la lista confirmada y «Enviar más».

Mensajes de error (texto exacto, decisión de este plan):
- `expired_qr` / `invalid_secret`: «El código caducó o ya se usó. Genera uno nuevo en el PC.»
- `fingerprint_mismatch`: «El PC no es el esperado. No se envió nada.»
- `unreachable`: «No se encontró el PC. Comprueba que ambos están en la misma red Wi-Fi.»
- `session_closed`: vuelve a la pantalla de escaneo con «La sesión en el PC terminó.»
- `unsupported_type` / `too_large` / `hash_mismatch` en un archivo: «El PC rechazó *{nombre}*.» con botón «Enviar el resto» (nuevo `packageId`, sin ese archivo).
- reintentos agotados: «Se perdió la conexión.» con «Reintentar» (mismo `packageId`).

- [ ] **Paso 1: Escribir las pruebas que fallan** (`testWidgets`, `send` simulado):
  - con 2 archivos válidos y uno `.gif`, el `.gif` aparece marcado y `send` recibe 2 archivos.
  - `send` lanza `unsupported_type` para el 2.º → aparece «El PC rechazó …»; pulsar «Enviar el resto» llama `send` con 1 archivo y un `packageId` distinto.
  - `send` lanza `unreachable` tras reintentos → «Reintentar» llama `send` con el mismo `packageId`.
- [ ] **Paso 2: Ejecutar y ver que fallan** — `flutter test test/ui` → FAIL.
- [ ] **Paso 3: Implementar** pantallas y permisos.
- [ ] **Paso 4: Ejecutar y ver que pasan** — `flutter test` → PASS (todas las pruebas salvo `interop`).
- [ ] **Paso 5: Compilar** — `flutter build apk --debug` → genera `build/app/outputs/flutter-apk/app-debug.apk`.
- [ ] **Paso 6: Commit** — `feat(mobile): interfaz de escaneo, selección y envío`

---

### Tarea 9: Prueba extremo a extremo manual

**Files:**
- Create: `docs/superpowers/notes/2026-11-10-e2e-transferencia.md` (resultado de cada comprobación)

- [ ] **Paso 1:** Instalar en un Android real: `adb install -r apps/mobile/build/app/outputs/flutter-apk/app-debug.apk`. Mac y móvil en la misma Wi-Fi. `npm run dev -w apps/desktop`; aceptar el aviso del cortafuegos de macOS si aparece.
- [ ] **Paso 2: Criterio 1** — enviar una foto, un PDF y un JSON. Expected: tarjeta en el PC y recibo en el móvil; `shasum -a 256` de cada archivo en `inbox/<id>/files/` coincide con su nombre.
- [ ] **Paso 3: Criterio 2** — repetir el envío con el mismo paquete («Reintentar» tras forzar el fallo o reinicio del envío). Expected: sin tarjeta ni archivos duplicados.
- [ ] **Paso 4: Criterio 4** — enviar un PDF grande (~40 MB) y desactivar la Wi-Fi del móvil a mitad; reactivarla. Expected: se completa y en el registro de `dev`/consola solo hay un `PUT` completo por archivo ya recibido.
- [ ] **Paso 5: Criterio 3** — escanear un QR ya usado desde otro móvil o tras caducar. Expected: mensaje de código caducado; nada recibido.
- [ ] **Paso 6: Criterio 5** — pulsar «Detener» y luego `nc -vz <ip> <puerto>` desde otro equipo o `lsof -iTCP -sTCP:LISTEN -P`. Expected: puerto cerrado.
- [ ] **Paso 7: Egreso** — con Little Snitch, `nettop` o `sudo tcpdump -i en0 'not net 192.168.0.0/16 and not net 10.0.0.0/8 and not net 172.16.0.0/12'` durante un envío. Expected: ninguna conexión de FODIBO fuera de la LAN (puede haber tráfico de otras apps).
- [ ] **Paso 8:** Anotar resultados y problemas en la nota; commit `docs: resultados de la prueba extremo a extremo`.
