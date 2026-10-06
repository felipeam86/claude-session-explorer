import { expect, test } from 'claude-code/testing'

import { preview, wrap } from '../hooks/register'

const rows = [
  { role: 'user', text: '<local-command-caveat>The command below was run directly</local-command-caveat>', toolUses: [] },
  { role: 'user', text: '<command-name>/model</command-name>\n<command-message>model</command-message>', toolUses: [] },
  { role: 'user', text: 'first ask', toolUses: [] },
  {
    role: 'assistant',
    text: 'narration before a tool',
    toolUses: [
      { tool_use_id: 'a', tool: 'Edit', input: { file_path: '/x.ts' } },
      { tool_use_id: 'b', tool: 'Bash', input: { command: 'ls' } },
    ],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text: 'r', isError: false }] },
  { role: 'assistant', text: 'x'.repeat(800), toolUses: [] },
  { role: 'user', text: 'Base directory for this skill: /tmp/skills/x', toolUses: [] },
  { role: 'user', text: 'second ask', toolUses: [] },
  { role: 'assistant', text: 'done', toolUses: [] },
]

// The focusables in the order the pane's focus ring counts them. The ring holds a
// position, not a key, so what sits at a position must not shift under the person.
const ring = (el: unknown): string[] => {
  if (typeof el !== 'object' || el === null) return []
  const { type, props, children } = el as { type?: string; props?: { key?: string }; children?: unknown[] }
  if (type === 'Button' || type === 'Input' || type === 'Select') return [String(props?.key)]
  return (children ?? []).flatMap(ring)
}

test('lists, filters, expands, steps and shows tools', async ($, on) => {
  on('session.messages', async () => ({ value: rows }) as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'prompt-history', surface, component: 'Pane', requestId: 'prompt-history',
      props: { bodyColumns: 60 } as never,
    })
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(2)
    expect(await ui.find({ type: 'Text', text: /2 tool calls · 1 file edited/ })).toBeDefined()
    // Entries are dim at rest (the focus lights one up); the reply glance has a theme color.
    expect((await ui.find({ key: 'row:0' }))?.props.dimColor).toBe(true)
    expect((await ui.find({ type: 'Text', text: /^⏺ done/ }))?.props.color).toBe('briefLabelClaude')

    // Typing filters live, and the search box stays first while rows drop out.
    expect(ring(await ui.drawn())).toEqual(['search', 'row:0', 'row:1'])
    await ui.input({ key: 'search', text: 'second', kind: 'change' })
    expect(ring(await ui.drawn())).toEqual(['search', 'row:1'])
    expect(await ui.find({ type: 'Text', text: /1 of 2 match "second"/ })).toBeDefined()
    await ui.input({ key: 'search', text: 'done', kind: 'change' }) // only in a reply
    expect(ring(await ui.drawn())).toEqual(['search'])

    // Enter keeps the filter; Enter on an empty box drops it.
    await ui.input({ key: 'search', text: 'first' })
    expect(ring(await ui.drawn())).toEqual(['search', 'row:0'])
    await ui.input({ key: 'search', text: '' })
    expect(ring(await ui.drawn())).toEqual(['search', 'row:0', 'row:1'])

    await ui.press({ key: 'row:0' })
    expect(await ui.find({ type: 'Text', text: /Prompt 1 of 2/ })).toBeDefined()
    expect((await ui.find({ type: 'Markdown' }))?.text.length).toBe(800)
    expect(await ui.find({ type: 'Text', text: /narration/ })).toBeUndefined()
    const buttons = ['back', 'prev', 'next', 'jump', 'rewind', 'fill']
    expect(ring(await ui.drawn())).toEqual([...buttons, 'tools'])

    await ui.press({ key: 'tools' })
    expect(await ui.find({ type: 'Text', text: /ls/ })).toBeDefined()
    await ui.press({ key: 'tools' })

    await ui.press({ key: 'prev' }) // nothing before the first turn
    expect(await ui.find({ type: 'Text', text: /Prompt 1 of 2/ })).toBeDefined()
    await ui.press({ key: 'next' })
    expect(await ui.find({ type: 'Text', text: /Prompt 2 of 2/ })).toBeDefined()
    expect(ring(await ui.drawn())).toEqual(buttons) // same places, no tools row

    await ui.press({ key: 'back' })
    expect(ring(await ui.drawn())).toEqual(['search', 'row:0', 'row:1'])
    await ui.unmount()
  }
})

test('arrows step through a long list; the wheel and page keys still scroll', async ($, on) => {
  on('session.messages', async () => ({ value: rows }) as never)
  const scrolled: number[] = [] // the moves that reached the engine's window
  on('ui.scroll', async (_, e) => (scrolled.push(e.by), {}))
  const scroll = (by: number, pointer?: { column: number; row: number }) =>
    $.ui.scroll({
      component: 'Pane', requestId: 'prompt-history', offset: 0, by, bodyRows: 5, contentRows: 20,
      origin: { kind: 'person' }, ...(pointer && { pointer }),
    } as never)
  const ui = await $.ui.mount({
    plugin: 'prompt-history', surface: 'terminal', component: 'Pane', requestId: 'prompt-history',
    props: { bodyColumns: 60 } as never,
  })
  await scroll(-1) // ↑ in the list: a step, not a scroll
  await scroll(1, { column: 3, row: 2 }) // a wheel tick
  await scroll(-5) // Page Up
  expect(scrolled).toEqual([1, -5])

  await ui.press({ key: 'row:0' }) // a prompt is open: ↑/↓ scroll its reply
  await scroll(1)
  expect(scrolled).toEqual([1, -5, 1])
  await ui.unmount()
})

test('a prompt wraps by word into a padded block of at most four lines', () => {
  expect(wrap('aaa bbb ccc', 7)).toEqual(['aaa bbb', 'ccc'])
  expect(wrap('abcdefghij xy', 4)).toEqual(['abcd', 'efgh', 'ij', 'xy']) // a long word is cut
  expect(preview('one two three four five six seven eight nine ten', 9)).toEqual([
    '> one two  ',
    '  three    ',
    '  four five',
    '  six seve…',
  ])
})

test('the focused entry is lit on every line', async ($, on) => {
  on('session.messages', async () => ({
    value: [
      { role: 'user', text: 'word '.repeat(40).trim(), toolUses: [] }, // four lines at this width
      { role: 'assistant', text: 'ok', toolUses: [] },
      { role: 'user', text: 'short', toolUses: [] },
    ],
  }) as never)
  on('ui.focus', async () => ({}))
  on('ui.scroll', async () => ({}))
  const ui = await $.ui.mount({
    plugin: 'prompt-history', surface: 'terminal', component: 'Pane', requestId: 'prompt-history',
    props: { bodyColumns: 60 } as never,
  })
  const lit = async () => (await ui.findAll({ type: 'Text' })).filter(t => t.props.inverse === true).length
  const focus = (element: string) =>
    $.ui.focus({
      component: 'Pane', requestId: 'prompt-history', plugin: 'prompt-history', element,
      origin: { kind: 'person' },
    } as never)
  expect(await lit()).toBe(0)
  await focus('row:0')
  expect(await lit()).toBe(3) // lines two to four; the Button draws line one lit itself
  await focus('row:1')
  expect(await lit()).toBe(0)
  await ui.unmount()
})
