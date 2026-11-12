import { app, BrowserWindow, ipcMain, session, shell } from 'electron';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ExpedienteError, ExpedienteService } from '../core/expediente/index.js';
import { TransferService } from '../core/transfer/index.js';
import { registerDocProtocol } from './doc-protocol.js';
import { registerExpedienteIpc, type ExpedienteFacade } from './expediente-ipc.js';
import { registerIpc } from './ipc.js';
import { startAdapterSelftest, startBench } from './portal/bench-main.js';
import { AGENT_CHANNELS } from '../shared/agent-ipc.js';
import { CASE_CHANNELS } from '../shared/expediente-ipc.js';
import { AgentController, APPROVAL_MESSAGES, createLlamaFromEnv, errMsg, registerAgentIpc, type LlamaLike } from './portal/agent-ipc.js';
import { CdpAdapter } from './portal/cdp-adapter.js';
import { createPortalSession, portalRoot, registerPortalScheme } from './portal/protocol.js';
import { PortalView } from './portal/view.js';

// El esquema privilegiado del portal debe registrarse antes de `ready`.
registerPortalScheme();

let win: BrowserWindow | undefined;
const selftest = process.argv.includes('--selftest-adapter');
const bench = process.argv.includes('--bench');
const dataDir = process.env['FODIBO_DATA_DIR'] || app.getPath('userData');
const service = new TransferService({ dataDir, log: (m) => console.log(`[fodibo] ${m}`) });

/** `undefined` si el expediente no pudo abrirse (el IPC `case:*` responde `storage_error`). */
let expediente: ExpedienteService | undefined;
let llama: LlamaLike | undefined;
const agent = new AgentController({
  createView: () => {
    if (!win || win.isDestroyed()) return undefined;
    const view = new PortalView(win, createPortalSession(portalRoot()));
    return { view, adapter: new CdpAdapter(view.webContents) };
  },
  getLlama: () => (llama ??= createLlamaFromEnv()),
  loadDeclaration: (caseId) => {
    if (!expediente) throw new Error(APPROVAL_MESSAGES.no_approval);
    // Un ExpedienteError viaja tal cual: el controlador lo traduce a APPROVAL_MESSAGES.
    try {
      const { declaration, approvalId: _id, ...approval } = expediente.approvedDeclaration(caseId);
      return { declaration, approval: { caseId, ...approval } };
    } catch (err) {
      if (err instanceof ExpedienteError) throw err;
      throw new Error('No se pudo leer la versión aprobada del expediente.');
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

/** Ruta de la copia más reciente de `backups/`, si existe (por fecha de modificación). */
function latestBackup(): string | undefined {
  try {
    const dir = join(dataDir, 'expediente', 'backups');
    const last = readdirSync(dir)
      .filter((f) => f.endsWith('.db'))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => a.t - b.t || a.f.localeCompare(b.f))
      .at(-1);
    return last ? join(dir, last.f) : undefined;
  } catch {
    return undefined;
  }
}

/** Fachada para cuando el almacén no abrió: todo responde `storage_error` con la copia disponible. */
function brokenExpediente(backup: string | undefined): ExpedienteFacade {
  const fail = (): never => {
    throw new ExpedienteError('storage_error', 'No se pudo abrir el expediente.', backup ? { backup } : {});
  };
  return {
    listCases: fail,
    createCase: fail,
    updateCase: fail,
    getCase: fail,
    listConcepts: fail,
    listImportable: fail,
    importPackage: fail,
    setDocument: fail,
    saveField: fail,
    deleteField: fail,
    fieldHistory: fail,
    approve: fail,
    documentLocation: fail,
    on: () => () => {},
  };
}

async function openExpediente(): Promise<void> {
  let opened: ExpedienteService | undefined;
  try {
    opened = await ExpedienteService.open({ dataDir, inboxDir: join(dataDir, 'inbox') });
  } catch (err) {
    // Solo el código: ni mensajes ni rutas llegan a la consola.
    console.error(`[fodibo] expediente: ${err instanceof ExpedienteError ? err.code : 'open_failed'}`);
  }
  if (!opened) {
    registerExpedienteIpc(ipcMain, brokenExpediente(latestBackup()), { showItemInFolder: () => {} });
    return;
  }
  expediente = opened;
  opened.on((e) => {
    // Primero se detiene el relleno del agente; un fallo al avisar a la ventana no debe impedirlo.
    agent.onCaseChanged(e.caseId);
    try {
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(CASE_CHANNELS.event, e);
    } catch (err) {
      console.error(`[fodibo] expediente: aviso a la ventana fallido (${err instanceof Error ? err.name : 'error'})`);
    }
  });
  registerDocProtocol(session.defaultSession, opened);
  registerExpedienteIpc(ipcMain, opened, { showItemInFolder: (p) => shell.showItemInFolder(p) });
}

let quitting = false;
async function shutdown(): Promise<void> {
  if (quitting) return;
  quitting = true;
  try {
    await agent.dispose().catch((err: unknown) => console.error(`[fodibo] ${errMsg(err)}`));
    await service.stop();
  } finally {
    try {
      expediente?.close();
    } catch {
      // ya cerrado
    }
    app.quit();
  }
}

function startApp(): void {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
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

  void app.whenReady().then(async () => {
    try {
      await openExpediente();
    } catch {
      console.error('[fodibo] expediente: registro_fallido');
    }
    createWindow();
    app.on('activate', () => {
      if (!win && !quitting) createWindow();
    });
  });
}

if (selftest) startAdapterSelftest();
else if (bench) startBench();
else startApp();
