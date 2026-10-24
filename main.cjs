// main.cjs: the desktop app. It runs the studio's standalone Next.js server in Electron's own Node and
// opens a window on it, so the browser app talks to the same server here as it does from npm start.
const { app, BrowserWindow, Menu, shell, utilityProcess } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = process.env.PORT ?? '5187';
const URL = `http://localhost:${PORT}`;
const isDev = process.env.ELECTRON_DEV === '1';

// A log file, since a packaged app has no terminal to write to.
const logPath = path.join(os.tmpdir(), 'drivine-studio-electron.log');
const logStream = fs.createWriteStream(logPath, { flags: 'a' });

function log(...args) {
  logStream.write(`[${new Date().toISOString()}] ${args.join(' ')}\n`);
  console.log(...args);
}

function logError(...args) {
  logStream.write(`[${new Date().toISOString()}] ERROR: ${args.join(' ')}\n`);
  console.error(...args);
}

log('==================== Electron Starting ====================');
log('App path:', app.getAppPath());
log('ELECTRON_DEV:', process.env.ELECTRON_DEV);
log('Log file:', logPath);

// Before the app is ready, so the menu and dock carry it.
app.setName('Drivine Studio');

let serverProcess = null;

process.on('uncaughtException', error => logError('Uncaught exception:', error));
process.on('unhandledRejection', error => logError('Unhandled rejection:', error));

/** Resolves once the server answers, rather than after a guess at how long it takes to start. */
async function waitForServer(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(URL, { method: 'HEAD' });
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw new Error(`The studio server did not answer at ${URL} within ${timeoutMs / 1000}s`);
}

async function startServer() {
  // In development the Next.js dev server is already running.
  if (isDev) {
    log('[Electron] Dev mode - using the Next.js dev server at', URL);
    return waitForServer();
  }

  const serverCwd = path.join(app.getAppPath(), '.next', 'standalone');
  const serverPath = path.join(serverCwd, 'server.js');
  log('[Electron] Starting the studio server:', serverPath);
  if (!fs.existsSync(serverPath)) throw new Error(`Server file not found at: ${serverPath}`);

  // Electron's utilityProcess runs it in Electron's own Node, so no separate Node is needed.
  // The environment passes on, DRIVINE_STUDIO_API included.
  serverProcess = utilityProcess.fork(serverPath, [], {
    cwd: serverCwd,
    env: { ...process.env, PORT, HOSTNAME: 'localhost' },
    stdio: 'pipe',
  });
  serverProcess.stdout.on('data', data => log('[Next.js]', data.toString().trim()));
  serverProcess.stderr.on('data', data => logError('[Next.js Error]', data.toString().trim()));
  serverProcess.on('exit', code => log(`[Next.js] Process exited with code ${code}`));

  return waitForServer();
}

function createWindow() {
  log('[Electron] Creating window');

  const win = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });

  // Only the studio's own server; in dev, eval too, for Next.js hot reload.
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const scriptSrc = isDev ? "'self' 'unsafe-inline' 'unsafe-eval'" : "'self' 'unsafe-inline'";
    const csp = [
      `default-src 'self'`,
      `script-src ${scriptSrc}`,
      `style-src 'self' 'unsafe-inline'`,
      `img-src 'self' data:`,
      `connect-src 'self' ws://localhost:${PORT}`,
      `font-src 'self' data:`,
    ].join('; ');
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
  });

  // A link out of the studio opens in the browser, not in the studio's window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.maximize();
  win.show();
  log('[Electron] Loading URL:', URL);
  win.loadURL(URL);

  win.webContents.on('did-fail-load', (e, code, desc, url) => {
    logError('[Electron] did-fail-load:', JSON.stringify({ code, desc, url }));
  });
  if (process.env.ELECTRON_DEVTOOLS === '1') {
    win.webContents.openDevTools({ mode: 'detach' });
  }
}

function setMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.getName(),
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Open Log File', click: () => shell.showItemInFolder(logPath) },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac
          ? [{ role: 'pasteAndMatchStyle' }, { role: 'delete' }, { role: 'selectAll' }]
          : [{ role: 'delete' }, { type: 'separator' }, { role: 'selectAll' }]),
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? [{ type: 'separator' }, { role: 'front' }, { type: 'separator' }, { role: 'window' }]
          : [{ role: 'close' }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  log('[Electron] App ready');
  try {
    await startServer();
  } catch (error) {
    logError('[Electron] Failed to start server:', error);
    app.quit();
    return;
  }
  setMenu();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  if (serverProcess) {
    log('[Electron] Stopping the studio server');
    serverProcess.kill();
  }
  log('[Electron] App quitting');
  logStream.end();
});
