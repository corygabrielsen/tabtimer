# Tab Timer

A Chrome extension that shows how much time you've spent on social media sites today.

## Stack

- TypeScript 5.7
- Vite 6
- ESLint 9 (flat config)
- Prettier
- pnpm

## Development

```sh
pnpm install
pnpm dev       # dev server
pnpm build     # production build
pnpm watch     # rebuild on changes
```

## Lint & Format

```sh
pnpm lint
pnpm format
```

## Load Extension

1. Run `pnpm build`
2. Chrome -> Extensions -> Enable Developer Mode
3. Load unpacked -> select `dist/`

## Pre-commit

```sh
pre-commit install
```
