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
        { type: 'item', id: '0:Cypher', label: 'Cypher', enabled: true },
        { type: 'separator' },
        { type: 'item', id: '0:Later', label: 'Later', enabled: false },
      ],
    })
    // A heading cannot be chosen; a checked item says so; a shortcut becomes an accelerator.
    expect(menus[1]!.app).toBe(false)
    expect(menus[1]!.items[0]).toEqual({ type: 'item', id: '1.h0', label: 'Open', enabled: false })
    expect(menus[1]!.items[1]).toMatchObject({ id: '1:Explore', checked: true })
    expect(menus[1]!.items[2]).toMatchObject({ id: '1:Arrange', label: 'Arrange', enabled: true, accelerator: 'CmdOrCtrl+Alt+A' })
    // It crosses to the app as JSON, so it must survive it unchanged.
    expect(JSON.parse(JSON.stringify(menus))).toEqual(menus)
    const item = chosen.get('0:Cypher')
    expect(item?.type === 'action' && item.label).toBe('Cypher')
    expect(chosen.has('1.h0')).toBe(false)
  })

  it('marks the status menus, which a Mac shows as a menu bar extra', () => {
    const { menus } = describeMenus(
      [{ id: 'file', label: 'File', items: [menuAction('New Query', () => {})] }],
      () => true,
      [{ id: 'connection', label: 'Matrix (Postgres)', items: [menuHeader('Connection'), menuAction('Matrix (Postgres)', () => {}, { checked: true })] }],
    )
    expect(menus.map(m => [m.label, m.status ?? false])).toEqual([['File', false], ['Matrix (Postgres)', true]])
    expect(menus[1]!.items[1]).toMatchObject({ id: '1:Matrix (Postgres)', checked: true })
  })

  it('carries an item’s detail and whether it can be chosen, as a connection that is not running has them', () => {
    const { menus } = describeMenus([], () => true, [
      { id: 'connection', label: 'A', items: [menuAction('A', () => {}, { checked: true, disabled: true, detail: 'Neo4j · not running' })] },
    ])
    expect(menus[0]!.items[0]).toEqual({ type: 'item', id: '0:A', label: 'A', enabled: false, checked: true, detail: 'Neo4j · not running' })
  })
})

describe('describeMenus ids', () => {
  const connections = (order: readonly string[]) => [
    { id: 'connection', label: 'A', items: [menuHeader('Connection'), ...order.map(name => menuAction(name, () => {}))] },
  ]
  const idOf = (menus: ReturnType<typeof describeMenus>['menus'], label: string) =>
    menus[0]!.items.find(item => item.type === 'item' && item.label === label && item.enabled) as { id: string } | undefined

  it('keeps an item’s id when the items above it move, so a click on a menu drawn before chooses what it showed', () => {
    const before = describeMenus([], () => true, connections(['A', 'B']))
    const after = describeMenus([], () => true, connections(['B', 'A']))
    const clicked = idOf(before.menus, 'A')!.id
    const item = after.chosen.get(clicked)
    expect(item?.type === 'action' && item.label).toBe('A')
  })

  it('tells apart two items of the same label, and a heading from an item that shares its label', () => {
    const { menus, chosen } = describeMenus([], () => true, connections(['Connection', 'X', 'X']))
    const ids = menus[0]!.items.map(item => (item.type === 'item' ? item.id : ''))
    expect(new Set(ids).size).toBe(ids.length)
    expect(chosen.size).toBe(3)
  })
})
