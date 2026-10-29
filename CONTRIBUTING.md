# Contributing

Thanks for your interest in Tab Timer.

## Setup

Requires pnpm 12 (pinned via `packageManager` in `package.json`). Node 25+
no longer bundles Corepack, so install pnpm with npm:

```sh
npm i -g pnpm@12      # once
pnpm install          # Node >= 24 (see .nvmrc)
pnpm dev              # Vite dev server
pnpm build            # production build to dist/
pnpm package          # build + zip the store artifact
```

## Before you push

CI runs these on every push and pull request; run them locally first:

```sh
pnpm typecheck
pnpm lint
pnpm format:check     # or `pnpm format` to fix
pnpm test
pnpm build
```

Optionally install the git hooks so they run on commit:

```sh
pre-commit install
```

## Conventions

- TypeScript, strict mode; Prettier-formatted (no semicolons, single quotes).
- Keep commit subjects in the imperative mood and ≤ 50 characters.
- Add or update unit tests (`vitest`) for logic changes to `Timer`/`storage`.
- The tracked-site list lives in `manifest.json` `host_permissions` (the
  content script's `matches` is derived from it at build time).
