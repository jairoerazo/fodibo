# Prototipo de transferencia móvil → PC — Diseño

**Fecha:** 10 de noviembre de 2026
**Estado:** borrador pendiente de aprobación
**Referencia:** `docs/system/FODIBO_Arquitectura_actualizada.md` (v2.1), §3, §4.2, §5 y §8

## 1. Intención

Construir el primer incremento de FODIBO: una pareja de aplicaciones mínimas que permita enviar fotos, PDF y JSON desde un móvil Android a un computador por la red local, y que el computador muestre una confirmación de los archivos recibidos.

El motivo no es la utilidad del prototipo en sí, sino validar pronto la parte más incierta del canal LAN de la arquitectura (emparejamiento por QR, TLS con certificado fijado, integridad por hash, reintentos sin duplicados) con código que después se integre en FODIBO en lugar de desecharse.

Hoy no existe código en este repositorio: ni la app móvil de FODIBO ni la de escritorio. El código Flutter existente se integrará más adelante.

## 2. Objetivos, no-objetivos y anti-objetivos

**Objetivos**

1. Desde el móvil, seleccionar uno o varios archivos (JPEG, PNG, HEIC, PDF, JSON) y enviarlos al PC por la LAN.
2. El PC muestra una confirmación por envío: nombre, tipo, tamaño y verificación de integridad de cada archivo. El móvil muestra el mismo recibo.
3. El canal usa el contrato de §5 de la arquitectura en su versión mínima: QR con dirección, huella del certificado y secreto de un solo uso con caducidad; HTTPS local; hashes SHA-256; envío idempotente por `package_id`.
4. La lógica de transferencia de ambos lados queda aislada de la UI para poder trasladarla a FODIBO.

**No-objetivos** (quedan para incrementos posteriores)

- Transporte por archivo `.fodibo` cifrado.
- Cifrado en reposo (SQLCipher, libsodium) y almacén seguro de claves.
- Modelo de expediente, documentos, campos, revisiones y conflictos.
- Sincronización PC → móvil (confirmaciones de revisión, correcciones).
- Emparejamiento persistente y revocación de dispositivos: aquí cada sesión se empareja de nuevo.
- Captura con cámara, OCR y extracción.
- iOS, instaladores firmados y Windows empaquetado. Se desarrolla y prueba en macOS + Android.

**Anti-objetivos** (harían fracasar el prototipo aunque «funcione»)

- Que algún dato salga de la red local o pase por un servicio externo.
- Que el PC acepte archivos de un cliente que no escaneó el QR de la sesión vigente.
- Que el PC confirme la recepción de un archivo incompleto o alterado.
- Que el servidor quede escuchando en la LAN fuera de una sesión iniciada por el usuario.
- Que la lógica de transferencia quede acoplada a la UI del prototipo y haya que reescribirla.

## 3. Evaluación de Electron + TypeScript para el escritorio

**Conclusión: es una buena decisión para FODIBO y se mantiene, con una condición de diseño.**

Lo que decide la elección no es la sincronización ni la UI de revisión, que cualquier alternativa resuelve, sino el agente navegador. FODIBO necesita rellenar un portal oficial en una sesión aislada, con operaciones tipadas, bloqueo de solicitudes de presentación y verificación de cada paso. Electron incluye un Chromium de versión fija y lo expone mediante `WebContentsView`, `session` y `webContents.debugger` (CDP interno). Eso hace que el comportamiento del adaptador sea reproducible en Windows, macOS y Linux.

| Alternativa | Por qué no ahora |
| --- | --- |
| Tauri | Usa el WebView del sistema (WebView2, WKWebView, WebKitGTK): tres motores distintos, sin CDP uniforme. El adaptador del portal tendría que probarse y mantenerse por motor. Solo convendría si la navegación se externalizara a un navegador aparte. |
| Flutter Desktop | Compartiría Dart con el móvil, pero su soporte de WebView en escritorio es parcial y de terceros; justo el componente central sería el más débil. |
| Qt WebEngine | Técnicamente viable, pero añade C++/Python y su distribución sin ventaja para este flujo. |

**Costes reales que hay que aceptar**

- Tamaño y memoria: instalador de más de 100 MB y unos cientos de MB en uso, que se suman al modelo local (llama.cpp) en el mismo equipo. Hay que medirlo en el hardware mínimo objetivo.
- Mantenimiento de seguridad: Chromium exige actualizar Electron con frecuencia, y las actualizaciones de FODIBO se importan a mano. Conviene decidir pronto una cadencia de versiones.
- Módulos nativos: SQLCipher y cualquier binding nativo deben recompilarse para cada versión de Electron. Es el riesgo técnico más probable y debe validarse antes de depender de él.
- Dos lenguajes: Dart en móvil y TypeScript en escritorio obligan a implementar el contrato dos veces. Se mitiga con JSON Schema como fuente única y vectores de prueba compartidos.

