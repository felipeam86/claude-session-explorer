import { atom, read, update } from 'claude-code'
import type { Register, SessionMessage, ToolUseSummary } from 'claude-code'

import type { Opened } from '../types'

const PANE = 'prompt-history'
const LINES = 4 // lines of each prompt shown in the list
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const opened = atom({ plugin: 'prompt-history', key: 'open' } as const, null as Opened)
const query = atom({ plugin: 'prompt-history', key: 'query' } as const, '')
const showTools = atom({ plugin: 'prompt-history', key: 'showTools' } as const, false)
const focusedKey = atom({ plugin: 'prompt-history', key: 'focused' } as const, '')

export type Turn = { prompt: string; reply: string; tools: ToolUseSummary[] }

// User rows the person did not type as a prompt: slash commands and their output, `!`
// shell runs, background-task notices, reminders, and a skill's body as it loads.
const NOT_TYPED =
  /^(<(command-(name|message|args)|local-command-[a-z]+|bash-(input|stdout|stderr)|task-notification|system-reminder)>|Base directory for this skill: )/

// A real prompt: a user row with typed text and no tool results. The reply is the turn's
// last assistant text, i.e. the final answer, not the narration before tool calls.
export function toTurns(messages: readonly SessionMessage[]): Turn[] {
  const turns: Turn[] = []
  for (const m of messages) {
    if (m.role === 'user' && m.text.trim() && !m.toolResults?.length && !NOT_TYPED.test(m.text.trim())) {
      turns.push({ prompt: m.text.trim(), reply: '', tools: [] })
    } else if (m.role === 'assistant' && turns.at(-1)) {
      const t = turns.at(-1)!
      if (m.text.trim()) t.reply = m.text.trim()
      t.tools.push(...m.toolUses)
    }
  }
  return turns
}

// The turns whose prompt holds q, with their place in the session; all of them when
// q is empty.
export function matches(turns: readonly Turn[], q: string): { t: Turn; i: number }[] {
  const needle = q.toLowerCase()
  return turns
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.prompt.toLowerCase().includes(needle))
}

export function stats(t: Turn): string {
  const files = new Set(
    t.tools.filter(u => EDITS.has(u.tool)).map(u => String(u.input.file_path ?? u.input.notebook_path)),
  )
  const parts = [`${t.tools.length} tool call${t.tools.length === 1 ? '' : 's'}`]
  if (files.size) parts.push(`${files.size} file${files.size === 1 ? '' : 's'} edited`)
  return parts.join(' · ')
}

// The one argument that says what a call did.
const detail = (u: ToolUseSummary) => {
  const i = u.input
  const v = i.command ?? i.file_path ?? i.notebook_path ?? i.pattern ?? i.url ?? i.query ?? i.description ?? i.skill
  return typeof v === 'string' ? v : ''
}

const oneLine = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, ' ')
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat
}

// Greedy word wrap into lines of at most `width` columns; a word wider than a line is cut.
export function wrap(text: string, width: number): string[] {
  const lines: string[] = []
  let line = ''
  for (let word of text.split(/\s+/).filter(Boolean)) {
    while (word.length > width) {
      if (line) lines.push(line)
      line = ''
      lines.push(word.slice(0, width))
      word = word.slice(width)
    }
    if (line && line.length + 1 + word.length <= width) line += ` ${word}`
    else {
      if (line) lines.push(line)
      line = word
    }
  }
  if (line) lines.push(line)
  return lines
}

// A prompt's list entry: up to LINES lines, each padded to one width so a highlight over
// them reads as one block.
export function preview(prompt: string, width: number): string[] {
  const lines = wrap(prompt, width)
  const kept = lines.slice(0, LINES)
  if (lines.length > LINES) kept[LINES - 1] = `${kept[LINES - 1]!.slice(0, width - 1)}…`
  return kept.map((l, k) => `${k ? ' ' : '>'} ${l}`.padEnd(width + 2))
}

