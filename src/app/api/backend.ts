// The studio's browser app talks only to this server. For now the server passes each call on to the
// endpoints an application serves with drivine4j-studio; DRIVINE_STUDIO_API names them.
const BACKEND = process.env.DRIVINE_STUDIO_API ?? 'http://localhost:8087/drivine/studio/api'

export async function forward(path: string, init?: RequestInit): Promise<Response> {
  try {
    const answer = await fetch(`${BACKEND}${path}`, { ...init, cache: 'no-store' })
    return new Response(answer.body, {
      status: answer.status,
      headers: { 'content-type': answer.headers.get('content-type') ?? 'application/json' },
    })
  } catch (e) {
    // Answered as the endpoints answer a refusal, so the browser app shows it the same way.
    const reason = e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e)
    return Response.json({ error: `The studio endpoints at ${BACKEND} could not be reached: ${reason}` }, { status: 502 })
  }
}
