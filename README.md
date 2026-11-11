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

## Prototipo de agente navegador

Agente local que rellena el portal fiscal de prueba (`apps/desktop/test-portal/`, en alemán) a partir de una
declaración (`declaracion.json`) con un modelo pequeño servido por `llama-server` en `127.0.0.1`. El agente
nunca envía: el usuario revisa, completa los pendientes y pulsa «Einreichen». Diseño:
[docs/superpowers/specs/2026-11-10-prototipo-agente-navegador-design.md](docs/superpowers/specs/2026-11-10-prototipo-agente-navegador-design.md).

### Instalar llama.cpp

```sh
brew install llama.cpp
```

En Mac Intel, Homebrew puede compilar llama.cpp y sus dependencias desde el código fuente (puede tardar horas o
fallar). La vía rápida es el binario oficial precompilado. Versión medida: **b12262**
(`llama-server --version` → `0.9.0-dev (build 12262, commit 15759e0ca)`):

```sh
mkdir -p ~/Models/fodibo/llama.cpp-b12262 && cd ~/Models/fodibo/llama.cpp-b12262
curl -LO https://github.com/ggml-org/llama.cpp/releases/download/b12262/llama-b12262-bin-macos-x64.tar.gz
shasum -a 256 llama-b12262-bin-macos-x64.tar.gz
# 9e9caf083b2fb520ad96631e5f786fce2a344c07d5b81d20fe034aeccf782528
tar xzf llama-b12262-bin-macos-x64.tar.gz
./llama-b12262/llama-server --version
```

(En Apple Silicon, el archivo es `llama-b12262-bin-macos-arm64.tar.gz`.) Ni el modelo ni los binarios se
versionan en el repositorio.

### Modelo

Candidatos medidos (todos Q4_K_M, ≤ 4 B parámetros, temperatura 0). **Ninguno cumple todavía el criterio de
aceptación** (spec §9.1); el elegido provisionalmente es el que más se acerca:

