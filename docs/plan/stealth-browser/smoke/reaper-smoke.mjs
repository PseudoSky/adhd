// reaper-smoke.mjs (sp-reaper-smoke, CL30): real-process gate for the BUILT core package.
// Spawns the detached reaper host through ensureBackend exactly as reaper-link.ts does, drives
// ping/hello/activity/status over the service-proxy transport, then waits for the host to retire
// on its own (orphanWindowMs = 1 s, Chrome never started) and checks the socket is removed.
// Safety: scratch stateDir via mkdtemp, a CLOSED CDP port picked at run time, no Chrome is
// started or killed, no browser profile is touched.
import { createRequire } from 'node:module'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = resolve(here, '../../../../packages/stealth/stealth-core-browser')
const entry = join(pkgDir, 'dist/index.js')
const req = createRequire(join(pkgDir, 'package.json'))

const REAPER_ENTRY_SCRIPT = 'require(process.argv[1]).lifecycle.runChromeReaper(JSON.parse(process.argv[2]))'
const result = { ensure: null, ping: false, hello: false, activity: false, status: false, entryLoaded: false, retired: false, socketRemoved: false }
let hostPid = null
let stateDir = null

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function closedPort() {
  return new Promise((ok, bad) => {
    const s = createServer()
    s.once('error', bad)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => ok(port))
    })
  })
}
function alive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function main() {
  const core = req(entry)
  result.entryLoaded = typeof core.lifecycle === 'object' && core.lifecycle !== null && typeof core.lifecycle.runChromeReaper === 'function'
  if (!result.entryLoaded) throw new Error('package entry does not expose lifecycle.runChromeReaper')

  const sp = req('@adhd/sox-service-proxy')
  const { ensureBackend, dialBackend, backendSocketPath } = sp
  let spDir = dirname(req.resolve('@adhd/sox-service-proxy'))
  while (!existsSync(join(spDir, 'package.json')) || JSON.parse(await readFile(join(spDir, 'package.json'), 'utf8')).name !== '@adhd/sox-service-proxy') spDir = dirname(spDir)
  const spVersion = JSON.parse(await readFile(join(spDir, 'package.json'), 'utf8')).version

  stateDir = await mkdtemp(join(tmpdir(), 'reaper-smoke-'))
  const port = await closedPort()
  const key = `stealth-browser-reaper:${port}`
  const socketPath = backendSocketPath(stateDir, key)
  const cfg = {
    port, stateDir, socketPath,
    idleTimeoutMs: 600000, shutdownGraceMs: 600000, orphanWindowMs: 1000,
    scope: undefined, checkHistoryDefault: false, tickMs: 500,
  }
  delete cfg.scope
  const res = await ensureBackend({
    socketPath, singletonKey: key, command: process.execPath,
    args: ['-e', REAPER_ENTRY_SCRIPT, entry, JSON.stringify(cfg)],
    lockDir: stateDir, stderrLogPath: join(stateDir, `reaper-${port}.log`),
    onDiagnostic: (m) => process.stderr.write(`[ensure] ${m}\n`),
  })
  result.ensure = res.disposition
  hostPid = res.pid ?? res.hostPid ?? null
  process.stderr.write(`ensure result: ${JSON.stringify(res)}\n`)
  if (res.disposition !== 'spawned') throw new Error(`ensureBackend: ${JSON.stringify(res)}`)

  const conn = dialBackend({ socketPath, backoff: { giveUpAfterMs: 3000 }, onDiagnostic: () => undefined })
  const send = (method, params) => conn.send({ jsonrpc: '2.0', id: `${method}-1`, method, ...(params ? { params } : {}) })
  const ping = await send('ping')
  result.ping = ping && !ping.error
  const hello = await send('hello', { pid: process.pid, checkHistory: false })
  result.hello = hello && !hello.error
  conn.notify({ jsonrpc: '2.0', method: 'activity' })
  result.activity = true
  const status = await send('status')
  result.status = !!status && !status.error && status.result !== undefined
  conn.close()

  const deadline = Date.now() + 15000
  while (Date.now() < deadline && existsSync(socketPath)) await sleep(200)
  result.socketRemoved = !existsSync(socketPath)
  result.retired = result.socketRemoved && (hostPid === null || !alive(hostPid) || await waitDead(hostPid))
  result.spVersion = spVersion
  const sha = createHash('sha256').update(await readFile(entry)).digest('hex')
  result.distSha256 = sha
}

async function waitDead(pid) {
  const end = Date.now() + 5000
  while (Date.now() < end) { if (!alive(pid)) return true; await sleep(100) }
  return false
}

let code = 0
try {
  await main()
  const need = ['ping', 'hello', 'activity', 'status', 'entryLoaded', 'retired', 'socketRemoved']
  if (result.ensure !== 'spawned' || need.some((k) => result[k] !== true)) code = 1
} catch (e) {
  process.stderr.write(`FAIL: ${e?.stack ?? e}\n`)
  code = 1
}
if (code !== 0 && hostPid && alive(hostPid)) {
  try { process.kill(hostPid, 'SIGKILL') } catch { /* gone */ }
}
if (stateDir) await rm(stateDir, { recursive: true, force: true }).catch(() => undefined)
console.log(JSON.stringify(result))
process.exit(code)
