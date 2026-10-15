import { execFileSync, spawnSync } from 'node:child_process'
import { join } from 'node:path'

/**
 * Re-sign the packaged app under its own bundle identifier.
 *
 * `identity: null` tells electron-builder to skip signing, which leaves the
 * prebuilt Electron binary's own ad-hoc signature in place — and that signature
 * is identified as "Electron", not as us. macOS keys notification permission off
 * the *signing identifier*, so every banner the app posted was silently dropped:
 * `Notification.show()` succeeded, "notify: banner shown" appeared in the log,
 * and nothing ever reached the screen.
 *
 * Ad-hoc signing (`--sign -`) is all arm64 needs to run. What matters here is
 * `--identifier`, which makes the signature say who the app actually is.
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const identifier = context.packager.appInfo.id

  execFileSync(
    'codesign',
    ['--force', '--deep', '--sign', '-', '--identifier', identifier, appPath],
    {
      stdio: 'inherit'
    }
  )

  // `codesign -dv` prints its report to stderr, not stdout. Reading only
  // stdout got an empty string and failed every build on an app that had in
  // fact been signed correctly — so read both streams.
  const check = spawnSync('codesign', ['-dv', appPath], { encoding: 'utf8' })
  const out = `${check.stdout ?? ''}${check.stderr ?? ''}`
  console.log(`  • re-signed as ${identifier}`)
  if (!out.includes(`Identifier=${identifier}`)) {
    throw new Error(
      `codesign identifier did not stick: expected ${identifier}, codesign said:\n${out.trim()}`
    )
  }
}