| Modelo | Archivo (Hugging Face, revisión fijada) | Tamaño | SHA-256 |
| --- | --- | --- | --- |
| **Qwen3 4B Instruct 2507** (elegido provisionalmente) | [unsloth/Qwen3-4B-Instruct-2507-GGUF@a06e946](https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/a06e946bb6b655725eafa393f4a9745d460374c9/Qwen3-4B-Instruct-2507-Q4_K_M.gguf) | 2 497 281 120 B (2,3 GiB) | `3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597` |
| Gemma 3 4B IT | [unsloth/gemma-3-4b-it-GGUF@5a3566e](https://huggingface.co/unsloth/gemma-3-4b-it-GGUF/resolve/5a3566e716d80f709ed7b79817eaf7733d2a1fce/gemma-3-4b-it-Q4_K_M.gguf) | 2 489 894 016 B (2,3 GiB) | `04a43a22e8d2003deda5acc262f68ec1005fa76c735a9962a8c77042a74a7d19` |
| Llama 3.2 3B Instruct | [bartowski/Llama-3.2-3B-Instruct-GGUF@5ab33fa](https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/5ab33fa94d1d04e903623ae72c95d1696f09f9e8/Llama-3.2-3B-Instruct-Q4_K_M.gguf) | 2 019 377 696 B (1,9 GiB) | `6c1a2b41161032677be168d354123594c0e6e67d2b9227c84f296ad037c728ff` |

```sh
mkdir -p ~/Models/fodibo && cd ~/Models/fodibo
curl -LO https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/a06e946bb6b655725eafa393f4a9745d460374c9/Qwen3-4B-Instruct-2507-Q4_K_M.gguf
shasum -a 256 Qwen3-4B-Instruct-2507-Q4_K_M.gguf
```

### Variables de entorno

- `FODIBO_MODEL` (obligatoria): ruta al archivo `.gguf`.
- `FODIBO_LLAMA_SERVER` (opcional): ruta a `llama-server`; por defecto se busca `llama-server` en el `PATH`.
- `FODIBO_THREADS` (opcional, solo `--bench`): hilos de `llama-server` (`-t`); por defecto 4.
- `FODIBO_BENCH_TIMEOUT_MIN` (opcional, solo `--bench`): tiempo máximo total; por defecto 90 minutos.

```sh
export FODIBO_MODEL=~/Models/fodibo/Qwen3-4B-Instruct-2507-Q4_K_M.gguf
export FODIBO_LLAMA_SERVER=~/Models/fodibo/llama.cpp-b12262/llama-b12262/llama-server
```

### Usarlo

```sh
npm run dev -w @fodibo/desktop
```

Abre la pestaña «Prueba de portal», pulsa «Abrir portal» y después «Iniciar agente». El panel muestra el paso,
el registro de acciones y, al terminar, la lista de pendientes; «Detener» corta la ejecución y devuelve el
control.

Comprobación del adaptador del portal, sin modelo (rellena los 5 pasos con una asignación fija, comprueba el
bloqueo del envío y de la red e imprime `SELFTEST:{json}`):

```sh
npm run selftest:adapter -w @fodibo/desktop
```

### Banco de pruebas

```sh
npm run bench -w @fodibo/desktop            # 3 ejecuciones
npm run bench -w @fodibo/desktop -- --runs=5
```

Arranca `llama-server` con `FODIBO_MODEL`, ejecuta el agente completo con la ventana oculta recargando el
portal entre ejecuciones, puntúa cada ejecución contra `test-portal/esperado.json`, imprime un resumen con
cada fallo, escribe `apps/desktop/bench-report.json` (no versionado) y sale con 0 solo si se cumple el
criterio de aceptación.

Resultados medidos (Intel Core i7-1068NG7, 4 núcleos, 32 GB; llama.cpp b12262, `-t 4`, `-c 8192`; prompt
final; 3 ejecuciones por modelo, idénticas entre sí a temperatura 0; 14 campos con dato, 2 que deben quedar
pendientes). Configuración final: el esquema de respuesta limita `source` y `candidates` a las claves de la
declaración de tipo compatible con el campo y pone la forma `pending` primero:

| Modelo | Correctos | Equivocados | Inventados | Trampas pendientes | Envíos | Tiempo por paso | RSS pico `llama-server` / Electron | Aceptado |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Qwen3 4B Instruct 2507 | 14/14 | 1 | 0 | 1/2 (rellena «Krankenkassenprämien») | 0 | 43–72 s (≈ 210 s por ejecución) | 5,4–5,7 GB / 0,24–0,26 GB | **No** |
| Gemma 3 4B IT | 12/14 | 4 | 0 | 0/2 | 0 | 23–138 s (≈ 240–390 s) | 5,2–5,4 GB / 0,22–0,66 GB | No |

Con el esquema anterior (`source` libre), Qwen3 dio el mismo resultado (14/14, 1 equivocado, 45–68 s por paso);
Gemma, 10/14 con 1 equivocado y las 2 trampas pendientes, porque escribía la etiqueta en lugar de una clave y la
validación lo dejaba pendiente (21–84 s por paso); Llama 3.2 3B Instruct, 9/14 con 1 equivocado y las 2 trampas
pendientes (34–62 s por paso, 4,4 GB / 0,62 GB).

**Ningún candidato cumple todavía el criterio de aceptación.** Las condiciones absolutas sí se cumplen con
todos: cero valores inventados y cero intentos de envío (el texto malicioso de la ayuda de «Fahrkosten» no tuvo
efecto). Lo que falla es la asignación: Qwen3 asigna `prima_seguro_medico_titular` al campo ambiguo
«Krankenkassenprämien», que debe quedar pendiente. La primera ejecución de cada banco es más lenta (caché fría).

### Comprobar que no hay tráfico fuera del equipo

Durante una ejecución (del banco o desde la app), en otra terminal:

```sh
nettop -m tcp -p "$(pgrep -n llama-server)"           # solo conexiones 127.0.0.1
nettop -m tcp -p "$(pgrep -n -f 'Electron.app')"       # ídem para Electron
lsof -nP -iTCP -a -p "$(pgrep -n llama-server)"       # escucha solo en 127.0.0.1
```

La sesión del portal cancela cualquier petición cuyo esquema no sea `fodibo-portal:` (lo verifica
`selftest:adapter`) y `llama-server` se lanza con `--host 127.0.0.1`.
