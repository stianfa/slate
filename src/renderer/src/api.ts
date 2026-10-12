export const api = window.slate.api
export const platform = window.slate.platform
export const onChatDelta = window.slate.onChatDelta

export const isMac = platform === 'darwin'
export const modKey = isMac ? '⌘' : 'Ctrl'
