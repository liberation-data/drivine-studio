// preload.cjs: what the desktop app lends the studio's page. On a Mac, the page's menus become the Mac's own: the page
// describes them, main.cjs draws them, and the id of the item chosen comes back. And on any system, the system's own
// folder picker, so a project can be linked by choosing it: the path chosen comes back, and nothing else crosses.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studioNative', {
  platform: process.platform,
  setMenus: menus => ipcRenderer.send('studio:menus', menus),
  pickFolder: () => ipcRenderer.invoke('studio:pick-folder'),
  onMenu: handler => {
    const listener = (_event, id) => handler(id);
    ipcRenderer.on('studio:menu', listener);
    return () => ipcRenderer.removeListener('studio:menu', listener);
  },
});
