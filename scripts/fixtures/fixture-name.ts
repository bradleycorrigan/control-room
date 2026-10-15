// The tmux session that holds the fixture's panes. Each checkout gets its own,
// named "cr-fixture-" plus 8 hex chars of the SHA-1 of its absolute path, so two
// worktrees can each build and run the fixture without sharing a session.
//
// The page-check shards (gate.mjs) build more fixtures under the same checkout,
// each at its own root (CR_FIXTURE_ROOT). A root other than the default gets its
// own session too: the hash then covers the root as well as the checkout.
//
// gate.mjs repeats this function (it is plain JS and cannot import TypeScript).
// If you change the format here, change it there too.
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// This file sits in scripts/fixtures/, so the repo root is two levels up.
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export function defaultFixtureRoot(repoRoot: string = REPO_ROOT): string {
  return join(repoRoot, '.dev', 'fixture')
}

export function fixtureTmuxName(
  repoRoot: string = REPO_ROOT,
  fixtureRoot: string = defaultFixtureRoot(repoRoot)
): string {
  const key =
    fixtureRoot === defaultFixtureRoot(repoRoot) ? repoRoot : `${repoRoot}\n${fixtureRoot}`
  return `cr-fixture-${createHash('sha1').update(key).digest('hex').slice(0, 8)}`
}
