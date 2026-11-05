import { describe, expect, it, vi } from 'vitest'
import { showsSublabels, studioItems, whileClosed } from './native-menus.cjs'

describe('showsSublabels', () => {
  it('is true on a Mac from macOS 14.4, where Electron draws a sublabel', () => {
    expect(['14.4', '14.4.1', '15.0', '26.1'].map(v => showsSublabels('darwin', v))).toEqual([true, true, true, true])
    expect(['13.6', '14.3.1', '14'].map(v => showsSublabels('darwin', v))).toEqual([false, false, false])
    expect(showsSublabels('linux', '15.0')).toBe(false)
  })
})

describe('studioItems', () => {
  const down = { type: 'item', id: '1:A', label: 'A', enabled: false, checked: true, detail: 'Neo4j · not running' }

  it('puts a detail under the label as a sublabel, greyed out and checked as the page says', () => {
    const [item] = studioItems([down], () => {})
    expect(item).toMatchObject({ label: 'A', sublabel: 'Neo4j · not running', enabled: false, type: 'checkbox', checked: true })
  })

  it('puts a detail after the label on a Mac that shows no sublabel, so a greyed-out connection still says why', () => {
    const [item] = studioItems([down], () => {}, { sublabels: false })
    expect(item.label).toBe('A (Neo4j · not running)')
    expect(item).not.toHaveProperty('sublabel')
  })

  it('leaves an item without a detail as it is, and tells choose the id of the item clicked', () => {
    const choose = vi.fn()
    const [item, separator] = studioItems([{ type: 'item', id: '0:New', label: 'New', enabled: true, accelerator: 'CmdOrCtrl+N' }, { type: 'separator' }], choose)
    expect(item).not.toHaveProperty('sublabel')
    expect(item).toMatchObject({ label: 'New', enabled: true, accelerator: 'CmdOrCtrl+N' })
    expect(separator).toEqual({ type: 'separator' })
    item.click()
    expect(choose).toHaveBeenCalledWith('0:New')
  })

  it('keeps an item checked as the page says when clicked, as Electron flips a checkbox before its click and the page may draw nothing new', () => {
    const [item] = studioItems([{ type: 'item', id: '1:A', label: 'A', enabled: true, checked: true }], () => {})
    // As Electron's MenuItem does: the checked flag flipped, then click(menuItem).
    const drawn = { checked: false }
    item.click(drawn)
    expect(drawn.checked).toBe(true)
  })
})

describe('whileClosed', () => {
  const now = fn => fn()

  it('applies a value at once while the menu is closed', () => {
    const apply = vi.fn()
    whileClosed(apply, now).set('a')
    expect(apply).toHaveBeenCalledWith('a')
  })

  it('holds what it is given while the menu is open, and applies only the latest once it closes', () => {
    const apply = vi.fn()
    const menu = whileClosed(apply, now)
    menu.opened()
    menu.set('b')
    menu.set('c')
    expect(apply).not.toHaveBeenCalled()
    menu.closed()
    expect(apply.mock.calls).toEqual([['c']])
    menu.closed()
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('applies nothing on closing when nothing came while it was open, nor when it opened again first', () => {
    const apply = vi.fn()
    const later = []
    const menu = whileClosed(apply, fn => later.push(fn))
    menu.opened()
    menu.closed()
    later.shift()()
    expect(apply).not.toHaveBeenCalled()
    menu.opened()
    menu.set('d')
    menu.closed()
    menu.opened()
    later.shift()()
    expect(apply).not.toHaveBeenCalled()
    menu.closed()
    later.shift()()
    expect(apply.mock.calls).toEqual([['d']])
  })

  it('drops what was held when a later value comes after closing but before the held one is applied', () => {
    const apply = vi.fn()
    const later = []
    const menu = whileClosed(apply, fn => later.push(fn))
    menu.opened()
    menu.set('old')
    menu.closed()
    menu.set('new')
    later.shift()()
    expect(apply.mock.calls).toEqual([['new']])
  })
})
