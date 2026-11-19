import { test, expect } from 'claude-code/testing'

test('the spinner shows the tool call count', async ($, on) => {
  // Stand in for the engine beneath the plugin
  on('tool.call', () => ({ result: 'ok' }))
  let suffix = ''
  on('ui.render', { component: 'Spinner' }, (h$, e) => {
    suffix = e.props.suffix
    const { Text } = h$.ui.resolve(e)
    return h(Text, {}, e.props.word + suffix)
  })

  await $.tool.call({ tool: 'Read', file_path: '/a.txt' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.ui.render({
    surface: 'terminal',
    component: 'Spinner',
    requestId: 'main',
    props: { word: 'Thinking', message: null, suffix: '…', mode: 'thinking' },
  })

  expect(suffix).toBe(' · tool calls: 2…')
})
