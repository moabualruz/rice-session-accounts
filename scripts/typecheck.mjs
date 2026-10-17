// Type-checks hooks, types and tests against the declarations of the installed
// Claude Code build. The declarations are not part of this repository: the
// official build's own authoring skill names the file, so this script loads that
// skill in a throwaway session (no account, no inference) and reads the path.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const native = process.env.RICE_ACCOUNTS_PROOF_CLAUDE || process.env.RICE_CLAUDE_EXECUTABLE || 'claude'
const TYPESCRIPT = 'typescript@6.0.3'
const fixture = mkdtempSync(join(tmpdir(), 'rice-accounts-types-'))
const config = join(fixture, '.claude'), promptFile = join(fixture, 'authoring.txt')
let child, inferenceRequests = 0
// Any model request would reach this server; the check below proves there was none.
const server = createServer((request, response) => {
  if (request.method === 'POST') inferenceRequests++
  request.resume()
  response.writeHead(429, { 'content-type': 'application/json', 'x-should-retry': 'false' })
  response.end('{"error":{"type":"rate_limit_error","message":"Owned inference sentinel"}}')
})

function terminate() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10_000 })
  else try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
}

const SOURCES = {
  observer: "export const register=on=>{on('skill.prompt',async($,e,next)=>{const result=await next(e);if(e.skill==='plugin-authoring'||result.text.includes('WHERE THE TYPES ARE'))await $.fs.write(" + JSON.stringify(promptFile) + ",result.text);return result;});};",
  driver: "export const register=on=>{on('turn.step',async function*($,e){const result=await $.tool.call({tool:'Skill',skill:'plugin-authoring'});const answer=result.isError||result.deny?'TYPES_FAILED':'TYPES_READY';yield{kind:'text',index:0,text:answer};yield{kind:'stop',stopReason:'end_turn',usage:null};return{turnId:e.turnId,index:e.index,answer,toolUses:[],stopReason:'end_turn',usage:null};});};",
}

try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  mkdirSync(config)
  writeFileSync(join(config, 'settings.json'), '{}')
  writeFileSync(join(fixture, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }))
  const env = Object.fromEntries(['PATH', 'PATHEXT', 'TMPDIR', 'LANG', 'SystemRoot', 'SystemDrive', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'ProgramFiles', 'ProgramFiles(x86)', 'CLAUDE_CODE_GIT_BASH_PATH'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  Object.assign(env, { HOME: fixture, USERPROFILE: fixture, CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: 'fixture-no-account', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })
  const plugins = []
  for (const [name, source] of Object.entries(SOURCES)) {
    const folder = join(fixture, name)
    plugins.push(folder)
    mkdirSync(join(folder, '.claude-plugin'), { recursive: true })
    mkdirSync(join(folder, 'hooks'))
    writeFileSync(join(folder, '.claude-plugin/plugin.json'), JSON.stringify({ name: `types-${name}`, version: '1.0.0', description: 'Fetches the authoring declarations', author: { name: 'fixture' } }))
    writeFileSync(join(folder, 'hooks/hooks.json'), JSON.stringify({ modules: ['./register.js'] }))
    writeFileSync(join(folder, 'hooks/register.js'), source)
  }
  child = spawn(native, ['-p', ...plugins.flatMap(folder => ['--plugin-dir', folder]), '--setting-sources', 'user', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', 'Skill', '--allowedTools', 'Skill', '--no-session-persistence', '--output-format', 'json', '--', 'Load the installed authoring declarations.'], { cwd: fixture, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = '', timedOut = false
  child.stdout.on('data', bytes => { stdout += bytes })
  child.stderr.on('data', bytes => { stderr += bytes })
  const timer = setTimeout(() => { timedOut = true; terminate() }, 60_000)
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  clearTimeout(timer)
  assert.equal(timedOut, false, 'loading the authoring declarations finished in time')
  assert.equal(code, 0, (stdout + stderr).slice(-2000))
  assert.equal(JSON.parse(stdout).result, 'TYPES_READY')
  assert.equal(inferenceRequests, 0, 'loading the authoring skill makes no model request')
  const prompt = readFileSync(promptFile, 'utf8')
  const declarationPath = [...prompt.matchAll(/`([^`\r\n]*[/\\]plugin-authoring[/\\]types[/\\]claude-code\.d\.ts)`/g)][0]?.[1]
  assert.ok(declarationPath, 'the authoring skill names its declaration file')
  const declarations = readFileSync(declarationPath)
  const copied = join(fixture, 'claude-code.d.ts')
  writeFileSync(copied, declarations)
  const tsconfig = join(fixture, 'tsconfig.json')
  writeFileSync(tsconfig, JSON.stringify({
    compilerOptions: { target: 'es2023', lib: ['es2023'], module: 'esnext', moduleResolution: 'bundler', strict: true, noUncheckedIndexedAccess: true, noEmit: true, skipLibCheck: true, jsx: 'react', jsxFactory: 'h', jsxFragmentFactory: 'Fragment', types: [] },
    files: [copied],
    include: [join(root, 'hooks'), join(root, 'types'), join(root, 'tests')],
  }))
  const windows = process.platform === 'win32'
  const checked = spawnSync(windows ? 'npm.cmd' : 'npm', ['exec', '--yes', `--package=${TYPESCRIPT}`, '--', 'tsc', '-p', tsconfig], { cwd: root, encoding: 'utf8', timeout: 180_000, shell: windows })
  if (checked.stdout) process.stdout.write(checked.stdout)
  if (checked.stderr) process.stderr.write(checked.stderr)
  assert.equal(checked.status, 0, 'hooks, types and tests type-check against the installed Claude Code declarations')
  console.log(JSON.stringify({ typecheck: true, typescript: TYPESCRIPT, declarationSha256: createHash('sha256').update(declarations).digest('hex') }))
} finally {
  terminate()
  await new Promise(resolve => server.close(resolve))
  rmSync(fixture, { recursive: true, force: true })
}
