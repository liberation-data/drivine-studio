import { body, failure, foreign, refuse } from '../../../../server/http'
import { chooseWord, COMMON, iconsFile, NEAREST, ONLY_BY_NAME, takeOnlyByName, wordOf } from '../../../../server/icons/labels'
import { isIcon } from '../../../../server/icons/lucide'

/**
 * The icons chosen for labels, and the person's own lists beside the built-in ones, which are shown and not changed;
 * and how near the model's icon must be to be taken, to say why a label has none.
 */
async function lists(): Promise<Response> {
  const file = await iconsFile()
  return Response.json({
    chosen: file.labels,
    words: file.words,
    onlyByName: file.onlyByName,
    builtIn: { words: COMMON, onlyByName: [...ONLY_BY_NAME].sort() },
    nearest: NEAREST,
  })
}

/** What Settings shows of icons: the choices, and the lists of common words and icons taken only by name. */
export async function GET(request: Request) {
  const refused = foreign(request)
  if (refused) return refused
  try {
    return await lists()
  } catch (e) {
    return failure(e)
  }
}

/**
 * Changes the person's own lists: `{ word, icon }` gives a common word its icon, `{ word, forget: true }` takes it off,
 * and `{ onlyByName, listed }` puts an icon on the list of those taken only by name, or takes it off.
 */
export async function PUT(request: Request) {
  const refused = foreign(request)
  if (refused) return refused
  const given = await body(request)
  // A body that is JSON but not an object, such as `"probe"`, asks for neither change: `in` would throw on it.
  const asked = (typeof given === 'object' && given !== null ? given : undefined) as
    | { word?: unknown; icon?: unknown; forget?: unknown; onlyByName?: unknown; listed?: unknown }
    | undefined
  const icon = (it: unknown): it is string => typeof it === 'string' && isIcon(it)
  try {
    if (asked && 'word' in asked) {
      const word = typeof asked.word === 'string' ? wordOf(asked.word) : ''
      if (!word) return refuse(400, 'Name a word.')
      if (asked.forget === true) await chooseWord(word, undefined)
      else if (icon(asked.icon)) await chooseWord(word, asked.icon)
      else return refuse(400, "Name one of Lucide's icons for the word.")
      return await lists()
    }
    if (asked && 'onlyByName' in asked) {
      if (!icon(asked.onlyByName)) return refuse(400, "Name one of Lucide's icons.")
      if (typeof asked.listed !== 'boolean') return refuse(400, 'Say whether the icon is listed.')
      await takeOnlyByName(asked.onlyByName, asked.listed)
      return await lists()
    }
    return refuse(400, 'Give a word and its icon, or an icon to take only by name.')
  } catch (e) {
    return failure(e)
  }
}
