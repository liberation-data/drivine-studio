// The statements kept to run again, as the studio's server keeps them: src/app/api/queries.
import type { SavedQuery, QueryInput } from '../server/queries'
import { json, read } from './fetching'

export type { SavedQuery, QueryInput }

const API = '/api/queries'

export const listQueries = (): Promise<SavedQuery[]> => fetch(API, { cache: 'no-store' }).then(r => read<SavedQuery[]>(r))

export const addQuery = (input: QueryInput): Promise<SavedQuery> => fetch(API, json('POST', input)).then(r => read<SavedQuery>(r))

export const updateQuery = (id: string, input: QueryInput): Promise<SavedQuery> =>
  fetch(`${API}/${encodeURIComponent(id)}`, json('PUT', input)).then(r => read<SavedQuery>(r))

export const removeQuery = (id: string): Promise<void> =>
  fetch(`${API}/${encodeURIComponent(id)}`, json('DELETE')).then(r => read<void>(r))

/** A statement's first line that says anything, for a list or a name to start from. */
export const firstLine = (statement: string): string => statement.split('\n').find(line => line.trim() !== '')?.trim() ?? ''
