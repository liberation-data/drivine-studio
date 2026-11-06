// preload.cjs: what the desktop app lends the studio's page. On a Mac, the page's menus become the Mac's own: the page
// describes them, main.cjs draws them, and the id of the item chosen comes back. And on any system, the system's own
// folder picker, so a project can be linked by choosing it: the path chosen comes back, and nothing else crosses. And
// the appearance chosen, so the app's own menus and dialogs are light or dark as the page is.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studioNative', {
  platform: process.platform,
  setMenus: menus => ipcRenderer.send('studio:menus', menus),
  pickFolder: () => ipcRenderer.invoke('studio:pick-folder'),
  pickFile: () => ipcRenderer.invoke('studio:pick-file'),
  // The appearance chosen in Settings, for the app's own menus and dialogs: 'system', 'light' or 'dark'.
  setTheme: theme => ipcRenderer.send('studio:theme', theme),
  onMenu: handler => {
    const listener = (_event, id) => handler(id);
    ipcRenderer.on('studio:menu', listener);
    return () => ipcRenderer.removeListener('studio:menu', listener);
  },
});
