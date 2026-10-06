export type Opened = number | null

declare module 'claude-code' {
  interface PluginState {
    // focused: the key of the element holding the pane's focus ring ('' when none)
    'prompt-history': { open: Opened; query: string; showTools: boolean; focused: string }
  }
}
