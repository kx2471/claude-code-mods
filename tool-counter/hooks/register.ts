import type { Register } from 'claude-code'

// The count, shared by the two hooks below
let calls = 0

export const register: Register = on => {
  // Runs each time Claude is about to use a tool
  on('tool.call', async ($, e, next) => {
    calls += 1
    // Ask Claude Code to draw the interface again, so the new count shows
    $.ui.invalidate('ui.render')
    // Let the tool run as usual
    return next(e)
  }).catch(($, e, next) => next(e)) // never block a tool if counting fails

  // Runs each time Claude Code draws the spinner
  on('ui.render', { component: 'Spinner' }, async ($, e, next) =>
    // Keep Claude Code's spinner, with the count added after its word
    next({ ...e, props: { ...e.props, suffix: ` · tool calls: ${calls}…` } }),
  )
}
