import { app, BrowserWindow, shell, session } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// fix __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_URL = 'https://yapzac.codedbyzach.com/';

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b0d10',
    title: 'YapZac',
    // icon is applied to the EXE by electron-builder; no need here at runtime
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      devTools: true
    }
  });

  // Load the hosted app
  win.loadURL(APP_URL, {
    userAgent: `${app.name}/${app.getVersion()} (${os.platform()} ${os.release()})`
  });

  // Open external links in default browser, not new Electron windows
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    const target = new URL(url);
    const allowedHost = target.hostname.endsWith('codedbyzach.com');
    if (!allowedHost) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  return win;
}

// Single-instance guard
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
  });
}

app.whenReady().then(() => {
  // Only allow sensitive permissions for your domain
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const url = details?.requestingUrl || '';
    let host = '';
    try { host = new URL(url).hostname; } catch {}
    const allowedPerms = new Set(['media', 'notifications', 'clipboard-read']);
    const ok =
      host.endsWith('codedbyzach.com') &&
      allowedPerms.has(permission);

    callback(ok);
  });

  // Extra hardening: block insecure HTTP mixed-content
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders || {};
    // Enforce a baseline CSP if your site doesn't send one
    if (!Object.keys(headers).some(k => k.toLowerCase() === 'content-security-policy')) {
      headers['Content-Security-Policy'] = [
        "default-src 'self' https: wss: data: blob:; object-src 'none'; frame-ancestors 'none';"
      ];
    }
    callback({ responseHeaders: headers });
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
