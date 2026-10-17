import { quoteFor as sharedQuoteFor, quotePortable, quotePowerShell } from '../scripts/shell-quote.mjs'

/** A shell a printed command is written for. */
export type Shell = 'portable' | 'posix' | 'fish' | 'powershell' | 'cmd'

/**
 * One word that Bash, zsh, sh and fish all read back as `value`. Fish treats a
 * backslash inside single quotes as an escape, so quotes and backslashes are
 * escaped outside the quoted runs. Throws for a line break, NUL or another
 * control character, which a copied command cannot carry.
 */
export function shellQuote(value: string): string {
  return quotePortable(value)
}

/** One word for a specific shell; see scripts/shell-quote.mjs for the rules of each. */
export function quoteFor(shell: Shell, value: string): string {
  return sharedQuoteFor(shell, value)
}

/** A folder without trailing separators, except a root such as / or C:\, which needs its separator. */
function folder(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  if (trimmed === '') return path.slice(0, 1)
  if (/^[A-Za-z]:$/.test(trimmed)) return `${trimmed}\\`
  return trimmed
}

/**
 * The terminal command that finishes setup. POSIX hosts get one form for
 * Bash, zsh and fish; Windows gets the PowerShell form, Windows Terminal's
 * default shell. Trailing separators are dropped from folders because Windows
 * PowerShell 5.1 passes `"C:\a b\"` to node as an escaped quote.
 */
export function setupCommand(pluginRoot: string, configDir: string, name: string, platform: 'posix' | 'win32' = 'posix'): string {
  const quote = platform === 'win32' ? quotePowerShell : quotePortable
  return `${platform === 'win32' ? '& ' : ''}node ${quote(`${pluginRoot.replace(/[\\/]+$/, '')}/scripts/account-setup.mjs`)} --config-dir ${quote(folder(configDir))} ${quote(name)}`
}

export function setupText(pluginRoot: string, configDir: string, name: string, saved = false, platform: 'posix' | 'win32' = 'posix'): string {
  const intro = saved ? `Saved ${name}.` : `${name} is saved.`
  let command: string
  try {
    command = setupCommand(pluginRoot, configDir, name, platform)
  } catch {
    return `${intro} Its setup command cannot be printed because the Claude config folder or plugin folder path contains a line break or control character. Move that folder to a plain path, then run /rice-account setup ${name} again.`
  }
  const where = platform === 'win32'
    ? 'in PowerShell (from Command Prompt, run powershell first)'
    : 'in a terminal (Bash, zsh or fish)'

  return `${intro} Finish or resume setup ${where}:\n${command}\n\nThe helper checks prerequisites, opens the provider login when needed, and verifies setup.\nThen return here: /rice-account ${name}\nTo show this command again: /rice-account setup ${name}`
}

/**
 * The command that signs out one isolated login, run in a terminal. On POSIX
 * it uses `env NAME=value`, which sh, Bash, zsh and fish all run the same way
 * (no `env -u`). On Windows it is a PowerShell block that sets the variables
 * for the one command and restores the previous values afterwards, even when
 * the command fails. CLAUDECODE is cleared so a terminal opened from Claude
 * Code does not look like a nested session.
 */
export function signOutHint(loginDir: string, platform: 'win32' | 'posix'): string {
  try {
    if (platform === 'win32') {
      const dir = quotePowerShell(folder(loginDir))
      return `& { $c = $env:CLAUDECODE; $d = $env:CLAUDE_CONFIG_DIR; $s = $env:CLAUDE_SECURESTORAGE_CONFIG_DIR; try { $env:CLAUDECODE = $null; $env:CLAUDE_CONFIG_DIR = ${dir}; $env:CLAUDE_SECURESTORAGE_CONFIG_DIR = ${dir}; claude auth logout } finally { $env:CLAUDECODE = $c; $env:CLAUDE_CONFIG_DIR = $d; $env:CLAUDE_SECURESTORAGE_CONFIG_DIR = $s } }`
    }
    const dir = quotePortable(folder(loginDir))
    return `env CLAUDECODE= CLAUDE_CONFIG_DIR=${dir} CLAUDE_SECURESTORAGE_CONFIG_DIR=${dir} claude auth logout`
  } catch {
    return 'claude auth logout, run with CLAUDE_CONFIG_DIR and CLAUDE_SECURESTORAGE_CONFIG_DIR both set to the account\'s login folder (its path contains a line break or control character, so no command is printed)'
  }
}

/**
 * What a 0.3.0 user deletes by hand: the withdrawn launcher in ~/.local/bin
 * (on Windows its .cmd and .mjs files) and its saved selection. Rice Accounts
 * never deletes these files itself.
 */
export function legacyCleanupText(claudeDir: string, platform: 'win32' | 'posix'): string {
  const windows = platform === 'win32'
  const base = folder(claudeDir)
  const selection = windows
    ? `${base.replace(/[\\/]+$/, '')}\\rice-session-accounts\\native-launcher.json`
    : `${base.replace(/\/+$/, '')}/rice-session-accounts/native-launcher.json`
  const launchers = windows
    ? ['rice-account-claude.cmd', 'rice-account-claude.mjs', 'rice-account-claude'].map(file => `%USERPROFILE%\\.local\\bin\\${file}`)
    : ['~/.local/bin/rice-account-claude']
  const lines = [
    'Rice Accounts 0.3.0 installed a launcher that this version no longer uses. If these files exist, delete them by hand; Rice Accounts never deletes them:',
    ...[...launchers, selection].map(path => `  ${path.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '?')}`),
  ]
  try {
    lines.push(windows
      ? `In PowerShell: Remove-Item -LiteralPath "$HOME\\.local\\bin\\rice-account-claude.cmd", "$HOME\\.local\\bin\\rice-account-claude.mjs", "$HOME\\.local\\bin\\rice-account-claude", ${quotePowerShell(selection)} -ErrorAction SilentlyContinue`
      : `In a terminal: rm -f -- ~/.local/bin/rice-account-claude ${quotePortable(selection)}`)
  } catch {
    // The folder path cannot be printed as a command; the list above still names every file.
  }

  return lines.join('\n')
}
