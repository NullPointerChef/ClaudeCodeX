import { appendFileSync, writeFileSync } from 'node:fs'

const LOG_PATH = '/tmp/myclaw-debug.log'

export function debugLog(...args: unknown[]): void {
  const ts = new Date().toISOString().slice(11, 23)
  const line = `[${ts}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`
  try {
    appendFileSync(LOG_PATH, line)
  } catch {
    // ignore
  }
}

// 始终写一行启动标记，方便确认模块是否加载
try {
  writeFileSync(LOG_PATH, `=== myclaw debug started at ${new Date().toISOString()} ===\n`)
} catch {
  // ignore
}
