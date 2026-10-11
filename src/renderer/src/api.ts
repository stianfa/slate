export const api = window.slate.api
export const platform = window.slate.platform

export const isMac = platform === 'darwin'
export const modKey = isMac ? '⌘' : 'Ctrl'