**Condición de diseño:** el núcleo (transferencia, expediente, reglas) se escribe en TypeScript puro sobre Node.js, sin importar nada de Electron. Electron es una carcasa: ventana, IPC y, más adelante, navegador. Así el núcleo se prueba sin interfaz y la decisión es reversible si la validación del portal falla.

**Para este prototipo:** se usa ya Electron con una carcasa mínima. El coste adicional es pequeño y permite descubrir pronto problemas propios del empaquetado (permiso de red local en macOS, cortafuegos, ciclo de vida del servidor al cerrar la ventana).

## 4. Decisiones de construcción

Ninguna de estas fue acordada todavía: son propuestas de este diseño y quedan abiertas a corrección.

| Decisión | Propuesta | Motivo |
| --- | --- | --- |
| Cliente móvil | App Flutter mínima para Android | Es el stack del FODIBO existente; el cliente de transferencia en Dart se integra tal cual. Una página web servida por el PC sería más rápida de hacer, pero no puede fijar el certificado y sería desechable. Requiere instalar el SDK de Flutter (no está en este equipo; Android Studio y `adb` sí). |
| Escritorio | Electron + React + TypeScript + Vite | Ver §3. |
| Persistencia en PC | Sistema de archivos + recibo JSON por paquete, sin base de datos | El expediente y SQLCipher son otro incremento; un recibo JSON basta para idempotencia. |
| Emparejamiento | Por sesión, sin identidad persistente del móvil | Reduce el alcance; la revocación llega con el emparejamiento persistente. |
| Estructura del repositorio | Monorepo: `apps/desktop`, `apps/mobile`, `packages/contracts` | Un solo lugar para el contrato y sus vectores de prueba. |
| Gestor de paquetes | npm workspaces | Ya instalado; sin dependencias nuevas de herramienta. |

**Qué significa «integrable» en el móvil.** El código fuente del FODIBO actual no está disponible todavía, así que no se conocen su versión de Flutter/Dart, su `minSdk` ni sus dependencias. Por eso `transfer_client` se limita a Dart puro con las mínimas dependencias posibles (`dart:io` y `crypto`) y no usa características recientes del lenguaje sin necesidad. La app del prototipo usa la versión estable actual de Flutter; al integrar habrá que ajustar versiones contra el `pubspec` real.

## 5. Arquitectura

```
┌──────────── Móvil (Flutter) ────────────┐        ┌────────────── PC (Electron) ──────────────┐
│ UI: escanear QR · elegir · progreso     │        │ Renderer (React): QR · lista de recibidos │
│            │                            │        │            ▲ IPC tipado                   │
│ transfer_client (Dart puro)             │ HTTPS  │ Main: ciclo de vida, puente IPC           │
│  empareja · manifiesto · sube · confirma│ ─────► │            │                              │
│  fija la huella del certificado         │  LAN   │ transfer-core (TS puro, sin Electron)     │
└─────────────────────────────────────────┘        │  sesión · servidor HTTPS · almacén inbox  │
                                                   └───────────────────────────────────────────┘
```

**Unidades y fronteras**

| Unidad | Qué hace | Depende de |
| --- | --- | --- |
| `packages/contracts` | JSON Schema del QR, manifiesto, recibo y errores; vectores de prueba (ejemplos válidos e inválidos). | Nada. |
| `apps/desktop/src/core/transfer` (`transfer-core`) | Genera el certificado, abre y cierra la sesión, sirve el protocolo, valida y persiste, emite eventos (`paired`, `package-received`, `error`). | Node.js, `contracts`. Nunca Electron ni React. |
| `apps/desktop/src/main` | Inicia/detiene sesiones a petición de la UI y reenvía eventos por IPC. Detiene el servidor al cerrar la ventana. | Electron, `transfer-core`. |
| `apps/desktop/src/renderer` | Botón «Recibir del móvil», QR, estado de la sesión, lista de paquetes recibidos. | React, IPC. |
| `apps/mobile/lib/transfer` (`transfer_client`) | Interpreta el QR, empareja con certificado fijado, calcula hashes, sube y confirma con reintentos. | Dart puro (`dart:io`, `crypto`). Nunca Flutter. |
| `apps/mobile/lib/ui` | Escáner de QR, selector de archivos, progreso, recibo. | Flutter, `transfer_client`. |

## 6. Protocolo (versión 1)

