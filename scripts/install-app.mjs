#!/usr/bin/env node
// One command to update the installed app: build it, quit the running copy,
// swap it into /Applications and open it again.
//
// Usage: npm run install-app
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const built = join(root, 'release', 'mac-arm64', 'Control Room.app')
const installed = '/Applications/Control Room.app'

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function step(label, cmd, args) {
  console.log(`install-app: ${label}...`)
  const res = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' })
  if (res.status !== 0) {
    console.error(`install-app: ${label} failed (exit ${res.status})`)
    process.exit(1)
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const running = () =>
  spawnSync('pgrep', ['-f', `${installed}/Contents/MacOS/Control Room`]).status === 0

step('build', 'npm', ['run', 'build:unpack'])
if (!existsSync(built)) {
  console.error(`install-app: no build at ${built}`)
  process.exit(1)
}

if (running()) {
  console.log('install-app: quitting Control Room...')
  spawnSync('osascript', ['-e', 'quit app "Control Room"'])
  // Up to 10s to close cleanly — never swap the app out from under a live copy.
  for (let i = 0; i < 40 && running(); i++) {
    spawnSync('sleep', ['0.25'])
  }
  if (running()) {
    console.error('install-app: Control Room is still running — quit it and run this again')
    process.exit(1)
  }
}

console.log('install-app: replacing /Applications/Control Room.app...')
rmSync(installed, { recursive: true, force: true })
// ditto, not a plain copy: it keeps the bundle's symlinks, permissions and
// extended attributes exactly, which a .app needs to launch.
step('copy', 'ditto', [built, installed])

step('open', 'open', [installed])
console.log('install-app: done')
