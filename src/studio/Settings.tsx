import { Pane, SegmentedControl, Sidebar, Split, useWindowRoute } from '@liberation-data/desk/react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { appearance, onAppearanceChange, setAppearance } from './appearance'
import type { Appearance } from './appearance'
import { IconSettings } from './IconSettings'
import { Icon } from './IconPicker'

/*
 * How the studio looks and behaves, in one window, as a Mac app's Settings are: its sections down the side, and the
 * one chosen beside them. A link to a section opens the window on it; otherwise it opens on the section used last.
 * The databases are not here: they have a window of their own, Connections.
 */

export const SECTIONS = ['appearance', 'icons'] as const
export type SettingsSection = (typeof SECTIONS)[number]

const isSection = (it: string | null | undefined): it is SettingsSection => SECTIONS.includes(it as SettingsSection)

// The section used last, kept in this browser only: a convenience, and lost without harm.
const SECTION = 'drivine-studio.settings.section'
const remembered = (): SettingsSection => {
  try {
    const kept = window.localStorage.getItem(SECTION)
    return isSection(kept) ? kept : 'appearance'
  } catch {
    return 'appearance'
  }
}

/** The Settings window: Appearance and Icons down the side, on the section its route names, else the one used last. */
export function Settings() {
  const [route, setRoute] = useWindowRoute()
  const [last] = useState(remembered)
  const section = isSection(route) ? route : last
  // A section once shown stays, hidden, while another is: a search half typed is still there to come back to.
  const [shown, setShown] = useState<ReadonlySet<SettingsSection>>(() => new Set([section]))

  useEffect(() => {
    setShown(all => (all.has(section) ? all : new Set([...all, section])))
    try {
      window.localStorage.setItem(SECTION, section)
    } catch {
      // Not remembered; it opens on Appearance next time.
    }
  }, [section])

  const sections = (
    <Sidebar
      label="Settings"
      value={section}
      onChange={id => setRoute(id)}
      sections={[{ id: 'settings', items: [
        { id: 'appearance', label: 'Appearance', icon: <Icon name="sun-moon" size="small" /> },
        { id: 'icons', label: 'Icons', icon: <Icon name="shapes" size="small" /> },
      ] }]}
    />
  )

  return (
    <Split side={sections} size={180} min={150} remember="drivine-studio.settings" label="Resize the sections">
      <div className="studio-settings-section" hidden={section !== 'appearance'}>
        {shown.has('appearance') && <AppearanceSettings />}
      </div>
      <div className="studio-settings-section" hidden={section !== 'icons'}>
        {shown.has('icons') && <IconSettings />}
      </div>
    </Split>
  )
}

const CHOICES: { value: Appearance; label: string; icon: string }[] = [
  { value: 'system', label: 'System', icon: 'monitor' },
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
]

/** Light, dark, or as the system is: applied at once, to every window. */
export function AppearanceSettings() {
  const chosen = useSyncExternalStore(onAppearanceChange, appearance, () => 'system' as const)
  return (
    <Pane padded label="Appearance">
      <div className="studio-appearance-choice">
        <SegmentedControl
          label="Appearance"
          width="fit"
          value={chosen}
          onChange={setAppearance}
          options={CHOICES.map(({ value, label, icon }) => ({ value, label, icon: <Icon name={icon} size="small" /> }))}
        />
      </div>
      <p className="desk-text-small desk-text-muted">
        System is light or dark as your system is, and changes when it does. The choice is kept in this browser, or in
        the desktop app.
      </p>
    </Pane>
  )
}