Todas las rutas van bajo `/v1`. El servidor escucha solo mientras hay una sesión abierta, en un puerto aleatorio, con TLS 1.3 y un certificado autofirmado.

**Certificado.** Se genera al primer uso y se conserva en el directorio de datos de la app, de modo que la huella sea estable entre sesiones. La huella es el SHA-256 del certificado en DER.

**Contenido del QR** (JSON compacto):

```json
{
  "v": 1,
  "hosts": ["192.168.1.20"],
  "port": 49321,
  "fp": "sha256:<hex>",
  "secret": "<128 bits aleatorios, base64url>",
  "exp": "2026-11-10T21:30:00Z"
}
```

`hosts` lista las direcciones IPv4 privadas del PC; el móvil prueba cada una hasta que conecta y la huella coincide. El secreto caduca a los 5 minutos y se invalida al primer uso.

**Intercambios**

| Paso | Petición | Respuesta |
| --- | --- | --- |
| 1. Emparejar | `POST /v1/pair` `{secret, device_name}` | `{session_token}`. El token vale hasta que el usuario cierra la sesión en el PC o pasan 30 min sin actividad. |
| 2. Anunciar | `POST /v1/packages` con manifiesto | `{package_id, missing: [sha256…]}`: hashes que el PC aún no tiene para ese paquete. |
| 3. Subir | `PUT /v1/packages/{package_id}/files/{sha256}` con el contenido en el cuerpo | `204` tras verificar tamaño y hash. |
| 4. Confirmar | `POST /v1/packages/{package_id}/commit` | Recibo de importación. |

Los pasos 2 a 4 llevan `Authorization: Bearer <session_token>`.

**Manifiesto**

```json
{
  "schema_version": 1,
  "package_id": "<UUID generado en el móvil>",
  "created_at": "2026-11-10T21:26:10Z",
  "device_name": "Pixel 8",
  "files": [
    { "file_id": "<UUID>", "name": "recibo.jpg", "mime": "image/jpeg", "size": 2481930, "sha256": "<hex>" }
  ]
}
```

**Recibo**

```json
{
  "schema_version": 1,
  "package_id": "<UUID>",
  "received_at": "2026-11-10T21:26:14Z",
  "files": [
    { "file_id": "<UUID>", "name": "recibo.jpg", "mime": "image/jpeg", "size": 2481930, "sha256": "<hex>", "status": "stored" }
  ]
}
```

**Reglas del servidor**

- **Todo o nada.** Un paquete se confirma solo si todos los archivos del manifiesto están almacenados; no hay confirmaciones parciales. En el recibo, `status` vale siempre `stored` y se conserva para versiones futuras. Si el PC rechaza un archivo de forma definitiva (`unsupported_type`, `too_large` o `hash_mismatch` repetido), el paquete no puede confirmarse: el móvil indica qué archivo falló y ofrece reenviar el resto, lo que crea un paquete nuevo con otro `package_id`. Los archivos ya subidos se vuelven a enviar; la deduplicación entre paquetes no entra en este prototipo.
- **Idempotencia.** Repetir el anuncio de un `package_id` ya confirmado devuelve `missing: []`; repetir `commit` devuelve el mismo recibo. Un `package_id` reutilizado con un manifiesto distinto se rechaza con `409`.
- **Orden de persistencia** (§4.2 de la arquitectura). Cada archivo se escribe en un temporal, se verifica y se renombra de forma atómica. El recibo se escribe al final: su existencia es lo que marca el paquete como recibido. Al abrir una sesión se borran los temporales y paquetes sin recibo de más de 24 h.
- **Validación.** Manifiesto contra JSON Schema; tipos permitidos `image/jpeg`, `image/png`, `image/heic`, `application/pdf`, `application/json`; máximo 50 MB por archivo, 100 archivos y 500 MB por paquete. El tipo se comprueba además por los primeros bytes del contenido (los JSON deben poder interpretarse).
- **Rutas.** El nombre original es solo un dato del manifiesto. En disco los archivos se nombran por su hash; nunca se construye una ruta con texto recibido del cliente.
- **Autenticación.** Secreto incorrecto, caducado o ya usado: `401`. Tras 5 intentos fallidos se cierra la sesión y hay que generar otro QR.

**Errores.** Cuerpo `{ "error": { "code": "…", "message": "…" } }` con códigos estables: `invalid_secret`, `unauthorized`, `invalid_manifest`, `unsupported_type`, `too_large`, `hash_mismatch`, `package_conflict`, `incomplete_package`.

**Almacenamiento en el PC**

```
<datos de la app>/
  tls/cert.pem, key.pem
  inbox/<package_id>/
    manifest.json
    files/<sha256>
    receipt.json        ← presente solo si el paquete está completo
```

