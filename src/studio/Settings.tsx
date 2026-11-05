import { Sidebar, Split, useWindowRoute } from '@liberation-data/desk/react'
import { useEffect, useState } from 'react'
import { Connections } from './Connections'
import { IconSettings } from './IconSettings'
import { Icon } from './IconPicker'

/*
 * How the studio is set up, in one window, as a Mac app's Settings are: its sections down the side, and the one chosen
 * beside them. A link to a section (the connection menu's Connections…, say) opens the window on it; otherwise it
 * opens on the section used last.
 */

export const SECTIONS = ['connections', 'icons'] as const
export type SettingsSection = (typeof SECTIONS)[number]

const isSection = (it: string | null | undefined): it is SettingsSection => SECTIONS.includes(it as SettingsSection)

// The section used last, kept in this browser only: a convenience, and lost without harm.
const SECTION = 'drivine-studio.settings.section'
const remembered = (): SettingsSection => {
  try {
    const kept = window.localStorage.getItem(SECTION)
    return isSection(kept) ? kept : 'connections'
  } catch {
    return 'connections'
  }
}

export function Settings() {
  const [route, setRoute] = useWindowRoute()
  const [last] = useState(remembered)
  const section = isSection(route) ? route : last
  // A section once shown stays, hidden, while another is: a connection half edited is still there to come back to.
  const [shown, setShown] = useState<ReadonlySet<SettingsSection>>(() => new Set([section]))

  useEffect(() => {
    setShown(all => (all.has(section) ? all : new Set([...all, section])))
    try {
      window.localStorage.setItem(SECTION, section)
    } catch {
      // Not remembered; it opens on Connections next time.
    }
  }, [section])

  const sections = (
    <Sidebar
      label="Settings"
      value={section}
      onChange={id => setRoute(id)}
      sections={[{ id: 'settings', items: [
        { id: 'connections', label: 'Connections', icon: <Icon name="database" size="small" /> },
        { id: 'icons', label: 'Icons', icon: <Icon name="shapes" size="small" /> },
      ] }]}
    />
  )

  return (
    <Split side={sections} size={180} min={150} remember="drivine-studio.settings" label="Resize the sections">
      <div className="studio-settings-section" hidden={section !== 'connections'}>
        {shown.has('connections') && <Connections />}
      </div>
      <div className="studio-settings-section" hidden={section !== 'icons'}>
        {shown.has('icons') && <IconSettings />}
      </div>
    </Split>
  )
}