// The pane's focus ring is positional: it holds the Nth focusable, not a key. So the
// search box is the first focusable (filtering rows below it never moves it), and
// every view change puts the ring on a named element itself.
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'prompt-history', description: 'Browse the prompts sent in this session' })
    return next(e)
  })

  on('command.run', { command: 'prompt-history' }, async $ => {
    await update($, opened, () => null)
    await update($, query, () => '') // the engine empties the search box on close
    await update($, focusedKey, () => '')
    await $.ui.open({ id: PANE, title: 'Prompts', focus: true, closeOnEscape: true })
    return { text: 'Prompt history opened (↑/↓ to move, Enter to expand, Esc to close).' }
  })

  // The list's focusables in ring order as last drawn (empty while a prompt is open).
  let ring: string[] = []

  // Remember who holds the ring (the list draws that entry lit) and keep it on screen.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const r = await next(e)
    if (!r.deny) await update($, focusedKey, () => e.element ?? '')
    if (e.element) void $.ui.scroll({ in: PANE, to: { key: e.element } }).catch(() => undefined) // kit: no window
    return r
  })

  // Once the list is taller than the pane, the engine hands ↑/↓ to scrolling. Turn them
  // back into steps between prompts, wrapping as the ring does; the wheel (which carries
  // a pointer) and the page keys still scroll.
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    const isArrow = e.origin.kind === 'person' && e.pointer === undefined && Math.abs(e.by) === 1
    if (!isArrow || ring.length === 0) return next(e)
    const at = ring.indexOf(await read($, focusedKey))
    const to = at === -1 ? (e.by > 0 ? 0 : ring.length - 1) : (at + e.by + ring.length) % ring.length
    await $.ui.focus({ requestId: PANE, key: ring[to]! }).catch(() => undefined) // the test kit has no ring
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = ui
    const Input = 'Input' in ui ? ui.Input : undefined
    const turns = toTurns(await $.session.messages())
    const idx = await read($, opened)
    const q = await read($, query)
    const width = Math.max(20, (e.props.bodyColumns ?? 60) - 4)
    // Puts the ring on one of this pane's elements. A session answers { deny } when it
    // cannot; the test kit, which has no ring, rejects instead.
    const focus = (key: string) => $.ui.focus({ requestId: PANE, key }).catch(() => undefined)

    if (idx === null || !turns[idx]) {
      const shown = matches(turns, q)
      const lit = await read($, focusedKey)
      ring = [...(Input ? ['search'] : []), ...shown.map(({ i }) => `row:${i}`)]
      return (
        <Box flexDirection="column">
          {Input && (
            <Box flexDirection="column" marginBottom={1}>
              <Input
                key="search"
                label="Search"
                // Enter empties the box but keeps the filter, so the empty box says how to drop it.
                placeholder={q ? `Enter to clear "${q}"` : 'filter prompts'}
                submitLabel="jump to newest"
                onInput={(v: string) => void update($, query, () => v)}
                onSubmit={async (v: string) => {
                  await update($, query, () => v)
                  const newest = matches(turns, v).at(-1)
                  if (v && newest) await focus(`row:${newest.i}`)
                }}
              />
              {q && (
                <Text dimColor>
                  {shown.length} of {turns.length} match "{q}"
                </Text>
              )}
            </Box>
          )}
          {!turns.length && <Text dimColor>No prompts yet.</Text>}
          {shown.map(({ t, i }, n) => {
            // An entry is dim at rest and lit (full strength, inverted) under the focus or the
            // pointer. The engine lights a Button's first line only, so the label holds line one
            // and the rest are Texts lit to match. Theme colors and text attributes only, so
            // light and dark themes both read right.
            const [first = '', ...rest] = preview(t.prompt, width)
            const isLit = lit === `row:${i}`
            return (
              <Box key={`item:${i}`} flexDirection="column" marginBottom={1}>
                <Button
                  key={`row:${i}`}
                  plain
                  dimColor
                  hover={{ inverse: true, dimColor: false }}
                  autoFocus={n === shown.length - 1 ? true : undefined}
                  label={first}
                  onPress={async () => {
                    await update($, opened, () => i)
                    await focus('back')
                  }}
                />
                {rest.map(line => (
                  <Text inverse={isLit} dimColor={!isLit} hover={{ inverse: true, dimColor: false }}>
                    {line}
                  </Text>
                ))}
                <Box flexDirection="column" paddingLeft={2}>
                  {t.reply && <Text color="briefLabelClaude">⏺ {oneLine(t.reply, width - 2)}</Text>}
                  <Text dimColor italic>
                    #{i + 1} · {stats(t)}
                  </Text>
                </Box>
              </Box>
            )
          })}
        </Box>
      )
    }

    ring = [] // a prompt is open: ↑/↓ scroll its reply
    const t = turns[idx]
    const tools = await read($, showTools)
    // Prev and Next are always drawn, so the buttons keep their places from turn to turn.
    const step = async (i: number, key: string) => {
      if (!turns[i]) return
      await update($, opened, () => i)
      await focus(key)
    }
    return (
      <Box flexDirection="column" gap={1}>
        <Box gap={1} flexWrap="wrap">
          <Button
            key="back"
            hotkey="b"
            label="Back"
            onPress={async () => {
              await update($, opened, () => null)
              // Land on the prompt just viewed, or the newest one the filter shows.
              const shown = matches(turns, q)
              const row = shown.find(s => s.i === idx) ?? shown.at(-1)
              await focus(row ? `row:${row.i}` : 'search')
            }}
          />
          <Button key="prev" hotkey="p" label="◀ Prev" dimColor={idx === 0} onPress={() => step(idx - 1, 'prev')} />
          <Button
            key="next"
            hotkey="n"
            label="Next ▶"
            dimColor={idx === turns.length - 1}
            onPress={() => step(idx + 1, 'next')}
          />
          <Button
            key="jump"
            hotkey="j"
            label="Jump to reply"
            onPress={() => $.ui.scroll({ in: PANE, to: { key: 'reply' }, block: 'start' })}
          />
          <Button
            key="rewind"
            hotkey="r"
            label="Rewind…"
            onPress={async () => {
              await $.ui.close({ id: PANE })
              // ponytail: no API to rewind to a given message; open the native picker
              // and say which one. Upgrade when the engine exposes a rewind call.
              $.ui.toast(`Pick prompt #${idx + 1}: "${oneLine(t.prompt, 40)}"`)
              await $.command.run({ command: 'rewind' })
            }}
          />
          <Button
            key="fill"
            hotkey="e"
            label="Edit as new prompt"
            onPress={async () => {
              await $.prompt.fill({ text: t.prompt })
              await $.ui.close({ id: PANE })
            }}
          />
        </Box>
        <Text dimColor>
          Prompt {idx + 1} of {turns.length} · {stats(t)}
        </Text>
        <Box backgroundColor="userMessageBackground" paddingRight={1}>
          <Text dimColor>{'> '}</Text>
          <Box flexGrow={1}>
            <Text>{t.prompt}</Text>
          </Box>
        </Box>
        {t.tools.length > 0 && (
          <Box flexDirection="column">
            <Button
              key="tools"
              hotkey="t"
              plain
              dimColor
              label={`${tools ? '▾' : '▸'} ${t.tools.length} tool call${t.tools.length === 1 ? '' : 's'}`}
              onPress={() => update($, showTools, v => !v)}
            />
            {tools &&
              t.tools.map(u => (
                <Box paddingLeft={2}>
                  <Text color={u.isError ? 'error' : undefined} dimColor={!u.isError}>
                    {u.isError ? '✗' : '·'} <Text bold>{u.tool}</Text> {oneLine(detail(u), width - u.tool.length - 6)}
                  </Text>
                </Box>
              ))}
          </Box>
        )}
        <Box key="reply">
          <Text color="briefLabelClaude">{'⏺ '}</Text>
          <Box flexGrow={1}>
            {t.reply ? <Markdown text={t.reply.slice(0, 10000)} /> : <Text dimColor>(no text reply)</Text>}
          </Box>
        </Box>
      </Box>
    )
  })
}
