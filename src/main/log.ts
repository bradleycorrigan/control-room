import { app } from 'electron'
import { appendFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

type LogLevel = 'info' | 'warn' | 'error'

// Drops anything shaped like a secret before it can ever reach disk or console.
const REDACT_KEY = /authtoken|token|key|secret/i

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEY.test(k) ? '[redacted]' : redact(v)
    }
    return out
  }
  return value
}

let logDirReady: Promise<string> | null = null

function getLogDir(): Promise<string> {
  if (!logDirReady) {
    const dir = join(app.getPath('userData'), 'logs')
    logDirReady = (existsSync(dir) ? Promise.resolve() : mkdir(dir, { recursive: true })).then(
      () => dir
    )
  }
  return logDirReady
}

function write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  const safeMeta = meta ? (redact(meta) as Record<string, unknown>) : undefined
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(safeMeta ? { meta: safeMeta } : {})
  }
  const line = JSON.stringify(entry)

  const consoleFn =
    level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  consoleFn(line)

  getLogDir()
    .then((dir) => appendFile(join(dir, 'main.log'), line + '\n'))
    .catch((err) => console.error('log: failed to write main.log', err))
}

export const log = {
  info: (message: string, meta?: Record<string, unknown>): void => write('info', message, meta),
  warn: (message: string, meta?: Record<string, unknown>): void => write('warn', message, meta),
  error: (message: string, meta?: Record<string, unknown>): void => write('error', message, meta)
}
