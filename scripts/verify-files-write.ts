// Verifies files:write's path-restriction non-negotiable (CLAUDE.md: "files:write
// resolves the real path and refuses anything outside a registered project")
// against the REAL exec/files.ts module — not a reimplementation. Per CLAUDE.md's
// verification rule ("a check runs against the real app, or it is reported
// unrunnable... never render a component standalone to verify it"), this is the
// seeded fixture for a check the real Electron app has no UI-driven way to
// assert deterministically (a correctly-rejected write leaves no on-disk trace
// to diff): a disposable git repo standing in for a "registered project", built
// once here for whoever verifies U7's Git/Files tabs next.
//
// Run: npm run verify:files-write

import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  symlinkSync,
  readFileSync,
  existsSync,
  realpathSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  resolveProjectPath,
  isWithinRoots,
  writeProjectFile,
  readProjectFile
} from '../src/main/exec/files'

let failures = 0

function check(name: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok — ${name}`)
  } else {
    console.error(`  FAIL — ${name}`)
    failures++
  }
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'cr-files-write-fixture-'))
  const repoPath = join(root, 'project.git-checkout')
  const worktreeRoot = `${repoPath}.worktrees`
  const outsideDir = join(root, 'outside-any-project')
  mkdirSync(repoPath, { recursive: true })
  mkdirSync(worktreeRoot, { recursive: true })
  mkdirSync(outsideDir, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: repoPath })

  // realpathSync, not the raw temp path — macOS's tmpdir() sits under a
  // symlink (/var -> /private/var), and the resolver correctly follows it,
  // same as it must for a symlink planted deliberately (below).
  const repoPathReal = realpathSync(repoPath)

  // ipc.ts's actual usage pattern (see resolveFilesRoot) always narrows to a
  // SINGLE validated root — the project's repoPath, or one specific
  // worktreePath already checked with isWithinRoots — before resolving any
  // relPath against it. `roots` here matches that: one root per call, not
  // "try repoPath, then fall back to worktreeRoot" (a relPath that doesn't
  // exist under repoPath is not an escape attempt just because it would also
  // be a syntactically valid *new* path under the unrelated worktreeRoot).
  const roots = [repoPath]

  console.log('Fixture: ' + root)
  console.log('\nresolveProjectPath — the choke point behind files:read/files:write:')

  // 1. A normal relative path inside the project resolves.
  check(
    'accepts a plain relative path inside the project',
    resolveProjectPath(roots, 'src/index.ts') === join(repoPathReal, 'src/index.ts')
  )

  // 2. Traversal out of the project is refused.
  check(
    'rejects ../../etc/passwd traversal out of the project',
    resolveProjectPath(roots, '../../etc/passwd') === null
  )
  check(
    'rejects traversal that stays under root/.. but exits the tree',
    resolveProjectPath(roots, '../outside-any-project/x') === null
  )

  // 3. An absolute path is refused outright, even one that happens to sit
  //    inside a registered project — CLAUDE.md: the renderer only ever sends
  //    relative paths, so an absolute one is never legitimate.
  check(
    'rejects an absolute path outside any project',
    resolveProjectPath(roots, join(outsideDir, 'passwd')) === null
  )
  check(
    'rejects an absolute path, even one that points inside the project',
    resolveProjectPath(roots, join(repoPath, 'src/index.ts')) === null
  )

  // 4. A symlink inside the project pointing outside it is refused, for a
  //    path that already exists...
  const linkTarget = join(outsideDir, 'secret.txt')
  execFileSync('bash', ['-c', `echo secret > ${JSON.stringify(linkTarget)}`])
  const linkPath = join(repoPath, 'escape-link')
  symlinkSync(outsideDir, linkPath)
  check(
    'rejects a symlink inside the project that points outside it (existing file)',
    resolveProjectPath(roots, 'escape-link/secret.txt') === null
  )
  // ...and for a new file written through that same symlink.
  check(
    'rejects a NEW file written through a symlink that points outside the project',
    resolveProjectPath(roots, 'escape-link/new-file.txt') === null
  )

  console.log('\nwriteProjectFile / readProjectFile — the IPC-facing functions:')

  // 5. A real write inside the project succeeds and is readable back.
  const writeResult = await writeProjectFile(roots, 'notes/todo.md', '- ship U7\n')
  check('accepts a write inside the project', writeResult.ok === true)
  check(
    'the file actually landed on disk at the expected path',
    existsSync(join(repoPath, 'notes/todo.md')) &&
      readFileSync(join(repoPath, 'notes/todo.md'), 'utf8') === '- ship U7\n'
  )
  const readBack = await readProjectFile(roots, 'notes/todo.md')
  check('reads back what was written', readBack.ok === true && readBack.content === '- ship U7\n')

  // 6. The actual attack the ticket names: a relative "../../etc/passwd".
  const attempt1 = await writeProjectFile(roots, '../../etc/passwd', 'pwned')
  check('writeProjectFile refuses "../../etc/passwd"', attempt1.ok === false)
  check(
    '"../../etc/passwd" was not created anywhere near the fixture',
    !existsSync(join(root, '..', 'etc', 'passwd'))
  )

  // 7. An absolute path outside any project.
  const attempt2 = await writeProjectFile(roots, join(outsideDir, 'pwned.txt'), 'pwned')
  check('writeProjectFile refuses an absolute path outside any project', attempt2.ok === false)
  check('nothing was written to that absolute path', !existsSync(join(outsideDir, 'pwned.txt')))

  // 8. isWithinRoots — the guard that turns a session's worktreePath into a
  //    validated root before any relPath is resolved against it. This one
  //    legitimately checks against both of a project's roots at once, since
  //    a worktreePath the renderer echoes back may be either.
  console.log('\nisWithinRoots — validates a worktreePath before it becomes a files/git root:')
  const bothRoots = [repoPath, worktreeRoot]
  const someWorktree = join(worktreeRoot, 'some-branch')
  mkdirSync(someWorktree) // a real worktreePath always exists on disk already
  check('accepts the project repoPath itself', isWithinRoots(bothRoots, repoPath) === repoPathReal)
  check(
    'accepts a real worktree path under worktreeRoot',
    isWithinRoots(bothRoots, someWorktree) === realpathSync(someWorktree)
  )
  check(
    'rejects a worktreePath outside the project entirely',
    isWithinRoots(bothRoots, outsideDir) === null
  )

  rmSync(root, { recursive: true, force: true })

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
