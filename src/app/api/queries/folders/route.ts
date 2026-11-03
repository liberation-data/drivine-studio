import { body, failure, foreign } from '../../../../server/http'
import { addFolder, removeFolder } from '../../../../server/queries'

export const dynamic = 'force-dynamic'

/** Makes a folder of queries: `{ path: 'Films/Keanu' }`. */
export async function POST(request: Request) {
  const refused = foreign(request)
  if (refused) return refused
  try {
    return Response.json(await addFolder(((await body(request)) as { path?: unknown } | undefined)?.path), { status: 201 })
  } catch (e) {
    return failure(e)
  }
}

/** Removes an empty folder of queries: `{ path }`. */
export async function DELETE(request: Request) {
  const refused = foreign(request)
  if (refused) return refused
  try {
    await removeFolder(((await body(request)) as { path?: unknown } | undefined)?.path)
    return Response.json(null)
  } catch (e) {
    return failure(e)
  }
}
