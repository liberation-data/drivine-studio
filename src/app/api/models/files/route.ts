import { failure, foreign } from '../../../../server/http'
import { listModelFiles, readModelFile } from '../../../../server/models'

export const dynamic = 'force-dynamic'

/** The model files the studio reads, as files: `?path=` for one's text, if it is one of them. */
export async function GET(request: Request) {
  const refused = foreign(request)
  if (refused) return refused
  try {
    const path = new URL(request.url).searchParams.get('path')
    return path === null ? Response.json(await listModelFiles()) : Response.json({ text: await readModelFile(path) })
  } catch (e) {
    return failure(e)
  }
}
