/**
 * Children keep native behavior: Bash and `$.process.*` children inherit the
 * session's `ANTHROPIC_CUSTOM_HEADERS` (the selected bearer) the way Claude
 * passes its environment on, and no command text or child environment is
 * rewritten. The one thing added here is a lockout: while the session account
 * is unconfirmed, a child `claude` is refused so it cannot start on an account
 * nobody confirmed.
 */

const CLAUDE_PROGRAMS = new Set(['claude', 'claude.exe', 'claude.cmd'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'sh.exe', 'bash.exe', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'])
/** Programs that run the command after their own options, assignments or a duration. */
const WRAPPERS = new Set(['env', 'exec', 'command', 'builtin', 'nohup', 'time', 'sudo', 'doas', 'nice', 'timeout', 'xargs', 'stdbuf', 'setsid', 'caffeinate', 'npx', 'bunx', 'pnpx'])
/** Wrapper options whose value is the next word, so that word is not the command. */
const OPTION_VALUES = new Set(['-u', '-g', '-C', '-S', '-n', '-s', '-k', '-P', '-I', '-L', '--user', '--group', '--chdir', '--signal', '--kill-after', '--package'])

export const GUARD_FAILED = 'Rice Accounts could not confirm the session account before starting claude, so it was not started. Run /rice-account login or select a saved account again, then retry.'

function word(text: string): string {
  return text.replace(/^\\/, '').replace(/["']/g, '')
}

function basename(text: string): string {
  return (word(text).split(/[\\/]/).pop() ?? '').toLowerCase()
}

function isClaude(text: string): boolean {
  return CLAUDE_PROGRAMS.has(basename(text))
}

/** The index of the command a wrapper at `index` runs: past its options, their values, assignments and a duration. */
function afterWrappers(words: readonly string[], start: number): number {
  let index = start
  while (index < words.length) {
    const current = word(words[index] ?? '')
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(current)) { index += 1; continue }
    if (!WRAPPERS.has(basename(current))) return index
    index += 1
    while (index < words.length) {
      const option = word(words[index] ?? '')
      if (option === '--') { index += 1; break }
      // `sudo -n claude` and `nice -n 5 claude` differ only by meaning: a claude value is taken as the command.
      if (OPTION_VALUES.has(option)) {
        if (isClaude(words[index + 1] ?? '')) return index + 1
        index += 2
        continue
      }
      if (option.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(option) || /^\d+(?:\.\d+)?[smhd]?$/.test(option)) { index += 1; continue }
      break
    }
  }
  return index
}

/**
 * Whether a shell command line runs `claude` as a command word: in any list,
 * pipeline, group or substitution, after assignments and wrapper programs.
 * Words inside quotes that hold separators may be over-matched; a refusal
 * then names the lockout rather than starting an unconfirmed account.
 */
export function commandInvokesClaude(command: string): boolean {
  for (const segment of command.split(/\|\||&&|\$\(|[;&|\n\r(){}`]/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean)
    const index = afterWrappers(words, 0)
    const program = words[index]
    if (program !== undefined && isClaude(program)) return true
  }
  return false
}

/** Whether an argument vector starts `claude`, directly, through a wrapper, or as a shell's `-c` command. */
export function argvInvokesClaude(argv: readonly string[]): boolean {
  const index = afterWrappers(argv, 0)
  const program = argv[index]
  if (program === undefined) return false
  if (isClaude(program)) return true
  if (!SHELLS.has(basename(program))) return false
  for (let at = index + 1; at < argv.length; at += 1) {
    const option = argv[at] ?? ''
    // cmd /c and PowerShell -Command run the rest of the line; a POSIX -c runs
    // its next argument, the ones after it being positional parameters.
    if (/^\/c$/i.test(option) || /^-command$/i.test(option)) return commandInvokesClaude(argv.slice(at + 1).join(' '))
    if (/^-[A-Za-z]*c$/.test(option)) return commandInvokesClaude(argv[at + 1] ?? '')
  }
  return false
}
