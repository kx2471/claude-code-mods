import { test, expect, mock } from 'claude-code/testing'

test('the band shows context, rate limits and cost', async ($, on) => {
  mock.clock(on)
  // Stand in for the engine's figures
  on('session.usage', () => ({ value: {
    startedAt: 0,
    context: { tokens: 84000, window: 200000, percent: 42 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 93 }],
    cost: { usd: 1.234 },
  } }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'usage-band',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 } as never,
    })
    expect(await ui.find({ type: 'Text', text: '████░░░░░░ 42%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '(84k/200k)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '█████████░ 93%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '$1.23' })).toBeDefined()
    await ui.unmount()
  }
})

// Every row the band draws, as the text a terminal would show
const rowsOf = async (ui: { drawn: () => Promise<unknown> }) => {
  const text = (node: any): string =>
    typeof node === 'string' ? node : (node?.children ?? []).map(text).join('')
  const rows: string[] = []
  const walk = (node: any) => {
    if (node && typeof node === 'object') {
      if (node.type === 'Box' && String(node.props?.key ?? '').startsWith('row-')) rows.push(text(node))
      else (node.children ?? []).forEach(walk)
    }
  }
  walk(await ui.drawn())
  return rows
}

// Cells in a terminal: Hangul takes two
const cells = (text: string) =>
  [...text].reduce((sum, char) => sum + (/[ᄀ-ᅟ가-힣]/.test(char) ? 2 : 1), 0)

test('the band fits its width: whole figures, fewer cells, then fewer details', async ($, on) => {
  mock.clock(on)
  on('session.usage', () => ({ value: {
    startedAt: 0,
    context: { tokens: 84000, window: 200000, percent: 42 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 93, resetsAt: new Date(2 * 3600000 + 600000).toISOString() },
      { kind: 'seven_day', percentUsed: 12, resetsAt: new Date(3 * 86400000).toISOString() },
    ],
    cost: { usd: 1.234 },
  } }))

  const draw = async (bodyColumns: number) => {
    const ui = await $.ui.mount({
      plugin: 'usage-band',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns } as never,
    })
    const rows = await rowsOf(ui)
    await ui.unmount()
    for (const row of rows) expect(cells(row), `"${row}" at ${bodyColumns}`).toBeLessThanOrEqual(bodyColumns)
    return rows
  }

  const wide = await draw(120)
  expect(wide).toHaveLength(1)
  expect(wide[0]).toContain('컨텍스트 ████░░░░░░ 42% (84k/200k)')
  expect(wide[0]).toContain('5시간 █████████░ 93% (2h10m)')
  expect(wide[0]).toContain('$1.23')

  // Whole figures move to the next row instead of being cut
  const medium = await draw(60)
  expect(medium.length).toBeGreaterThan(1)
  expect(medium.join('\n')).toContain('컨텍스트 ████░░░░░░ 42% (84k/200k)')

  // Up to three rows keep full detail
  const three = await draw(36)
  expect(three).toHaveLength(3)
  expect(three[0]).toBe('컨텍스트 ████░░░░░░ 42% (84k/200k)')

  // Narrower: shorter meters, then the details go
  const narrow = await draw(30)
  expect(narrow[0]).toBe('컨텍스트 ██░░░ 42% (84k/200k)')
  const small = await draw(22)
  expect(small[0]).toBe('컨텍스트 ██░░░ 42%')
  expect(small.join('\n')).not.toContain('(')

  // Too narrow even for short meters: the percentages alone
  const tiny = await draw(16)
  expect(tiny[0]).toBe('컨텍스트 42%')
  expect(tiny.join('\n')).not.toContain('█')
})
