/** POSIX quoting for a command copied into Bash, zsh or fish. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function setupCommand(pluginRoot: string, configDir: string, name: string, platform: 'posix' | 'win32' = 'posix'): string {
  const quote = platform === 'win32' ? (value: string) => `'${value.replace(/'/g, "''")}'` : shellQuote
  return `${platform === 'win32' ? '& ' : ''}node ${quote(`${pluginRoot.replace(/[\\/]+$/, '')}/scripts/account-setup.mjs`)} --config-dir ${quote(configDir)} ${quote(name)}`
}

export function setupText(pluginRoot: string, configDir: string, name: string, saved = false, platform: 'posix' | 'win32' = 'posix'): string {
  return `${saved ? `Saved ${name}.` : `${name} is saved.`} Finish or resume setup in a terminal:\n${setupCommand(pluginRoot, configDir, name, platform)}\n\nThe helper checks prerequisites, opens the provider login when needed, and verifies setup.\nThen return here: /rice-account ${name}\nTo show this command again: /rice-account setup ${name}`
}
