// Slow lookups (gh, Jira): callers asking at once share one fetch, and a
// kept answer is shown at once while a fresh one comes in behind it.
import { once, Swr } from '../src/main/exec/swr'

let failed = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (${detail})`}`)
  if (!ok) failed++
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  let calls = 0
  const slow = async (): Promise<number> => {
    calls++
    await sleep(30)
    return calls
  }
  const [a, b] = await Promise.all([once('k', slow), once('k', slow)])
  check('two asks at once share one fetch', calls === 1 && a === 1 && b === 1, `calls ${calls}`)
  await once('k', slow)
  check('an ask after it finished fetches again', calls === 2, `calls ${calls}`)

  calls = 0
  const swr = new Swr<number>('t', 20, 1000)
  const first = await swr.get('x', slow)
  const fresh = await swr.get('x', slow)
  check(
    'a fresh answer is used without fetching',
    first === 1 && fresh === 1 && calls === 1,
    `calls ${calls}`
  )
  await sleep(40)
  let refreshed: number | null = null
  const stale = await swr.get('x', slow, (v) => (refreshed = v))
  check('an old answer comes back at once', stale === 1, `got ${stale}`)
  await sleep(60)
  check(
    '…and a new one is fetched behind it',
    refreshed === 2 && calls === 2,
    `refreshed ${refreshed}`
  )
  check('the next ask gets the new one', (await swr.get('x', slow)) === 2)

  const gone = new Swr<number>('t2', 10, 30)
  await gone.get('y', slow)
  await sleep(50)
  const before = calls
  const tooOld = await gone.get('y', slow)
  check('an answer too old to show waits for a new one', tooOld === before + 1, `got ${tooOld}`)

  if (failed) {
    console.log(`${failed} failed`)
    process.exit(1)
  }
}

void main()
