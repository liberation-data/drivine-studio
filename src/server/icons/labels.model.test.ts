import { describe, expect, it } from 'vitest'
import { iconsOf } from './labels'

/**
 * Labels with the icons that would be right for them, found with the studio's own model: `npm run test:icons`, which
 * downloads the model on its first run. An empty list is a label with no icon right enough, which should get none.
 * A wrong icon fails, as it reads worse than none; so does finding fewer right than RIGHT, which a better model or list
 * raises. Change either, and this says what it fixed and what it broke.
 */
const LABELS: Record<string, string[]> = {
  ContentElement: ['file-text'], Persona: ['venetian-mask', 'users', 'user', 'user-round', 'person-standing'],
  Chunk: ['layers', 'split', 'blocks'], Widget: ['layout-grid', 'blocks', 'component'],
  Section: ['layout-template', 'section', 'heading'], Paragraph: ['text-wrap', 'pilcrow', 'text'],
  Agent: ['bot', 'user'], Tool: ['wrench', 'hammer', 'pen-tool'], Prompt: ['terminal', 'message-square', 'text-cursor'],
  Conversation: ['messages-square', 'message-square', 'message-circle'], Session: ['clock', 'timer'],
  Step: ['footprints', 'list-ordered', 'arrow-right'], Plan: ['map', 'list-todo', 'clipboard-list'],
  Goal: ['goal', 'target', 'flag'], Policy: ['shield', 'scroll-text', 'file-text'], Rule: ['scale', 'ruler', 'gavel'],
  Review: ['star', 'star-half', 'message-square'], Rating: ['star', 'star-half'],
  Category: ['folder', 'tag', 'shapes', 'tags'], Brand: ['badge', 'tag', 'award'],
  Supplier: ['truck', 'factory', 'building'], Warehouse: ['warehouse'], Shipment: ['truck', 'package', 'luggage'],
  Flight: ['plane'], Airport: ['plane', 'plane-takeoff', 'plane-landing'], Hotel: ['hotel', 'bed'],
  Booking: ['tickets', 'ticket', 'calendar-check'], Patient: ['user', 'bed', 'hospital'],
  Doctor: ['briefcase-medical', 'stethoscope', 'hospital'], Drug: ['tablets', 'pill', 'syringe'],
  Disease: ['virus', 'bug', 'biohazard'], Gene: ['dna'], Protein: ['dna', 'atom'],
  Station: ['radio-tower', 'train-front', 'tram-front'], Line: ['line-style', 'route', 'spline'], Route: ['route'],
  Device: ['tablet', 'smartphone', 'cpu', 'monitor'], Sensor: ['radar', 'gauge', 'thermometer', 'activity'],
  Reading: ['gauge', 'book-open', 'activity'], Alert: ['square-exclamation-point', 'bell', 'triangle-alert'],
  Release: ['rocket', 'tag', 'package'], Package: ['package'], Dependency: ['link', 'network', 'git-merge'],
  Module: ['puzzle', 'box', 'blocks'], Function: ['function-square', 'square-function', 'sigma', 'code'],
  Class: ['box', 'braces', 'code'], Field: ['text-cursor-input', 'form', 'rectangle-ellipsis'],
  Schema: ['table-properties', 'database', 'network', 'boxes'], Query: ['search', 'file-search', 'database'],
  Dataset: ['database', 'table', 'sheet'], Experiment: ['beaker', 'flask-conical', 'test-tube'],
  Model: ['box', 'brain', 'shapes'], Feature: ['sparkles', 'star', 'puzzle'], Metric: ['gauge', 'chart-line'],
  Dashboard: ['layout-dashboard', 'layout-grid', 'gauge', 'layout-grid-circles'], Report: ['file-chart-column', 'file-text'],
  Contract: ['file-signature', 'signature', 'receipt-text', 'file-text'], Clause: ['pilcrow', 'scroll-text', 'text'],
  Asset: ['gem', 'wallet', 'package', 'box'],
}

/** How many of LABELS get a right icon today: raise it when a change finds more, never lower it. */
const RIGHT = 28

describe.runIf(process.env.STUDIO_ICON_MODEL)("the studio's model", () => {
  it('gives each label a right icon or none, and finds at least as many right as before', async () => {
    const found = await iconsOf(Object.keys(LABELS))
    const wrong = Object.entries(found).filter(([label, it]) => it.icon !== null && !LABELS[label]!.includes(it.icon))
    const right = Object.values(found).filter(it => it.icon !== null).length - wrong.length
    const report = Object.entries(found).map(([label, it]) => `${label}: ${it.icon ?? '-'} (${it.source}${it.score === undefined ? '' : ` ${it.score}`})`)
    process.stdout.write(`${right} of ${Object.keys(LABELS).length} right, ${wrong.length} wrong\n${report.join('\n')}\n`)
    expect(wrong.map(([label, it]) => `${label}: ${it.icon}`)).toEqual([])
    expect(right).toBeGreaterThanOrEqual(RIGHT)
  }, 300_000)
})
