import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Lucide's icons, as lucide-static ships them: each icon's SVG, and the words it is tagged with. */
const DIR = () => join(process.cwd(), 'node_modules', 'lucide-static')

let tags: Record<string, string[]> | undefined

/** Every icon's name and its tags, for the picker to search. */
export function catalog(): Record<string, string[]> {
  tags ??= JSON.parse(readFileSync(join(DIR(), 'tags.json'), 'utf8')) as Record<string, string[]>
  return tags
}

/** Whether there is an icon of the name: the only names a path is made of. */
export const isIcon = (name: string): boolean => /^[a-z0-9-]+$/.test(name) && Object.hasOwn(catalog(), name)

/** An icon's SVG, as Lucide draws it, in the colour of the text around it. */
export function svg(name: string): string | undefined {
  return isIcon(name) ? readFileSync(join(DIR(), 'icons', `${name}.svg`), 'utf8') : undefined
}
