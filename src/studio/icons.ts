// Each label's icon, as the server finds it (src/server/icons/labels.ts), and each icon drawn for a node.
import { useEffect, useState } from 'react'
import { json, read } from './fetching'

/** A label's icon, and how the server found it: as LabelIcon in src/server/icons/labels.ts says. */
export interface LabelIcon {
  icon: string | null
  source: 'chosen' | 'common' | 'nearest' | 'none'
  score?: number
}

const API = '/api/icons'

/** The icon of each label given, found by the server. */
export const iconsOf = (labels: string[]): Promise<Record<string, LabelIcon>> =>
  fetch(API, json('POST', { labels })).then(r => read<Record<string, LabelIcon>>(r))

/** Chooses a label's icon: an icon's name, null for none, or undefined to have it found again. */
export const chooseIcon = (label: string, icon: string | null | undefined): Promise<LabelIcon> =>
  fetch(API, json('PUT', icon === undefined ? { label, forget: true } : { label, icon })).then(r => read<LabelIcon>(r))

/** Every icon's name, with the words it is tagged with. */
export const iconCatalog = (): Promise<Record<string, string[]>> =>
  fetch(`${API}/catalog`).then(r => read<Record<string, string[]>>(r))

/** Where an icon's SVG is, in the colour of the text around it. */
export const iconUrl = (name: string): string => `${API}/svg/${encodeURIComponent(name)}`

// Icons found, and drawn, once a page: a label's is found again when it is chosen.
const found = new Map<string, LabelIcon>()
const drawn = new Map<string, Promise<string | undefined>>()
const listeners = new Set<() => void>()
const changed = () => listeners.forEach(it => it())

/** Forgets what was found of a label, as when its icon is chosen, and finds it again where it is shown. */
export function refound(label: string, icon: LabelIcon): void {
  found.set(label, icon)
  changed()
}

/** A record by label with no prototype, so a label such as `constructor` reads as no label's, not an object's. */
export const byLabel = <T>(entries: Iterable<readonly [string, T]>): Record<string, T> => Object.assign(Object.create(null), Object.fromEntries(entries))

/**
 * An icon as a node's image: a data URL of its SVG, drawn in white, as it sits on the label's colour. A canvas can't
 * take the SVG's `currentColor` from the page.
 */
function nodeImage(name: string): Promise<string | undefined> {
  let image = drawn.get(name)
  if (!image) {
    image = fetch(iconUrl(name))
      .then(r => (r.ok ? r.text() : undefined))
      .then(svg => svg && `data:image/svg+xml;utf8,${encodeURIComponent(svg.replaceAll('currentColor', '#ffffff'))}`)
      .catch(() => undefined)
    drawn.set(name, image)
  }
  return image
}

/**
 * The icons of the labels given, as images for nodes, by label: found, then drawn, as each arrives. A label with no
 * icon, or whose icon can't be had, has none: its node is drawn plain.
 */
export function useLabelIcons(labels: readonly string[]): { images: Record<string, string>; icons: Record<string, LabelIcon> } {
  const key = [...new Set(labels)].sort().join('\n')
  const [version, setVersion] = useState(0)
  const [images, setImages] = useState<Record<string, string>>(() => byLabel([]))

  useEffect(() => {
    const listener = () => setVersion(v => v + 1)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])

  useEffect(() => {
    let live = true
    const wanted = key ? key.split('\n') : []
    const missing = wanted.filter(it => !found.has(it))
    const ready = missing.length
      ? iconsOf(missing).then(
          // An icon chosen while these were being found is newer than what was found.
          icons => Object.entries(icons).forEach(([label, icon]) => found.has(label) || found.set(label, icon)),
          () => undefined,
        )
      : Promise.resolve()
    void ready.then(async () => {
      const pairs = await Promise.all(
        wanted.map(async label => {
          const icon = found.get(label)?.icon
          return [label, icon ? await nodeImage(icon) : undefined] as const
        }),
      )
      if (live) setImages(byLabel(pairs.filter((it): it is readonly [string, string] => !!it[1])))
    })
    return () => {
      live = false
    }
  }, [key, version])

  const icons = byLabel((key ? key.split('\n') : []).flatMap(it => (found.has(it) ? [[it, found.get(it)!] as const] : [])))
  return { images, icons }
}
