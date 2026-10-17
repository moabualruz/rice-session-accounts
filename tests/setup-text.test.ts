import { expect, test } from 'claude-code/testing'

import { legacyCleanupText, quoteFor, setupCommand, setupText, shellQuote, signOutHint } from '../hooks/setup'

function errorOf(run: () => unknown): string {
  try { run() } catch (error) { return error instanceof Error ? error.message : String(error) }
  return ''
}

test('the POSIX setup text prints one command for Bash, zsh and fish and says so', () => {
  const text = setupText('/plugins/rice/', '/home/me/.claude/', 'work', true)
  const lines = text.split('\n')
  expect(lines[0]).toBe('Saved work. Finish or resume setup in a terminal (Bash, zsh or fish):')
  expect(lines[1]).toBe("node '/plugins/rice/scripts/account-setup.mjs' --config-dir '/home/me/.claude' 'work'")
  expect(lines.filter(line => line.includes('scripts/account-setup.mjs')).length).toBe(1)
  expect(text).toContain('/rice-account setup work')
})

test('quotes and backslashes are escaped outside single quotes, where POSIX shells and fish agree', () => {
  expect(setupCommand('/p', "/home/o'neil\\x/.claude/", 'work')).toBe("node '/p/scripts/account-setup.mjs' --config-dir '/home/o'\\''neil'\\\\'x/.claude' 'work'")
  expect(shellQuote('a\\b')).toBe("'a'\\\\'b'")
  expect(shellQuote("it's")).toBe("'it'\\''s'")
  expect(shellQuote('$HOME `id` 100% !x')).toBe("'$HOME `id` 100% !x'")
  expect(quoteFor('posix', 'a\\b')).toBe("'a\\b'")
  expect(quoteFor('fish', "a\\b'c")).toBe("'a\\\\b\\'c'")
  expect(quoteFor('cmd', '100%')).toBe('"100"^%""')
})

test('the Windows setup command doubles every PowerShell single quote, including U+2018 to U+201B', () => {
  expect(setupCommand('C:\\Users\\O\u2019Neil\\plugin\\', 'C:\\Users\\O\u2019Neil\\.claude\\', 'work', 'win32'))
    .toBe("& node 'C:\\Users\\O\u2019\u2019Neil\\plugin/scripts/account-setup.mjs' --config-dir 'C:\\Users\\O\u2019\u2019Neil\\.claude' 'work'")
  expect(setupCommand('C:\\p', "C:\\a\u2018b\u201ac\u201bd'e", 'work', 'win32')).toContain("'C:\\a\u2018\u2018b\u201a\u201ac\u201b\u201bd''e'")
  expect(setupCommand('C:\\p', 'C:\\', 'work', 'win32')).toContain("--config-dir 'C:\\' 'work'")
  expect(setupText('C:\\p', 'C:\\c', 'work', false, 'win32').split('\n')[0]).toBe('work is saved. Finish or resume setup in PowerShell (from Command Prompt, run powershell first):')
})

test('a folder with a line break, NUL or control character never becomes a printed command', () => {
  for (const value of ['/home/me/bad\nfolder', '/home/me/bad\rfolder', '/x\u0000y', '/x\u001by']) {
    expect(errorOf(() => setupCommand('/p', value, 'work'))).toContain('cannot be printed')
    expect(errorOf(() => setupCommand('C:\\p', `C:${value}`, 'work', 'win32'))).toContain('cannot be printed')
    const text = setupText('/p', value, 'work', true)
    expect(text).toContain('cannot be printed')
    expect(text.includes('node ')).toBe(false)
    expect(signOutHint(value, 'posix')).toContain('no command is printed')
    expect(signOutHint(`C:${value}`, 'win32')).toContain('no command is printed')
  }
})

test('the POSIX sign-out command sets both storage folders for one run without env -u', () => {
  const hint = signOutHint('/home/me/.claude/rice-session-accounts/logins/work', 'posix')
  expect(hint).toBe("env CLAUDECODE= CLAUDE_CONFIG_DIR='/home/me/.claude/rice-session-accounts/logins/work' CLAUDE_SECURESTORAGE_CONFIG_DIR='/home/me/.claude/rice-session-accounts/logins/work' claude auth logout")
  expect(hint).not.toContain('env -u')
  expect(signOutHint("/home/o'neil/x\\y/", 'posix')).toContain("CLAUDE_CONFIG_DIR='/home/o'\\''neil/x'\\\\'y' ")
})

test('the PowerShell sign-out command scopes the variables to one run and restores them afterwards', () => {
  const hint = signOutHint('C:\\Users\\O\u2019Neil\\.claude/rice-session-accounts/logins/work', 'win32')
  expect(hint.startsWith('& { $c = $env:CLAUDECODE; $d = $env:CLAUDE_CONFIG_DIR; $s = $env:CLAUDE_SECURESTORAGE_CONFIG_DIR; try { ')).toBe(true)
  expect(hint).toContain("$env:CLAUDE_CONFIG_DIR = 'C:\\Users\\O\u2019\u2019Neil\\.claude/rice-session-accounts/logins/work';")
  expect(hint).toContain("$env:CLAUDE_SECURESTORAGE_CONFIG_DIR = 'C:\\Users\\O\u2019\u2019Neil\\.claude/rice-session-accounts/logins/work';")
  expect(hint).toContain('claude auth logout } finally { $env:CLAUDECODE = $c; $env:CLAUDE_CONFIG_DIR = $d; $env:CLAUDE_SECURESTORAGE_CONFIG_DIR = $s } }')
  expect(hint).not.toContain('env -u')
})

test('0.3.0 launcher cleanup names every file to delete by hand and never deletes anything itself', () => {
  const posix = legacyCleanupText('/home/me/.claude/', 'posix')
  expect(posix).toContain('never deletes')
  expect(posix).toContain('\n  ~/.local/bin/rice-account-claude\n')
  expect(posix).toContain('\n  /home/me/.claude/rice-session-accounts/native-launcher.json\n')
  expect(posix.split('\n').at(-1)).toBe("In a terminal: rm -f -- ~/.local/bin/rice-account-claude '/home/me/.claude/rice-session-accounts/native-launcher.json'")
  const windows = legacyCleanupText('C:\\Users\\O\u2019Neil\\.claude', 'win32')
  for (const file of ['rice-account-claude.cmd', 'rice-account-claude.mjs', 'rice-account-claude']) expect(windows).toContain(`\n  %USERPROFILE%\\.local\\bin\\${file}\n`)
  expect(windows).toContain('\n  C:\\Users\\O\u2019Neil\\.claude\\rice-session-accounts\\native-launcher.json\n')
  expect(windows.split('\n').at(-1)).toBe("In PowerShell: Remove-Item -LiteralPath \"$HOME\\.local\\bin\\rice-account-claude.cmd\", \"$HOME\\.local\\bin\\rice-account-claude.mjs\", \"$HOME\\.local\\bin\\rice-account-claude\", 'C:\\Users\\O\u2019\u2019Neil\\.claude\\rice-session-accounts\\native-launcher.json' -ErrorAction SilentlyContinue")
  const unprintable = legacyCleanupText('/home/me/bad\nfolder', 'posix')
  expect(unprintable).toContain('~/.local/bin/rice-account-claude')
  expect(unprintable.includes('rm -f')).toBe(false)
})
