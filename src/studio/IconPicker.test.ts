import { describe, expect, it } from 'vitest'
import { matching } from './IconPicker'

const catalog = { user: ['person', 'account'], 'user-round': ['person'], building: ['company', 'office'], users: ['team'] }

describe('matching', () => {
  it('finds icons whose name holds the search before those only tagged with it', () => {
    expect(matching(catalog, 'user')).toEqual(['user', 'user-round', 'users'])
    expect(matching(catalog, 'person')).toEqual(['user', 'user-round'])
  })

  it('needs every word of the search', () => {
    expect(matching(catalog, 'person account')).toEqual(['user'])
    expect(matching(catalog, 'nothing like it')).toEqual([])
  })

  it('shows the first icons when there is no search', () => {
    expect(matching(catalog, '  ')).toEqual(Object.keys(catalog))
  })
})
