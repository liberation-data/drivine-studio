/** The answer's JSON, or an Error saying why there is none: the server answers a refusal as { error }. */
export async function read<T>(response: Response): Promise<T> {
  if (response.ok) return (await response.json()) as T
  // Anything without an error of its own is the server or the network.
  const problem = (await response.json().catch(() => null)) as { error?: string } | null
  throw new Error(problem?.error ?? `The studio answered ${response.status}`)
}

/** A request with a JSON body, if any. */
export const json = (method: string, body?: unknown, signal?: AbortSignal): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  ...(signal ? { signal } : {}),
})
