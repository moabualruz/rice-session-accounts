/**
 * Children keep native behavior: Bash and `$.process.*` children inherit the
 * session's `ANTHROPIC_CUSTOM_HEADERS` (the selected bearer) the way Claude
 * passes its environment on, and no command text or child environment is
 * rewritten. The one thing added here is a lockout: while the session account
 * is unconfirmed, a child `claude` is refused so it cannot start on an account
 * nobody confirmed.
 */

const CLAUDE_PROGRAMS = new Set(['claude', 'claude.exe', 'claude.cmd', 'claude.ps1', 'claude-code', 'claude-code.exe', 'claude-code.cmd'])
/** Claude Code's own versioned binaries, which have a version number for a name. */
const VERSIONED_CLAUDE = /(?:^|[\\/])claude[\\/]versions[\\/][^\\/]+$/i
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'sh.exe', 'bash.exe', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'])
/** Programs that run the command after their own options, assignments or a duration. */
const WRAPPERS = new Set(['env', 'exec', 'command', 'builtin', 'nohup', 'time', 'sudo', 'doas', 'nice', 'timeout', 'xargs', 'stdbuf', 'setsid', 'caffeinate', 'npx', 'bunx', 'pnpx', 'call'])
/** Shell keywords after which a command word follows. */
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', 'time', 'function', 'coproc'])
/** Wrapper options whose value is the next word, so that word is not the command. */
const OPTION_VALUES = new Set(['-u', '-g', '-C', '-S', '-n', '-s', '-k', '-P', '-I', '-L', '-a', '--user', '--group', '--chdir', '--signal', '--kill-after', '--package'])

export const GUARD_FAILED = 'Rice Accounts could not confirm the session account before starting claude, so it was not started. Run /rice-account login or select a saved account again, then retry.'

/** One shell word without its quotes and escapes: "c\laude" and 'claude' both read as claude. */
function word(text: string): string {
  return text.replace(/\\(.)/g, '$1').replace(/["']/g, '')
}

function basename(text: string): string {
  return (word(text).split(/[\\/]/).pop() ?? '').toLowerCase()
}

/** A Windows path keeps its backslashes, and a POSIX word may escape a letter with one (c\laude): either reading counts. */
function isClaude(text: string): boolean {
  const plain = word(text)
  const asPath = (text.replace(/["']/g, '').split(/[\\/]/).pop() ?? '').toLowerCase()
  return CLAUDE_PROGRAMS.has(basename(plain)) || CLAUDE_PROGRAMS.has(asPath) || VERSIONED_CLAUDE.test(plain)
}

/**
 * Splits a command line into command segments and their words, honoring
 * quotes and backslash escapes: separators and spaces inside quotes belong to a
 * word. Words keep their quotes for `word` to remove.
 */
function segments(command: string): string[][] {
  const out: string[][] = []
  let words: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  const endWord = () => { if (current !== '') words.push(current); current = '' }
  const endSegment = () => { endWord(); if (words.length > 0) out.push(words); words = [] }
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!
    if (quote) {
      current += char
      if (char === '\\' && quote === '"' && i + 1 < command.length) { i += 1; current += command[i]! }
      else if (char === quote) quote = undefined
      continue
    }
    if (char === '\\' && i + 1 < command.length) { current += char + command[i + 1]!; i += 1; continue }
    if (char === '"' || char === "'") { quote = char; current += char; continue }
    if (/\s/.test(char) && char !== '\n' && char !== '\r') { endWord(); continue }
    // ">&", "<&" and "&>" are redirections, not command separators.
    if (char === '&' && (command[i - 1] === '>' || command[i - 1] === '<' || command[i + 1] === '>')) { current += char; continue }
    if (';|&\n\r(){}`'.includes(char)) { endSegment(); continue }
    current += char
  }
  endSegment()
  return out
}

/** Leading redirections (">f", "2>&1", ">" "file") do not make a word the command. */
function afterRedirections(words: readonly string[], start: number): number {
  let index = start
  while (index < words.length) {
    const current = word(words[index] ?? '')
    const operator = /^\d*(?:>>|<<|>&|<&|>\|?|<)/.exec(current)
    if (!operator) return index
    index += operator[0].length === current.length && !/&$/.test(operator[0]) ? 2 : 1
  }
  return index
}

/** The index of the command a wrapper at `index` runs: past keywords, redirections, options, their values, assignments and a duration. */
function afterWrappers(words: readonly string[], start: number): number {
  let index = afterRedirections(words, start)
  while (index < words.length) {
    const current = word(words[index] ?? '')
    if (KEYWORDS.has(current)) { index = afterRedirections(words, index + 1); continue }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(current)) { index = afterRedirections(words, index + 1); continue }
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
 * pipeline, group or substitution, after keywords, redirections, assignments and
 * wrapper programs, including the text of `eval` and `env -S`. Words inside
 * quotes that hold separators belong to their word. A line this cannot read
 * fully may be over-matched; a refusal then names the lockout rather than
 * starting an unconfirmed account.
 */
export function commandInvokesClaude(command: string): boolean {
  for (const words of segments(command)) {
    // env -S and --split-string take a whole command line.
    if (basename(words[0] ?? '') === 'env') {
      for (let at = 1; at < words.length; at += 1) {
        const option = word(words[at] ?? '')
        const value = option === '-S' || option === '--split-string' ? word(words[at + 1] ?? '') : /^--split-string=/.test(option) ? option.slice('--split-string='.length) : undefined
        if (value !== undefined && commandInvokesClaude(value)) return true
      }
    }
    const index = afterWrappers(words, 0)
    const program = words[index]
    if (program === undefined) continue
    if (isClaude(program)) return true
    const name = basename(program)
    if (name === 'eval' && commandInvokesClaude(words.slice(index + 1).map(word).join(' '))) return true
    // A shell started on the line runs its own command text (sh -c, cmd /c, powershell -Command).
    if (SHELLS.has(name) && argvInvokesClaude(words.slice(index).map(word))) return true
  }
  return false
}

/** Whether an argument vector starts `claude`, directly, through a wrapper, or as a shell's `-c` command. */
export function argvInvokesClaude(argv: readonly string[]): boolean {
  for (let at = 0; at < argv.length; at += 1) {
    const option = argv[at] ?? ''
    const split = option === '-S' || option === '--split-string' ? argv[at + 1] : /^--split-string=/.test(option) ? option.slice('--split-string='.length) : /^-S./.test(option) && basename(argv[0] ?? '') === 'env' ? option.slice(2) : undefined
    if (split !== undefined && commandInvokesClaude(split)) return true
  }
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
