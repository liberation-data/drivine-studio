import { Button, Loading, Sheet, TextField } from '@liberation-data/desk/react'
import { useEffect, useMemo, useState } from 'react'
import { chooseIcon, iconCatalog, iconUrl, refound } from './icons'
import type { LabelIcon } from './icons'

/** How many icons the picker shows at once: enough to choose from, few enough to draw at once. */
const SHOWN = 96

/**
 * A label's colour, with its icon on it where it has one. The icon is a mask over the colour of the text, so it takes
 * the page's colours, light or dark, as an image could not.
 */
export function Swatch({ colour, icon }: { colour: string; icon: string | null }) {
  return (
    <span className="studio-swatch" style={{ background: colour }}>
      {icon && <span className="studio-swatch-icon" style={{ maskImage: `url(${iconUrl(icon)})`, WebkitMaskImage: `url(${iconUrl(icon)})` }} />}
    </span>
  )
}

/** An icon, as a mask over the text's colour. */
function Icon({ name }: { name: string }) {
  return <span className="studio-icon" aria-hidden="true" style={{ maskImage: `url(${iconUrl(name)})`, WebkitMaskImage: `url(${iconUrl(name)})` }} />
}

const SAID: Record<LabelIcon['source'], string> = {
  chosen: 'Chosen here.',
  common: 'Found from a common word in the label.',
  nearest: 'The nearest the model found to the label.',
  none: 'None found near enough to the label.',
}

/** The icons whose name or tags hold every word of the search, those whose name does first. */
export function matching(catalog: Record<string, string[]>, search: string): string[] {
  const words = search.toLowerCase().split(/\s+/).filter(it => it !== '')
  const names = Object.keys(catalog)
  if (!words.length) return names.slice(0, SHOWN)
  const named = (name: string) => words.every(word => name.includes(word))
  const tagged = (name: string) => words.every(word => name.includes(word) || catalog[name]!.some(tag => tag.includes(word)))
  return [...names.filter(named), ...names.filter(it => !named(it) && tagged(it))].slice(0, SHOWN)
}

/**
 * Chooses a label's icon, from Lucide's, by searching their names and tags; or none; or, with Automatic, has it found
 * again from the label. The choice is the studio's, kept in its home, for every model with the label.
 */
export function IconPicker({ label, current, onDone }: { label: string; current: LabelIcon | undefined; onDone: () => void }) {
  const [catalog, setCatalog] = useState<Record<string, string[]> | null>(null)
  const [search, setSearch] = useState('')
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    iconCatalog().then(setCatalog, (e: unknown) => setProblem(e instanceof Error ? e.message : String(e)))
  }, [])

  const shown = useMemo(() => (catalog ? matching(catalog, search) : []), [catalog, search])

  const choose = (icon: string | null | undefined) => {
    chooseIcon(label, icon).then(
      found => {
        refound(label, found)
        onDone()
      },
      (e: unknown) => setProblem(e instanceof Error ? e.message : String(e)),
    )
  }

  return (
    <Sheet
      open
      onDismiss={onDone}
      title={`Icon of ${label}`}
      description={current ? `${current.icon ? `Now ${current.icon}. ` : 'Now none. '}${SAID[current.source]}` : undefined}
      actions={
        <>
          <Button onClick={() => choose(undefined)} title="Forget the choice, and find the icon from the label again">Automatic</Button>
          <Button onClick={() => choose(null)}>None</Button>
          <Button onClick={onDone}>Cancel</Button>
        </>
      }
    >
      <div className="studio-form">
        <TextField label="Search" labelHidden placeholder="Search icons, such as user or building" value={search} autoFocus onChange={e => setSearch(e.target.value)} />
        {!catalog && !problem && <Loading label="Reading the icons" />}
        {catalog && shown.length === 0 && <p className="desk-text-small desk-text-muted">No icon matches.</p>}
        <div className="studio-icons" role="listbox" aria-label="Icons">
          {shown.map(name => (
            <button
              key={name}
              type="button"
              role="option"
              aria-selected={current?.icon === name}
              className="studio-icon-choice"
              title={name}
              onClick={() => choose(name)}
            >
              <Icon name={name} />
            </button>
          ))}
        </div>
        {problem && <p className="studio-bad desk-text-small" role="alert">{problem}</p>}
      </div>
    </Sheet>
  )
}
