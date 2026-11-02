// preload.cjs: what the desktop app lends the studio's page. On a Mac, the page's menus become the Mac's own: the page
// describes them, main.cjs draws them, and the id of the item chosen comes back. Nothing else crosses.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studioNative', {
  platform: process.platform,
  setMenus: menus => ipcRenderer.send('studio:menus', menus),
  onMenu: handler => {
    const listener = (_event, id) => handler(id);
    ipcRenderer.on('studio:menu', listener);
    return () => ipcRenderer.removeListener('studio:menu', listener);
  },
});
