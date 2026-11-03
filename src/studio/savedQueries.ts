// The statements kept to run again, as the studio's server keeps them: src/app/api/queries.
import type { QueryFolder, QueryInput, QueryShelf, SavedQuery } from '../server/queries'
import { json, read } from './fetching'

export type { QueryFolder, QueryInput, QueryShelf, SavedQuery }

const API = '/api/queries'

/** A query's id as a path in the URL: each folder and the file, encoded, between slashes. */
const pathOf = (id: string) => id.split('/').map(encodeURIComponent).join('/')

export const addFolder = (path: string): Promise<QueryFolder> => fetch(`${API}/folders`, json('POST', { path })).then(r => read<QueryFolder>(r))

export const removeFolder = (path: string): Promise<void> => fetch(`${API}/folders`, json('DELETE', { path })).then(r => read<void>(r))

export const listQueries = (): Promise<QueryShelf> => fetch(API, { cache: 'no-store' }).then(r => read<QueryShelf>(r))

export const addQuery = (input: QueryInput): Promise<SavedQuery> => fetch(API, json('POST', input)).then(r => read<SavedQuery>(r))

export const updateQuery = (id: string, input: QueryInput): Promise<SavedQuery> =>
  fetch(`${API}/${pathOf(id)}`, json('PUT', input)).then(r => read<SavedQuery>(r))

export const removeQuery = (id: string): Promise<void> =>
  fetch(`${API}/${pathOf(id)}`, json('DELETE')).then(r => read<void>(r))

/** A statement's first line that says anything, for a list or a name to start from. */
export const firstLine = (statement: string): string => statement.split('\n').find(line => line.trim() !== '')?.trim() ?? ''
