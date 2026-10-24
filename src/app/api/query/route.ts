import { forward } from '../backend'

export const POST = async (request: Request) =>
  forward('/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: await request.text(),
  })
