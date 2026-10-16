#!/usr/bin/env node
// rice-session-accounts installed launcher
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export function installedRoot(configDir, cwd) {
  const ledger = JSON.parse(readFileSync(join(configDir, 'plugins/installed_plugins.json'), 'utf8'))
  const choices = (ledger.plugins?.['rice-session-accounts@rice-mods'] ?? [])
    .filter(install => typeof install.installPath === 'string' && isAbsolute(install.installPath)
      && ['user', 'local', 'project'].includes(install.scope)
      && (!install.projectPath || cwd === resolve(install.projectPath) || cwd.startsWith(resolve(install.projectPath) + sep)))
    .sort((a, b) => (b.projectPath?.length ?? 0) - (a.projectPath?.length ?? 0))
  if (!choices[0]?.installPath) throw new Error('installed plugin unavailable')
  return choices[0].installPath
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  try {
    const root = installedRoot(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), process.cwd())
    const { launch } = await import(pathToFileURL(join(root, 'native/launch.mjs')).href)
    process.exitCode = await launch(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`rice-session-accounts: ${error?.code === 'RICE_ACCOUNT_NATIVE' ? error.message : 'rice-account-claude could not start; update the plugin and run /rice-account setup-native'}\n`)
    process.exitCode = 1
  }
}
