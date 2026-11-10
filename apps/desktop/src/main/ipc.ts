import { ipcMain, shell } from 'electron';
import QRCode from 'qrcode';
import { TransferService } from '../core/transfer/index.js';
import { CHANNELS } from '../shared/ipc.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NO_NETWORK = 'No se encontró ninguna red local. Conéctate a una red Wi-Fi.';

export function startErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.startsWith('No hay ninguna dirección IPv4 privada')) return NO_NETWORK;
  return `No se pudo iniciar la recepción: ${msg}`;
}

export function registerIpc(service: TransferService, getWindow: () => Electron.BrowserWindow | undefined): () => void {
  ipcMain.handle(CHANNELS.start, async () => {
    try {
      const { qr, qrText } = await service.start();
      const qrDataUrl = await QRCode.toDataURL(qrText, { errorCorrectionLevel: 'M', margin: 2, width: 320 });
      return { qrDataUrl, expiresAt: qr.exp };
    } catch (err) {
      throw new Error(startErrorMessage(err));
    }
  });
  ipcMain.handle(CHANNELS.stop, () => service.stop());
  ipcMain.handle(CHANNELS.list, () => service.listReceived());
  ipcMain.handle(CHANNELS.open, async (_e, packageId: unknown) => {
    if (typeof packageId !== 'string' || !UUID_RE.test(packageId)) throw new Error('Identificador de paquete no válido');
    const error = await shell.openPath(service.packageDir(packageId));
    if (error) throw new Error(`No se pudo abrir la carpeta: ${error}`);
  });

  const off = service.on((event) => {
    const win = getWindow();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(CHANNELS.event, event);
  });

  return () => {
    off();
    for (const ch of [CHANNELS.start, CHANNELS.stop, CHANNELS.list, CHANNELS.open]) ipcMain.removeHandler(ch);
  };
}
