import { describe, expect, it } from 'vitest'
import { byLabel } from './icons'

describe('byLabel', () => {
  it("has a label's entry alone, and nothing for a label named as an object's own", () => {
    const icons = byLabel([['Person', 'user'], ['__proto__', 'smile']])
    expect(icons.Person).toBe('user')
    expect(icons['__proto__']).toBe('smile')
    expect(icons.constructor).toBeUndefined()
    expect(icons.toString).toBeUndefined()
  })
})
