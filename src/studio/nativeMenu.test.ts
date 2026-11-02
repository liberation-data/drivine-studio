import { DeskCommands } from '@liberation-data/desk'
import { menuAction, menuCommand, menuHeader, menuSeparator } from '@liberation-data/desk/react'
import { describe, expect, it, vi } from 'vitest'
import { acceleratorOf, describeMenus } from './nativeMenu'

describe('acceleratorOf', () => {
  it('writes a desk shortcut as Electron writes an accelerator', () => {
    expect(acceleratorOf('mod+alt+a')).toBe('CmdOrCtrl+Alt+A')
    expect(acceleratorOf('mod+shift+enter')).toBe('CmdOrCtrl+Shift+Enter')
    expect(acceleratorOf('ctrl+k')).toBe('Control+K')
  })
})

describe('describeMenus', () => {
  it('describes each menu as plain data, the app menu marked, and keeps what each id chooses', () => {
    const open = vi.fn()
    const { menus, chosen } = describeMenus(
      [
        { id: 'studio', label: 'Drivine Studio', emphasis: true, items: [menuAction('Cypher', open), menuSeparator(), menuAction('Later', open, { disabled: true })] },
        { id: 'window', label: 'Window', items: () => [menuHeader('Open'), menuAction('Explore', open, { checked: true }), menuCommand('Arrange', DeskCommands.arrange, { shortcut: 'mod+alt+a' })] },
      ],
      command => command === DeskCommands.arrange,
    )
    expect(menus[0]).toEqual({
      label: 'Drivine Studio',
      app: true,
      items: [
        { type: 'item', id: '0.0', label: 'Cypher', enabled: true },
        { type: 'separator' },
        { type: 'item', id: '0.2', label: 'Later', enabled: false },
      ],
    })
    // A heading cannot be chosen; a checked item says so; a shortcut becomes an accelerator.
    expect(menus[1]!.app).toBe(false)
    expect(menus[1]!.items[0]).toEqual({ type: 'item', id: '1.0', label: 'Open', enabled: false })
    expect(menus[1]!.items[1]).toMatchObject({ id: '1.1', checked: true })
    expect(menus[1]!.items[2]).toMatchObject({ id: '1.2', label: 'Arrange', enabled: true, accelerator: 'CmdOrCtrl+Alt+A' })
    // It crosses to the app as JSON, so it must survive it unchanged.
    expect(JSON.parse(JSON.stringify(menus))).toEqual(menus)
    const item = chosen.get('0.0')
    expect(item?.type === 'action' && item.label).toBe('Cypher')
    expect(chosen.has('1.0')).toBe(false)
  })
})
