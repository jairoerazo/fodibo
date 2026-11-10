import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { TransferService } from '../core/transfer/index.js';
import { registerIpc } from './ipc.js';
import { startAdapterSelftest } from './portal/bench-main.js';
import { registerPortalScheme } from './portal/protocol.js';

// El esquema privilegiado del portal debe registrarse antes de `ready`.
registerPortalScheme();

let win: BrowserWindow | undefined;
const selftest = process.argv.includes('--selftest-adapter');
const service = new TransferService({ dataDir: app.getPath('userData'), log: (m) => console.log(`[fodibo] ${m}`) });

function createWindow(): void {
  win = new BrowserWindow({
    width: 960,
    height: 720,
    title: 'FODIBO',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const wc = win.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e) => e.preventDefault());
  win.on('closed', () => {
    win = undefined;
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (!app.isPackaged && devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
}

let quitting = false;
async function shutdown(): Promise<void> {
  if (quitting) return;
  quitting = true;
  try {
    await service.stop();
  } finally {
    app.quit();
  }
}

function startApp(): void {
  registerIpc(service, () => win);

  app.on('before-quit', (e) => {
    if (quitting) return;
    e.preventDefault();
    void shutdown();
  });
  app.on('window-all-closed', () => {
    void shutdown();
  });

  void app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
      if (!win && !quitting) createWindow();
    });
  });
}

if (selftest) startAdapterSelftest();
else startApp();
