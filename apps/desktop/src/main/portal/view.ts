// Vista aislada del portal: WebContentsView en la sesión del portal, sin preload y con sandbox.
// Solo permite navegar dentro de `fodibo-portal://portal/`. Mientras el agente está activo rige una
// lista blanca: solo se permite navegar a `index.html` (normalizado con la misma función que usa el
// servidor del protocolo); cualquier otra navegación se cancela y cuenta como envío bloqueado.
// WebRTC no puede usar UDP fuera del proxy (que no existe): sin fugas de IP local.
import { WebContentsView, type BrowserWindow, type Rectangle, type Session, type WebContents } from 'electron';
import { PORTAL_HOST, PORTAL_SCHEME, PORTAL_START_URL, portalFileOf, portalSessionReady } from './protocol.js';

function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

function isPortalUrl(u: URL | undefined): u is URL {
  return u !== undefined && u.protocol === `${PORTAL_SCHEME}:` && u.host === PORTAL_HOST;
}

export class PortalView {
  private readonly view: WebContentsView;
  private agentActive = false;
  private blocked = 0;
  private readonly listeners = new Set<() => void>();
  private destroyed = false;

  constructor(
    private readonly win: BrowserWindow,
    private readonly session: Session,
  ) {
    this.view = new WebContentsView({
      webPreferences: {
        session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        webviewTag: false,
        navigateOnDragDrop: false,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    const wc = this.view.webContents;
    wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-frame-navigate', (e) => this.guard(e, e.url));
    wc.on('will-redirect', (e) => this.guard(e, e.url));
    wc.on('will-attach-webview', (e) => e.preventDefault());
    win.contentView.addChildView(this.view);
  }

  get webContents(): WebContents {
    return this.view.webContents;
  }

  get blockedSubmits(): number {
    return this.blocked;
  }

  private guard(e: { preventDefault(): void }, url: string): void {
    const u = parse(url);
    if (!isPortalUrl(u)) {
      e.preventDefault();
      return;
    }
    if (this.agentActive && portalFileOf(url) !== 'index.html') {
      e.preventDefault();
      this.blocked++;
      for (const cb of [...this.listeners]) {
        try {
          cb();
        } catch {
          // Un oyente defectuoso no debe impedir el bloqueo.
        }
      }
    }
  }

  async load(): Promise<void> {
    await portalSessionReady(this.session);
    await this.view.webContents.loadURL(PORTAL_START_URL);
  }

  setBounds(r: Rectangle): void {
    this.view.setBounds(r);
  }

  /** Oculta sin encoger: la página conserva su tamaño y el agente puede seguir trabajando. */
  setVisible(visible: boolean): void {
    this.view.setVisible(visible);
  }

  get visible(): boolean {
    return this.view.getVisible();
  }

  setAgentActive(active: boolean): void {
    this.agentActive = active;
  }

  onSubmitBlocked(cb: () => void): void {
    this.listeners.add(cb);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.listeners.clear();
    if (!this.win.isDestroyed()) this.win.contentView.removeChildView(this.view);
    const wc = this.view.webContents;
    if (!wc.isDestroyed()) {
      if (wc.debugger.isAttached()) {
        try {
          wc.debugger.detach();
        } catch {
          // Ya desconectado.
        }
      }
      wc.close();
    }
  }
}