## 7. Experiencia de uso

**PC**

1. Pantalla inicial con el botón «Recibir del móvil» y, debajo, la lista de paquetes ya recibidos (se reconstruye leyendo los recibos de `inbox/`).
2. Al pulsar, se abre la sesión y aparece el QR con una cuenta atrás de caducidad y el botón «Detener».
3. Al emparejar: «Conectado con *Pixel 8*». El QR desaparece.
4. Al confirmar un paquete, aparece arriba de la lista una tarjeta: fecha, dispositivo y una fila por archivo con nombre, tipo, tamaño y marca de integridad verificada. Un botón abre la carpeta del paquete.
5. «Detener» o cerrar la ventana apaga el servidor.

**Móvil**

1. Pantalla inicial con «Escanear código del PC».
2. Tras escanear y emparejar: «Conectado», con el botón «Elegir archivos» (selector del sistema, selección múltiple).
3. Lista de archivos elegidos con «Enviar». Durante el envío, progreso por archivo.
4. Al terminar, el recibo: la lista de archivos que el PC confirmó (todos los del envío). Desde ahí se pueden enviar más mientras dure la sesión.

**Fallos visibles para el usuario**

| Situación | Comportamiento |
| --- | --- |
| QR caducado o ya usado | El móvil pide generar un código nuevo en el PC. |
| La huella del certificado no coincide | El móvil corta la conexión y avisa; no envía nada. |
| Se corta la Wi-Fi a mitad de envío | El móvil reintenta con espera creciente; al reanudar pregunta al PC qué falta y sube solo eso. Si se agotan los reintentos, ofrece «Reintentar» conservando el mismo `package_id`. |
| Archivo de tipo no permitido o demasiado grande | El móvil lo marca antes de enviar; el PC lo rechaza igualmente si llega. |
| Sesión cerrada en el PC | El móvil vuelve a la pantalla de escaneo. |

## 8. Pruebas

- **Contrato:** los vectores de `packages/contracts` se validan desde TypeScript (Ajv) y desde Dart. Ambos lados deben aceptar y rechazar los mismos ejemplos.
- **`transfer-core` (Vitest):** se levanta el servidor real en `localhost` y se ejercita con un cliente HTTP de prueba. Casos: flujo completo; secreto incorrecto, caducado y reutilizado; token ausente; hash que no coincide; tamaño excedido; tipo no permitido; nombre con `../`; reanudación con `missing` parcial; `commit` incompleto; reimportación idempotente; conflicto de `package_id`; limpieza de temporales.
- **`transfer_client` (`dart test`):** contra un servidor HTTPS simulado. Casos: huella correcta e incorrecta; reintentos; reanudación; interpretación de QR inválido.
- **Extremo a extremo (manual):** móvil Android real y Mac en la misma Wi-Fi, con una foto, un PDF y un JSON. Repetir cortando la Wi-Fi a mitad y comprobando que no hay duplicados. Comprobar con una captura de tráfico que no hay conexiones fuera de la LAN.

## 9. Criterios de aceptación

1. Un envío de foto + PDF + JSON termina con la tarjeta de confirmación en el PC y el recibo en el móvil, y los hashes en disco coinciden con los originales.
2. Reenviar el mismo paquete no crea archivos ni tarjetas duplicados.
3. Un cliente sin el secreto vigente no consigue subir nada.
4. Un envío interrumpido se completa al reintentar sin volver a subir lo ya recibido.
5. Con la sesión detenida, el puerto está cerrado.
6. `transfer-core` no importa Electron y `transfer_client` no importa Flutter; ambos pasan sus pruebas sin interfaz.

## 10. Queda a criterio de quien construya

- Bibliotecas concretas: generación de certificados y QR en Node; escáner de QR y selector de archivos en Flutter.
- Framework HTTP del servidor (o `node:https` directo).
- Diseño visual, siempre que cubra los estados de §7.
- Tamaños de espera y número de reintentos.
- Versiones exactas de Electron, Node y Flutter, fijadas en el repositorio.

## 11. Riesgos conocidos

- **Permiso de red local en macOS y aislamiento de clientes en algunos routers** pueden impedir la conexión aunque el código sea correcto. La app debe mostrar un mensaje útil cuando nadie se conecta dentro del tiempo del QR.
- **HEIC:** Android suele entregar JPEG, pero el selector puede devolver HEIC; se almacena sin convertir.
- **Fijación de certificado en Dart:** se implementa con un `SecurityContext` sin raíces de confianza y comparación de la huella en `badCertificateCallback`. Debe probarse de forma explícita que una huella distinta se rechaza.
