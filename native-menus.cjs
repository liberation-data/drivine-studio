// native-menus.cjs: how the desktop app turns the menus its page describes (src/studio/nativeMenu.ts) into Electron's
// menu templates, and when it draws them again. Apart from main.cjs, which needs Electron, so a test can drive it.

/** Whether this Mac shows a menu item's sublabel: Electron draws one only from macOS 14.4. */
function showsSublabels(platform, systemVersion) {
  if (platform !== 'darwin') return false;
  const [major = 0, minor = 0] = String(systemVersion).split('.').map(Number);
  return major > 14 || (major === 14 && minor >= 4);
}

/**
 * The page's items as an Electron menu template. An item's detail (a connection's database, and why it can't be chosen
 * when it can't) goes under its label where the Mac shows a sublabel, and after it where it doesn't, so a connection
 * greyed out still says it isn't running. choose(id) is told the id of the item chosen.
 */
function studioItems(items, choose, { sublabels = true } = {}) {
  return items.map(item => {
    if (item.type === 'separator') return { type: 'separator' };
    const detail = item.detail ? String(item.detail) : '';
    return {
      label: detail && !sublabels ? `${String(item.label)} (${detail})` : String(item.label),
      enabled: item.enabled !== false,
      ...(typeof item.checked === 'boolean' ? { type: 'checkbox', checked: item.checked } : {}),
      ...(item.accelerator ? { accelerator: String(item.accelerator) } : {}),
      ...(detail && sublabels ? { sublabel: detail } : {}),
      // Electron flips a checkbox's tick before calling this; put back what the page says, which draws the menu again
      // only if choosing it changed anything (choosing the connection in use doesn't).
      click: menuItem => {
        if (menuItem && typeof item.checked === 'boolean') menuItem.checked = item.checked;
        choose(String(item.id));
      },
    };
  });
}

/**
 * Hands apply() the latest value given, but not while the menu it draws is open: the page tells the app of a
 * connection going up or down every few seconds, and a menu swapped from under the person reading it would change
 * as they read it, or be let go while still shown. What was given while it was open is applied once it has closed,
 * the latest only. Tell it opened() and closed() as the menu shows and closes.
 */
function whileClosed(apply, later = fn => setTimeout(fn, 0)) {
  let open = false;
  let pending = null;
  return {
    set(value) {
      if (open) pending = { value };
      else {
        // Newer than anything still held from while it was open, which mustn't be applied after it.
        pending = null;
        apply(value);
      }
    },
    opened() {
      open = true;
    },
    closed() {
      open = false;
      // After the click the menu closed for has been handled: the item it chose belongs to the menu still drawn.
      later(() => {
        if (open || !pending) return;
        const { value } = pending;
        pending = null;
        apply(value);
      });
    },
  };
}

module.exports = { showsSublabels, studioItems, whileClosed };
