'use client'

// The Cypher window's editor: CodeMirror, with Cypher drawn in desk's code colours, and labels, relationship types and
// property keys completed from the connection's graph. Loaded on its own (see Cypher), so the window draws first.

import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, startCompletion } from '@codemirror/autocomplete'
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { json } from '@codemirror/lang-json'
import { bracketMatching, HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import type { StringStream } from '@codemirror/language'
import { Compartment, EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap, placeholder as placeholderText } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { useEffect, useRef } from 'react'
import { completionsFor, expecting, isAtom, isKeyword } from './cypherSyntax'
import type { GraphSchema } from './schema'

interface CypherState {
  /** In a block comment, carried to the next line. */
  comment: boolean
  /** The last thing read: a colon (a label or type follows), a dot (a property key follows), or a map's opening. */
  after: 'colon' | 'dot' | 'key' | null
  /** The brackets open, innermost last: a colon in a map is a value's, not a label's. */
  open: string[]
}

/** Cypher's tokens, as CodeMirror's stream languages read them: line by line, with what carries over in the state. */
const cypher = StreamLanguage.define<CypherState>({
  name: 'cypher',
  startState: () => ({ comment: false, after: null, open: [] }),
  copyState: s => ({ comment: s.comment, after: s.after, open: [...s.open] }),
  token(stream: StringStream, state: CypherState): string | null {
    if (state.comment) {
      if (stream.skipTo('*/')) {
        stream.next()
        stream.next()
        state.comment = false
      } else stream.skipToEnd()
      return 'comment'
    }
    if (stream.eatSpace()) return null
    if (stream.match('//')) {
      stream.skipToEnd()
      return 'comment'
    }
    if (stream.match('/*')) {
      state.comment = true
      return 'comment'
    }
    const after = state.after
    state.after = null
    const c = stream.peek()!
    if (c === "'" || c === '"') {
      stream.next()
      let escaped = false
      for (let ch = stream.next(); ch !== undefined; ch = stream.next()) {
        if (ch === c && !escaped) break
        escaped = !escaped && ch === '\\'
      }
      return 'string'
    }
    if (c === '`') {
      stream.next()
      stream.skipTo('`') ? stream.next() : stream.skipToEnd()
      return after === 'colon' ? 'typeName' : after === 'dot' || after === 'key' ? 'propertyName' : 'variableName'
    }
    if (stream.match(/^\$[A-Za-z_][A-Za-z0-9_]*/) || stream.match(/^\$[0-9]+/)) return 'special'
    if (stream.match(/^-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?/)) return 'number'
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) {
      const word = stream.current()
      if (after === 'colon') return 'typeName'
      if (after === 'dot') return 'propertyName'
      // A key in a map: the word before its colon.
      if ((after === 'key' || state.open[state.open.length - 1] === '{') && stream.match(/^\s*:/, false)) return 'propertyName'
      if (isKeyword(word)) return 'keyword'
      if (isAtom(word)) return 'atom'
      if (stream.match(/^\s*\(/, false)) return 'function'
      return 'variableName'
    }
    stream.next()
    if (c === ':') {
      state.after = state.open[state.open.length - 1] === '{' ? null : 'colon'
      return 'operator'
    }
    if ((c === '|' || c === '&') && after === null && stream.string.slice(0, stream.start).match(/:[A-Za-z0-9_`]+\s*$/)) {
      state.after = 'colon'
      return 'operator'
    }
    if (c === '.') {
      state.after = 'dot'
      return 'operator'
    }
    if (c === '(' || c === '[' || c === '{') {
      state.open.push(c)
      if (c === '{') state.after = 'key'
      return 'bracket'
    }
    if (c === ')' || c === ']' || c === '}') {
      state.open.pop()
      return 'bracket'
    }
    if (c === ',' && state.open[state.open.length - 1] === '{') state.after = 'key'
    return /[-+*/%=<>!^]/.test(c) ? 'operator' : 'punctuation'
  },
  tokenTable: {
    typeName: t.typeName,
    propertyName: t.propertyName,
    special: t.special(t.variableName),
    function: t.function(t.variableName),
    atom: t.atom,
    punctuation: t.punctuation,
  },
  languageData: { commentTokens: { line: '//', block: { open: '/*', close: '*/' } } },
})

/** desk's code colours, as its CodeBlock draws code: the tokens follow the theme, light and dark. */
const deskColours = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--desk-code-keyword)', fontWeight: '600' },
  { tag: [t.string, t.special(t.string)], color: 'var(--desk-code-string)' },
  { tag: [t.number, t.atom, t.bool, t.null], color: 'var(--desk-code-number)' },
  { tag: t.comment, color: 'var(--desk-code-comment)', fontStyle: 'italic' },
  { tag: t.typeName, color: 'var(--desk-code-key)', fontWeight: '600' },
  { tag: t.propertyName, color: 'var(--desk-code-key)' },
  { tag: t.special(t.variableName), color: 'var(--desk-code-number)' },
  { tag: t.function(t.variableName), color: 'var(--desk-accent)' },
])

/** The editor drawn as desk's fields are: its border, background and focus ring, in the studio's mono type. */
const deskTheme = EditorView.theme({
  '&': {
    color: 'var(--desk-ink)',
    backgroundColor: 'var(--desk-field-bg)',
    border: '1px solid var(--desk-rule)',
    borderRadius: 'var(--desk-control-radius)',
    fontSize: 'var(--desk-text-small)',
    height: '100%',
  },
  '&.cm-focused': { outline: '2px solid var(--desk-accent)', outlineOffset: '2px' },
  '.cm-scroller': { fontFamily: 'var(--desk-font-mono)', lineHeight: '1.5', overflow: 'auto' },
  '.cm-content': { padding: 'var(--desk-space-2) 0', caretColor: 'var(--desk-ink)' },
  '.cm-line': { padding: '0 var(--desk-space-3)' },
  '.cm-cursor': { borderLeftColor: 'var(--desk-ink)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--desk-accent) 28%, transparent) !important',
  },
  '.cm-placeholder': { color: 'var(--desk-muted)' },
  '.cm-matchingBracket': { backgroundColor: 'color-mix(in srgb, var(--desk-accent) 18%, transparent)', outline: 'none' },
  '.cm-tooltip': {
    backgroundColor: 'var(--desk-surface)',
    color: 'var(--desk-ink)',
    border: '1px solid var(--desk-rule)',
    borderRadius: 'var(--desk-control-radius)',
    boxShadow: '0 6px 20px rgb(0 0 0 / 0.18)',
    overflow: 'hidden',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--desk-font-mono)', fontSize: 'var(--desk-text-small)', maxHeight: '16em' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '2px var(--desk-space-3) 2px var(--desk-space-2)' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--desk-accent)', color: 'var(--desk-on-accent)' },
  '.cm-completionDetail': { color: 'var(--desk-muted)', fontStyle: 'normal', marginLeft: '0.75em' },
  '.cm-tooltip-autocomplete ul li[aria-selected] .cm-completionDetail': { color: 'inherit', opacity: '0.8' },
  '.cm-completionIcon': { display: 'none' },
})

// A function says so; a list of one kind, as labels or keys, needs no word beside each.
const DETAIL: Record<string, string> = { function: 'function' }

/** Completion from the schema the editor holds now: labels, types and keys of the graph, and Cypher's own words. */
const fromSchema = (schema: () => GraphSchema) => (context: CompletionContext): CompletionResult | null => {
  const text = context.state.doc.toString()
  const expected = expecting(text, context.pos)
  if (expected.kind === 'none') return null
  // A word of the language is offered once something is typed, or when asked for; a name of the graph at once.
  if (expected.kind === 'word' && !context.explicit && expected.typed.length < 2) return null
  const options = completionsFor(expected, schema()).map(o => ({ ...o, detail: DETAIL[o.type] || undefined }))
  if (!options.length) return null
  return { from: expected.from, options, validFor: /^[A-Za-z0-9_]*$/ }
}

export interface CypherEditorProps {
  id: string
  /** 'cypher' for a statement, 'json' for its parameters. */
  language: 'cypher' | 'json'
  value: string
  onChange: (value: string) => void
  /** ⌘↵ or Ctrl+↵. */
  onRun: () => void
  schema?: GraphSchema
  placeholder?: string
  label: string
}

export default function CypherEditor({ id, language, value, onChange, onRun, schema, placeholder, label }: CypherEditorProps) {
  const host = useRef<HTMLDivElement | null>(null)
  const view = useRef<EditorView | null>(null)
  // What the editor's callbacks reach for: the latest, without rebuilding the editor.
  const latest = useRef({ onChange, onRun, schema })
  latest.current = { onChange, onRun, schema }

  useEffect(() => {
    if (!host.current) return
    const run = () => {
      latest.current.onRun()
      return true
    }
    const languages = new Compartment()
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          Prec.highest(keymap.of([{ key: 'Mod-Enter', run }])),
          history(),
          closeBrackets(),
          bracketMatching(),
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
          languages.of(language === 'json' ? json() : cypher),
          syntaxHighlighting(deskColours),
          deskTheme,
          ...(language === 'cypher'
            ? [
                autocompletion({ override: [fromSchema(() => latest.current.schema ?? { labels: [], relationshipTypes: [], propertyKeys: [] })], icons: false }),
                // After a colon or a dot, the names are offered before a letter is typed.
                EditorView.inputHandler.of((v, _from, _to, text) => {
                  if (text === ':' || text === '.') setTimeout(() => startCompletion(v), 0)
                  return false
                }),
              ]
            : []),
          ...(placeholder ? [placeholderText(placeholder)] : []),
          EditorView.contentAttributes.of({ id, 'aria-label': label, spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
          EditorView.updateListener.of(update => {
            if (update.docChanged) latest.current.onChange(update.state.doc.toString())
          }),
        ],
      }),
    })
    view.current = editor
    return () => {
      editor.destroy()
      view.current = null
    }
    // The editor is made once per language; its text follows `value` below.
  }, [language])

  // A statement set from outside, as one dropped in, opened from Files or sent from the canvas, replaces the text.
  useEffect(() => {
    const editor = view.current
    if (!editor) return
    const now = editor.state.doc.toString()
    if (now !== value) editor.dispatch({ changes: { from: 0, to: now.length, insert: value } })
  }, [value])

  return <div ref={host} className="studio-editor-host studio-statement" data-language={language} />
}
