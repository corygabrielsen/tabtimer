# Contributing

Thanks for your interest in Tab Timer.

## Setup

```sh
pnpm install          # Node >= 20 (see .nvmrc)
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
