# FODIBO — prototipo de transferencia móvil → PC

Prototipo que envía archivos (JPEG, PNG, HEIC, PDF, JSON) desde un móvil Android a un PC por la red local, sin
pasar por ningún servicio externo: el PC muestra un QR, el móvil lo escanea, se empareja por HTTPS con el
certificado fijado y sube los archivos verificando su SHA-256. Diseño y protocolo:
[docs/superpowers/specs/2026-11-10-prototipo-transferencia-movil-pc-design.md](docs/superpowers/specs/2026-11-10-prototipo-transferencia-movil-pc-design.md).

| Parte | Qué es |
| --- | --- |
| `packages/contracts` | Esquemas JSON (QR, manifiesto, recibo, error) y vectores de prueba compartidos. |
| `apps/desktop` | App de escritorio Electron + TypeScript. La lógica de transferencia está en `src/core/transfer` (sin Electron). |
| `apps/mobile` | App Flutter (Android). La lógica de transferencia está en `lib/transfer/` (sin Flutter); la interfaz, en `lib/ui/`. |

## Requisitos

- Node.js ≥ 22 y npm.
- Flutter 3.47.9.
- Para compilar el APK de Android:
  - JDK 17, indicado a Flutter con `flutter config --jdk-dir <ruta al JDK 17>`.
  - Android SDK con *cmdline-tools*.
  - Licencias aceptadas: `flutter doctor --android-licenses`.
- Móvil y PC en la misma red Wi-Fi para la prueba real.

## Instalación

Desde la raíz del repositorio:

```sh
npm ci
```

Si el binario de Electron no se descargó durante la instalación (por ejemplo, con scripts de instalación
desactivados), descárgalo a mano:

```sh
node node_modules/electron/install.js
```

Dependencias de la app móvil:

```sh
cd apps/mobile && flutter pub get
```

## Ejecutar el escritorio

```sh
npm run dev -w @fodibo/desktop
```

Pulsa «Recibir del móvil» para abrir una sesión y mostrar el QR. En macOS, acepta el aviso del cortafuegos o
de red local si aparece.

### Servidor de desarrollo sin Electron

Abre una sesión de transferencia desde la terminal: imprime una línea `QR:<json>` y una línea JSON por evento.
Termina con Ctrl+C.

```sh
FODIBO_HOSTS=192.168.1.20 FODIBO_DATA_DIR=/tmp/fodibo-datos npm run dev:server -w @fodibo/desktop
```

- `FODIBO_HOSTS` (opcional): direcciones separadas por comas que se anuncian en el QR, en lugar de las IPv4
  privadas detectadas.
- `FODIBO_DATA_DIR` (opcional): directorio de datos; por defecto `apps/desktop/.dev-data`.

## Pruebas

```sh
npm test                                   # contratos y escritorio (Vitest), desde la raíz
cd apps/mobile
flutter test --exclude-tags interop        # Dart: contratos, cliente de transferencia e interfaz
flutter test --tags interop                # interoperabilidad con el servidor Node real (necesita `npm ci`)
flutter analyze
```

Compilación del escritorio: `npm run build -w @fodibo/desktop` (deja el resultado en `apps/desktop/out/`).

## Instalar la app en Android

Con el móvil conectado por USB y la depuración USB activada:

```sh
cd apps/mobile
flutter build apk --debug
adb install -r build/app/outputs/flutter-apk/app-debug.apk
```

## Dónde quedan los archivos recibidos

La app de escritorio guarda los datos en `app.getPath('userData')` de Electron. El nombre de la app es el del
`package.json` de `apps/desktop` (`@fodibo/desktop`), así que en macOS los paquetes recibidos están en:

```
~/Library/Application Support/@fodibo/desktop/inbox/<package_id>/
  manifest.json
  files/<sha256>      ← cada archivo, nombrado por su hash
  receipt.json        ← solo si el paquete está completo
```

El certificado TLS (cuya huella va en el QR) se guarda en `tls/`, junto a `inbox/`. Con el servidor de desarrollo, la misma
estructura queda bajo `FODIBO_DATA_DIR`.

## Prueba extremo a extremo

La lista de comprobación manual (móvil Android real + Mac en la misma Wi-Fi: envío completo, reenvío sin
duplicados, corte de Wi-Fi a mitad, QR caducado, puerto cerrado tras «Detener» y ausencia de tráfico fuera de
la LAN) está en la Tarea 9 del plan:
[docs/superpowers/plans/2026-11-10-prototipo-transferencia-movil-pc.md](docs/superpowers/plans/2026-11-10-prototipo-transferencia-movil-pc.md#tarea-9-prueba-extremo-a-extremo-manual).
