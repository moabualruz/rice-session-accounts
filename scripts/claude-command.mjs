// Finds the Claude Code executable the terminal setup helper starts.
//
// On Windows, Node starts only .com and .exe files without a shell, and since
// CVE-2024-27980 it refuses .cmd and .bat files without one. An npm install
// of Claude Code is a claude.cmd shim, so a plain spawn of "claude" reports a
// missing command although Claude Code is installed. This module searches
// PATH x PATHEXT itself (never the current directory), maps an npm shim to the
// executable or script it launches, and only as a last resort runs the shim
// through cmd.exe with a fixed command line whose values travel in
// environment variables, never interpolated into the command text.
import { readFileSync, statSync } from 'node:fs'
import { win32 } from 'node:path'

/** An absolute path to the Claude Code executable, overriding the PATH search. */
export const CLAUDE_OVERRIDE = 'RICE_ACCOUNTS_CLAUDE'
/** Environment variables that carry the shim path and arguments through cmd.exe. */
export const CMD_SHIM_VARIABLE = 'RICE_ACCOUNTS_CLAUDE_SHIM'
export const CMD_ARGUMENT_PREFIX = 'RICE_ACCOUNTS_CLAUDE_ARG'

const RUNNABLE = ['.com', '.exe', '.bat', '.cmd']
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'
const SHIM_REFERENCE = /"(%dp0%|%~dp0)([^"]*)"/gi
const PACKAGE_TARGET = /[\\/]node_modules[\\/]@anthropic-ai[\\/]claude-code[\\/](?:bin[\\/]claude\.exe|cli\.m?js)$/i
const UNSAFE_FOR_CMD = /["\u0000-\u001f\u007f]/

export class ClaudeCommandError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ClaudeCommandError'
  }
}

/** An environment variable by name; Windows names are case-insensitive. */
export function environmentValue(env, name, platform) {
  if (platform !== 'win32') return env[name]
  const wanted = name.toLowerCase()
  for (const key of Object.keys(env)) if (key.toLowerCase() === wanted && env[key] !== undefined) return env[key]
  return undefined
}

function windowsAbsolute(value) {
  return typeof value === 'string' && /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(value) && !/[\0\r\n]/.test(value)
}

/** Absolute PATH entries, unquoted; relative entries such as "." are skipped so the current folder never supplies Claude. */
export function windowsPathEntries(env) {
  const raw = environmentValue(env, 'PATH', 'win32') ?? ''
  return raw.split(';').map(entry => entry.trim().replace(/^"(.*)"$/, '$1')).filter(windowsAbsolute)
}

/** PATHEXT limited to the extensions Windows itself can start (.com, .exe, .bat, .cmd), in PATHEXT order. */
export function windowsExtensions(env) {
  const listed = (environmentValue(env, 'PATHEXT', 'win32') || DEFAULT_PATHEXT).split(';').map(each => each.trim().toLowerCase())
  const usable = listed.filter((each, index) => RUNNABLE.includes(each) && listed.indexOf(each) === index)
  return usable.length > 0 ? usable : DEFAULT_PATHEXT.toLowerCase().split(';')
}

function nativeIsFile(path) {
  try { return statSync(path).isFile() } catch { return false }
}

function nativeRead(path) {
  return readFileSync(path, 'utf8')
}

/**
 * The executable or script an npm-style .cmd shim launches for Claude Code:
 * a package claude.exe, or cli.js run with Node. Undefined when the shim
 * names neither.
 */
export function shimTarget(shim, text, isFile = nativeIsFile) {
  const directory = win32.dirname(shim)
  for (const match of String(text).matchAll(SHIM_REFERENCE)) {
    const relative = match[2].replace(/^[\\/]+/, '')
    if (!relative || relative.includes('%')) continue
    const target = win32.resolve(directory, relative)
    if (PACKAGE_TARGET.test(target) && isFile(target)) return target
  }
  return undefined
}

function windowsCommandShell(env) {
  const root = environmentValue(env, 'SystemRoot', 'win32') || environmentValue(env, 'WINDIR', 'win32')
  return windowsAbsolute(root) ? win32.join(root, 'System32', 'cmd.exe') : 'cmd.exe'
}

