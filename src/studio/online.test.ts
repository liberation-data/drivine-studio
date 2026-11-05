import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onlineStore } from './online'

/** A probe whose tries are settled by hand: each id's tries, in order, and how many are out at once. */
function probes() {
  const out: { id: string; settle: (ok: boolean) => void }[] = []
  const probe = vi.fn((id: string) => new Promise<void>((resolve, reject) => {
    out.push({ id, settle: ok => (ok ? resolve() : reject(new Error('down'))) })
  }))
  const settle = async (id: string, ok: boolean) => {
    const at = out.findIndex(t => t.id === id)
    out.splice(at, 1)[0]!.settle(ok)
    await vi.advanceTimersByTimeAsync(0)
  }
  return { probe, out, settle, tries: (id: string) => probe.mock.calls.filter(([of]) => of === id).length }
}

describe('onlineStore', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('tries each id at once, and again a while after each try settles', async () => {
    const { probe, settle, tries } = probes()
    const store = onlineStore(probe, 5000)
    store.watch(['a', 'b'])
    expect(tries('a')).toBe(1)
    expect(tries('b')).toBe(1)
    expect(store.snapshot()).toEqual({})
    await settle('a', true)
    await settle('b', false)
    expect(store.snapshot()).toEqual({ a: true, b: false })
    await vi.advanceTimersByTimeAsync(5000)
    expect(tries('a')).toBe(2)
    await settle('a', false)
    expect(store.snapshot()).toEqual({ a: false, b: false })
  })

  it('never has two tries of one id out at once, when a down host takes longer than the wait to time out', async () => {
    const { probe, out, settle, tries } = probes()
    const store = onlineStore(probe, 5000)
    store.watch(['down'])
    await vi.advanceTimersByTimeAsync(30_000)
    expect(tries('down')).toBe(1)
    expect(out).toHaveLength(1)
    await settle('down', false)
    await vi.advanceTimersByTimeAsync(4999)
    expect(tries('down')).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(tries('down')).toBe(2)
  })

  it('tries an id once however many watch it, and keeps on until the last lets go', async () => {
    const { probe, settle, tries } = probes()
    const store = onlineStore(probe, 5000)
    const menu = store.watch(['a'])
    const picker = store.watch(['a', 'a'])
    expect(tries('a')).toBe(1)
    await settle('a', true)
    menu()
    await vi.advanceTimersByTimeAsync(5000)
    expect(tries('a')).toBe(2)
    await settle('a', true)
    picker()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(tries('a')).toBe(2)
    expect(store.snapshot()).toEqual({})
  })

  it('ignores a try that settles after its id is let go of, as for a connection removed meanwhile', async () => {
    const { probe, settle, tries } = probes()
    const store = onlineStore(probe, 5000)
    const listener = vi.fn()
    store.subscribe(listener)
    const stop = store.watch(['gone'])
    stop()
    await settle('gone', true)
    expect(store.snapshot()).toEqual({})
    expect(listener).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(tries('gone')).toBe(1)
  })

  it('lets a try still out answer for an id watched again, rather than start a second beside it', async () => {
    const { probe, settle, tries } = probes()
    const store = onlineStore(probe, 5000)
    store.watch(['a'])()
    store.watch(['a'])
    expect(tries('a')).toBe(1)
    await settle('a', true)
    expect(store.snapshot()).toEqual({ a: true })
    await vi.advanceTimersByTimeAsync(5000)
    expect(tries('a')).toBe(2)
  })

  it('keeps what it knows of an id let go of and watched again at once, as when a list of ids gains one', async () => {
    const { probe, settle, tries } = probes()
    const store = onlineStore(probe, 5000)
    const before = store.watch(['a'])
    await settle('a', true)
    before()
    const after = store.watch(['a', 'b'])
    await vi.advanceTimersByTimeAsync(0)
    expect(store.snapshot()).toEqual({ a: true })
    expect(tries('a')).toBe(2)
    after()
    await vi.advanceTimersByTimeAsync(0)
    expect(store.snapshot()).toEqual({})
  })

  it('lets go once however often told to, and counts a probe that throws as down', async () => {
    const { probe, settle, tries } = probes()
    const store = onlineStore(probe, 5000)
    const stop = store.watch(['a'])
    store.watch(['a'])
    stop()
    stop()
    await settle('a', true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(tries('a')).toBe(2)
    const throwing = onlineStore(() => { throw new Error('bad id') }, 5000)
    throwing.watch(['x'])
    await vi.advanceTimersByTimeAsync(0)
    expect(throwing.snapshot()).toEqual({ x: false })
  })

  it('tells its listeners only of a change, and keeps the same snapshot otherwise', async () => {
    const { probe, settle } = probes()
    const store = onlineStore(probe, 5000)
    const listener = vi.fn()
    store.subscribe(listener)
    store.watch(['a'])
    await settle('a', true)
    const first = store.snapshot()
    expect(listener).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5000)
    await settle('a', true)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.snapshot()).toBe(first)
  })
})
