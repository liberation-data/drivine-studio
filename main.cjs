// main.cjs: the desktop app. It runs the studio's standalone Next.js server in Electron's own Node and
// opens a window on it, so the browser app talks to the same server here as it does from npm start.
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, utilityProcess } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { answers, waitForServer } = require('./server-start.cjs');

const PORT = process.env.PORT ?? '5187';
const URL = `http://localhost:${PORT}`;
const isDev = process.env.ELECTRON_DEV === '1';

// A log file, since a packaged app has no terminal to write to.
const logPath = path.join(os.tmpdir(), 'drivine-studio-electron.log');
const logStream = fs.createWriteStream(logPath, { flags: 'a' });

// Only while the stream is open: the server's exit is reported after before-quit has ended it, and a
// write after the end is an uncaught error rather than a lost line.
function log(...args) {
  if (logStream.writable) logStream.write(`[${new Date().toISOString()}] ${args.join(' ')}\n`);
  console.log(...args);
}

function logError(...args) {
  if (logStream.writable) logStream.write(`[${new Date().toISOString()}] ERROR: ${args.join(' ')}\n`);
  console.error(...args);
}

log('==================== Electron Starting ====================');
log('App path:', app.getAppPath());
log('ELECTRON_DEV:', process.env.ELECTRON_DEV);
log('Log file:', logPath);

// Before the app is ready, so the menu and dock carry it.
app.setName('Drivine Studio');

// Drivine's cow on the water. Packaged, a Mac takes it from the bundle; run from source, the dock is told.
const ICON = path.join(__dirname, 'build', 'icon.png');

// A second launch would find this one's server on the port and refuse to start; bring this one forward instead.
if (!app.requestSingleInstanceLock()) {
  log('[Electron] Already running; leaving it to that instance');
  app.exit(0);
}
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

let serverProcess = null;
// No window until the server answers: on a Mac, launching the app also activates it.
let serverReady = false;

process.on('uncaughtException', error => logError('Uncaught exception:', error));
process.on('unhandledRejection', error => logError('Unhandled rejection:', error));

async function startServer() {
  // In development the Next.js dev server is already running.
  if (isDev) {
    log('[Electron] Dev mode - using the Next.js dev server at', URL);
    return waitForServer(URL);
  }

  const serverCwd = path.join(app.getAppPath(), '.next', 'standalone');
  const serverPath = path.join(serverCwd, 'server.js');
  log('[Electron] Starting the studio server:', serverPath);
  if (!fs.existsSync(serverPath)) throw new Error(`Server file not found at: ${serverPath}`);
  // Ours could not bind the port, and the window would show whatever does hold it in its place.
  if (await answers(URL)) {
    throw new Error(`Another server already answers at ${URL}. Stop it (npm run dev, say), or set PORT to a free port.`);
  }

  // Electron's utilityProcess runs it in Electron's own Node, so no separate Node is needed.
  // The environment passes on, DRIVINE_STUDIO_MODELS and DRIVINE_STUDIO_HOME included.
  serverProcess = utilityProcess.fork(serverPath, [], {
    cwd: serverCwd,
    env: { ...process.env, PORT, HOSTNAME: 'localhost' },
    stdio: 'pipe',
  });
  serverProcess.stdout.on('data', data => log('[Next.js]', data.toString().trim()));
  serverProcess.stderr.on('data', data => logError('[Next.js Error]', data.toString().trim()));
  let exited = null;
  serverProcess.on('exit', code => {
    exited = `The studio server exited with code ${code} before it answered at ${URL}`;
    log(`[Next.js] Process exited with code ${code}`);
  });

  return waitForServer(URL, { stopped: () => exited });
}

function createWindow() {
  log('[Electron] Creating window');

  const win = new BrowserWindow({
    show: false,
    // The window's own icon, where the system shows one (Windows, Linux); a Mac shows the bundle's.
    icon: ICON,
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.cjs') },
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

/*
 * The studio's own menus, as its page describes them (src/studio/nativeMenu.ts): on a Mac the page has no menu bar of
 * its own, and these are drawn in the Mac's. The app's menu joins the one named for the app; the rest stand after View,
 * and a Window menu of the studio's leads the Mac's own Window menu.
 */
function studioItems(win, items) {
  return items.map(item => item.type === 'separator' ? { type: 'separator' } : {
    label: String(item.label),
    enabled: item.enabled !== false,
    ...(typeof item.checked === 'boolean' ? { type: 'checkbox', checked: item.checked } : {}),
    ...(item.accelerator ? { accelerator: String(item.accelerator) } : {}),
    click: () => { if (!win.isDestroyed()) win.webContents.send('studio:menu', String(item.id)); },
  });
}

function setMenu(win = null, studioMenus = []) {
  const isMac = process.platform === 'darwin';
  const appMenu = studioMenus.find(menu => menu.app);
  const studioWindow = studioMenus.find(menu => !menu.app && menu.label === 'Window');
  const others = studioMenus.filter(menu => menu !== appMenu && menu !== studioWindow);
  const template = [
    ...(isMac ? [{
      label: app.getName(),
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        ...(appMenu ? [...studioItems(win, appMenu.items), { type: 'separator' }] : []),
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
    ...others.map(menu => ({ label: String(menu.label), submenu: studioItems(win, menu.items) })),
    {
      label: 'Window',
      submenu: [
        ...(studioWindow ? [...studioItems(win, studioWindow.items), { type: 'separator' }] : []),
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

// Only from the studio's own page, and only on a Mac, where the page draws no menu bar of its own.
ipcMain.on('studio:menus', (event, menus) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (process.platform !== 'darwin' || !win || !event.senderFrame?.url.startsWith(URL) || !Array.isArray(menus)) return;
  setMenu(win, menus);
});

app.whenReady().then(async () => {
  log('[Electron] App ready');
  try {
    await startServer();
  } catch (error) {
    logError('[Electron] Failed to start server:', error);
    // A packaged app has no terminal, so say why it is going rather than vanish.
    dialog.showErrorBox('Drivine Studio could not start', `${error.message}\n\nThe log is at ${logPath}.`);
    app.quit();
    return;
  }
  serverReady = true;
  if (process.platform === 'darwin' && !app.isPackaged && fs.existsSync(ICON)) app.dock.setIcon(ICON);
  setMenu();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (serverReady && BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  if (serverProcess) {
    log('[Electron] Stopping the studio server');
    serverProcess.kill();
  }
  log('[Electron] App quitting');
  logStream.end();
});
