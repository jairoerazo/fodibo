/**
 * Servidor de desarrollo: abre una sesión de TransferService sin Electron.
 * Imprime una línea `QR:<json>` y después una línea JSON por evento. Termina con SIGINT.
 *
 * Entorno: FODIBO_HOSTS (lista separada por comas) sustituye los hosts anunciados en el QR;
 * FODIBO_DATA_DIR sustituye el directorio de datos (por defecto ./.dev-data).
 */
import { TransferService } from '../src/core/transfer/index.js';

const hostsEnv = process.env.FODIBO_HOSTS?.split(',').map((h) => h.trim()).filter(Boolean);
const service = new TransferService({
  dataDir: process.env.FODIBO_DATA_DIR || './.dev-data',
  ...(hostsEnv?.length ? { hosts: () => hostsEnv } : {}),
  log: (message) => process.stderr.write(`${message}\n`),
});

service.on((e) => process.stdout.write(`${JSON.stringify(e)}\n`));

const { qrText } = await service.start();
process.stdout.write(`QR:${qrText}\n`);

process.once('SIGINT', () => {
  void service.stop().then(() => process.exit(0));
});