/** How to start a found Windows file: directly, through Node for cli.js, or through cmd.exe for an unknown shim. */
function windowsLaunch(file, env, options) {
  const extension = win32.extname(file).toLowerCase()
  if (extension !== '.cmd' && extension !== '.bat') return { kind: 'direct', file }
  let text = ''
  try { text = options.read(file) } catch { text = '' }
  const target = shimTarget(file, text, options.isFile)
  if (target && /\.exe$/i.test(target)) return { kind: 'direct', file: target, shim: file }
  if (target) {
    // The shim itself prefers a node.exe next to it, then Node on PATH; this helper already runs on Node 22+.
    const bundled = win32.join(win32.dirname(file), 'node.exe')
    return { kind: 'node', file: options.isFile(bundled) ? bundled : options.execPath, script: target, shim: file }
  }
  return { kind: 'cmd', file: windowsCommandShell(env), shim: file }
}

/**
 * Where Claude Code is: { kind: 'direct', file } for an executable,
 * { kind: 'node', file, script } for an npm cli.js, { kind: 'cmd', file, shim }
 * for a shim that can only run through cmd.exe, or { kind: 'missing' }.
 * Outside Windows the name "claude" is left to the normal PATH search.
 */
export function resolveClaude({ platform, env, isFile = nativeIsFile, read = nativeRead, execPath = process.execPath }) {
  const options = { isFile, read, execPath }
  const override = environmentValue(env, CLAUDE_OVERRIDE, platform)
  if (override) {
    const absolute = platform === 'win32' ? windowsAbsolute(override) : override.startsWith('/') && !/[\0\r\n]/.test(override)
    if (!absolute || !isFile(override)) {
      throw new ClaudeCommandError(`${CLAUDE_OVERRIDE} must be the absolute path of the Claude Code executable, and ${JSON.stringify(override)} is not an existing file. Fix or unset it, then rerun this setup command.`)
    }
    return platform === 'win32' ? { ...windowsLaunch(override, env, options), override: true } : { kind: 'direct', file: override, override: true }
  }
  if (platform !== 'win32') return { kind: 'direct', file: 'claude' }
  const extensions = windowsExtensions(env)
  for (const directory of windowsPathEntries(env)) {
    for (const extension of extensions) {
      const candidate = win32.join(directory, `claude${extension}`)
      if (isFile(candidate)) return windowsLaunch(candidate, env, options)
    }
  }
  return { kind: 'missing', searched: extensions.map(extension => `claude${extension}`) }
}

/** The message for a Claude Code executable that cannot be found. */
export function missingClaudeMessage(platform) {
  return platform === 'win32'
    ? `Claude Code was not found on PATH (looked for claude.exe and claude.cmd). Install Claude Code, open a new terminal so PATH is current, or set ${CLAUDE_OVERRIDE} to the full path of claude.exe, then rerun this setup command.`
    : `Required command is missing: claude. Install Claude Code, or set ${CLAUDE_OVERRIDE} to its absolute path, then rerun this setup command.`
}

/**
 * The process to start for `claude <args>`: { file, args, env, windowsVerbatimArguments }.
 * For the cmd.exe fallback the command line is fixed text; the shim path and
 * every argument are read by cmd.exe from environment variables, each inside
 * double quotes, and a value cmd.exe could misread is refused.
 */
export function claudeInvocation(resolved, args, env) {
  if (resolved.kind === 'direct') return { file: resolved.file, args: [...args], env }
  if (resolved.kind === 'node') return { file: resolved.file, args: [resolved.script, ...args], env }
  if (resolved.kind !== 'cmd') throw new ClaudeCommandError('Claude Code was not found.')
  const values = [resolved.shim, ...args]
  for (const value of values) {
    if (typeof value !== 'string' || value === '' || UNSAFE_FOR_CMD.test(value)) {
      throw new ClaudeCommandError(`An argument for ${win32.basename(resolved.shim)} contains a double quote or control character, or is empty, so it cannot pass through cmd.exe safely. Set ${CLAUDE_OVERRIDE} to the full path of claude.exe, then rerun this setup command.`)
    }
  }
  const variables = { [CMD_SHIM_VARIABLE]: resolved.shim }
  args.forEach((value, index) => { variables[`${CMD_ARGUMENT_PREFIX}${index}`] = value })
  const line = [`"%${CMD_SHIM_VARIABLE}%"`, ...args.map((_, index) => `"%${CMD_ARGUMENT_PREFIX}${index}%"`)].join(' ')
  const clean = {}
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase()
    if (upper !== CMD_SHIM_VARIABLE && !upper.startsWith(CMD_ARGUMENT_PREFIX)) clean[key] = value
  }
  return { file: resolved.file, args: ['/d', '/v:off', '/s', '/c', `"${line}"`], env: { ...clean, ...variables }, windowsVerbatimArguments: true }
}
