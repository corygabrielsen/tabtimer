// The two Vite features tests use: `?raw` imports (to load the extension's
// HTML pages) and eager import.meta.glob (to scan sources). Declared here
// rather than via vite/client to keep test typings minimal.
declare module '*?raw' {
  const content: string
  export default content
}

interface ImportMeta {
  glob<T>(patterns: string | string[], options: { query: '?raw'; import: 'default'; eager: true }): Record<string, T>
}
