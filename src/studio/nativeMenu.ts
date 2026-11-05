import { canPerform, perform } from '@liberation-data/desk'
import type { CommandId, Desk } from '@liberation-data/desk'
import type { Menu, MenuItem } from '@liberation-data/desk/react'
import { useEffect, useRef } from 'react'

/*
 * In the desktop app on a Mac, the studio's menus are the Mac's own: the app's menu merges into the one named for the
 * app, and the rest stand beside Edit and View in the menu bar at the top of the screen, rather than in a strip of the
 * window. The page describes its menus; the app (main.cjs, through preload.cjs) draws them and says which was chosen.
 */

/** A menu item as the app draws it: plain data, as it crosses from the page to the app. */
export type NativeItem =
  | { readonly type: 'item'; readonly id: string; readonly label: string; readonly enabled: boolean; readonly checked?: boolean; readonly accelerator?: string; readonly detail?: string }
  | { readonly type: 'separator' }

export interface NativeMenu {
  readonly label: string
  /** The app's own menu, whose items join the one the Mac names for the app. */
  readonly app: boolean
  /**
   * A status menu, at the trailing end of the page's menu bar: on a Mac, a menu bar extra, at the right of the menu
   * bar as the page has it, titled with its label.
   */
  readonly status?: boolean
  readonly items: readonly NativeItem[]
}

/** What the desktop app's preload lends the page: only on a Mac, where the menus are the Mac's. */
export interface StudioNative {
  readonly platform: string
  setMenus(menus: readonly NativeMenu[]): void
  onMenu(handler: (id: string) => void): () => void
  /** The system's folder picker: the path of the folder chosen, or null. */
  pickFolder?(): Promise<string | null>
}

/** The desktop app's folder picker, on any system, when the page is in the desktop app. */
export const folderPicker = (): (() => Promise<string | null>) | undefined => {
  const pick = typeof window === 'undefined' ? undefined : window.studioNative?.pickFolder
  return pick ? () => pick() : undefined
}

declare global {
  interface Window {
    readonly studioNative?: StudioNative
  }
}

/** The app's bridge, when the page is in the desktop app on a Mac, where the menus move to the top of the screen. */
export const nativeMenus = (): StudioNative | undefined => {
  const native = typeof window === 'undefined' ? undefined : window.studioNative
  return native?.platform === 'darwin' ? native : undefined
}

const KEYS: Record<string, string> = { mod: 'CmdOrCtrl', cmd: 'Command', meta: 'Command', ctrl: 'Control', alt: 'Alt', option: 'Alt', shift: 'Shift' }

/** A desk shortcut (`mod+alt+a`) as Electron writes an accelerator (`CmdOrCtrl+Alt+A`). */
export const acceleratorOf = (shortcut: string): string =>
  shortcut
    .split('+')
    .map(part => KEYS[part.toLowerCase()] ?? (part.length === 1 ? part.toUpperCase() : part[0]!.toUpperCase() + part.slice(1)))
    .join('+')

const flag = (value: boolean | (() => boolean) | undefined) => (typeof value === 'function' ? value() : value)

/**
 * The menus as they stand now, and the item each id chooses. Items given as a function (the open windows, say) are
 * read now; the menus are described again whenever the desk changes, so they stay current. `can` says whether anything
 * would perform a command now.
 */
export function describeMenus(
  menus: readonly Menu[],
  can: (command: CommandId) => boolean,
  status: readonly Menu[] = [],
): { menus: NativeMenu[]; chosen: Map<string, MenuItem> } {
  const chosen = new Map<string, MenuItem>()
  const described = [...menus, ...status].map((menu, m) => {
    const items = typeof menu.items === 'function' ? menu.items() : menu.items
    return {
      label: menu.label,
      app: menu.emphasis === true,
      ...(m >= menus.length ? { status: true } : {}),
      items: items.map((item, i): NativeItem => {
        if (item.type === 'separator') return { type: 'separator' }
        // A Mac menu has no headings: one is an item that cannot be chosen.
        if (item.type === 'header') return { type: 'item', id: `${m}.${i}`, label: item.label, enabled: false }
        const id = `${m}.${i}`
        chosen.set(id, item)
        const checked = flag(item.checked)
        return {
          type: 'item',
          id,
          label: item.label,
          enabled: item.type === 'command' ? can(item.command) : !flag(item.disabled),
          ...(checked === undefined ? {} : { checked }),
          ...(item.shortcut ? { accelerator: acceleratorOf(item.shortcut) } : {}),
          // The muted words after the label, as the Mac's own menus show them: under it.
          ...(item.detail ? { detail: item.detail } : {}),
        }
      }),
    }
  })
  return { menus: described, chosen }
}

/** Gives the studio's menus to the desktop app to draw, while there is one; else does nothing. */
export function useNativeMenus(native: StudioNative | undefined, menus: readonly Menu[], desk: Desk, status: readonly Menu[] = []) {
  const chosen = useRef(new Map<string, MenuItem>())

  useEffect(() => {
    if (!native) return
    let frame = 0
    let sent = ''
    const send = () => {
      cancelAnimationFrame(frame)
      // Once a frame at most, and only when they read differently: the desk changes on every step of a window's drag,
      // and the app builds the Mac's menus again each time it is sent them.
      frame = requestAnimationFrame(() => {
        const described = describeMenus(menus, command => canPerform(desk, command), status)
        chosen.current = described.chosen
        const text = JSON.stringify(described.menus)
        if (text === sent) return
        sent = text
        native.setMenus(described.menus)
      })
    }
    send()
    const unsubscribe = desk.subscribe(send)
    return () => {
      cancelAnimationFrame(frame)
      unsubscribe()
    }
  }, [native, menus, status, desk])

  useEffect(
    () =>
      native?.onMenu(id => {
        const item = chosen.current.get(id)
        if (item?.type === 'command') perform(desk, item.command, item.args)
        else if (item?.type === 'action') item.onSelect()
      }),
    [native, desk],
  )
}
