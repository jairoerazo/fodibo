import { app, BrowserWindow, ipcMain } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadDeclaration } from '../core/agent/index.js';
import { TransferService } from '../core/transfer/index.js';
import { registerIpc } from './ipc.js';
import { startAdapterSelftest } from './portal/bench-main.js';
import { AGENT_CHANNELS } from '../shared/agent-ipc.js';
import { AgentController, createLlamaFromEnv, errMsg, registerAgentIpc, type LlamaLike } from './portal/agent-ipc.js';
import { CdpAdapter } from './portal/cdp-adapter.js';
import { createPortalSession, portalRoot, registerPortalScheme } from './portal/protocol.js';
import { PortalView } from './portal/view.js';

// El esquema privilegiado del portal debe registrarse antes de `ready`.
registerPortalScheme();

let win: BrowserWindow | undefined;
const selftest = process.argv.includes('--selftest-adapter');
const service = new TransferService({ dataDir: app.getPath('userData'), log: (m) => console.log(`[fodibo] ${m}`) });

let llama: LlamaLike | undefined;
const agent = new AgentController({
  createView: () => {
    if (!win || win.isDestroyed()) return undefined;
    const view = new PortalView(win, createPortalSession(portalRoot()));
    return { view, adapter: new CdpAdapter(view.webContents) };
  },
  getLlama: () => (llama ??= createLlamaFromEnv()),
  loadDeclaration: () => {
    try {
      return loadDeclaration(JSON.parse(readFileSync(join(portalRoot(), 'declaracion.json'), 'utf8')));
    } catch (err) {
      throw new Error(`No se pudo leer la declaración: ${errMsg(err)}`);
    }
  },
  emit: (e) => {
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(AGENT_CHANNELS.event, e);
  },
});

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
  win.on('close', () => {
    void agent.closePortal().catch(() => {});
  });
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
    await agent.dispose().catch((err: unknown) => console.error(`[fodibo] ${errMsg(err)}`));
    await service.stop();
  } finally {
    app.quit();
  }
}

function startApp(): void {
  registerIpc(service, () => win);
  registerAgentIpc(ipcMain, agent);

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
