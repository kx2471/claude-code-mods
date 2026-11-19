export type Todo = { id: string; text: string; activeText: string; status: string }

declare module 'claude-code' {
  interface PluginState {
    'usage-band': { todos: Todo[] }
  }
}
