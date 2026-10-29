// Run after `pnpm build`: the e2e test hook (src/sw/testHook.ts) must be in
// the e2e build (TABTIMER_E2E=1) and nowhere in the production build, and
// neither build may run in Incognito.
//   node scripts/check-build.ts
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { E2E, OUT_DIR } from '../build.e2e.ts'

const MARKER = '__tabtimerTest'

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? files(full) : [full]
  })
}

const hits = files(OUT_DIR).filter((file) => readFileSync(file).includes(MARKER))
if (E2E && hits.length === 0) {
  console.error(`${OUT_DIR}: the e2e build is missing its test hook (${MARKER}).`)
  process.exit(1)
}
if (!E2E && hits.length > 0) {
  console.error(`${OUT_DIR}: the production build contains the e2e test hook (${MARKER}):\n  ${hits.join('\n  ')}`)
  process.exit(1)
}
const manifest = JSON.parse(readFileSync(path.join(OUT_DIR, 'manifest.json'), 'utf8')) as { incognito?: string }
if (manifest.incognito !== 'not_allowed') {
  console.error(
    `${OUT_DIR}/manifest.json: "incognito" must be "not_allowed", not ${JSON.stringify(manifest.incognito)}.`
  )
  process.exit(1)
}
console.log(`${OUT_DIR}: test hook ${E2E ? 'present (e2e build)' : 'absent (production build)'}.`)
