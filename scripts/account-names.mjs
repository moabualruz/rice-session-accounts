// Account name rules shared by the plugin and its terminal setup helper.
// A saved name becomes a folder, a keychain account and a command word, so it
// must mean one thing on every supported platform.

/** The characters every saved name has always been limited to. */
const STORED = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/

/** Windows device names, reserved with or without an extension and in any case. */
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i

/** Command words of /rice-account, and object keys a plain dictionary inherits. */
export const RESERVED_NAMES = Object.freeze([
  'list', 'usage', 'check', 'default', 'setup', 'add', 'remove', 'use', 'help', 'login', 'set-default', 'setup-native',
  'constructor', 'toString', 'toLocaleString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable',
  '__proto__', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__', 'prototype',
])

const RESERVED = new Set(RESERVED_NAMES.map(name => name.toLowerCase()))

/** True for every name an earlier version could save; such accounts keep working. */
export function isStoredAccountName(name) {
  return typeof name === 'string' && STORED.test(name)
}

/** True for a Windows device name such as con, nul.txt or COM1. */
export function isWindowsDeviceName(name) {
  return typeof name === 'string' && WINDOWS_DEVICE.test(name)
}

/** Why a name that fits the stored characters is still unsafe for a new account. */
function currentRuleReason(name) {
  if (name.endsWith('.')) return 'it ends with a dot, which Windows drops from folder names'
  if (isWindowsDeviceName(name)) return 'it is a Windows device name'
  if (RESERVED.has(name.toLowerCase())) return 'it is reserved for /rice-account commands'
  return undefined
}

/** Why a new account cannot use this name, or undefined when it can. */
export function accountNameProblem(name) {
  if (!isStoredAccountName(name)) return `"${typeof name === 'string' ? name : String(name)}" is not a usable name (letters, digits, . _ -, up to 40, starting with a letter or digit)`
  const reason = currentRuleReason(name)
  return reason ? `"${name}" cannot be used because ${reason}; choose another name` : undefined
}

/** Names a new account may use: safe as a folder on macOS, Linux and Windows and never a command word. */
export function isAccountName(name) {
  return accountNameProblem(name) === undefined
}

/** One-line note for a saved account whose name the current rules no longer accept for new accounts. */
export function legacyNameNote(name) {
  if (!isStoredAccountName(name)) return undefined
  const reason = currentRuleReason(name)
  return reason ? `${name} keeps working, but new accounts cannot use this name because ${reason}. Switch to it with /rice-account use ${name}.` : undefined
}

/** The saved name that differs from this one only in letter case, if any. */
export function caseConflict(names, name) {
  const folded = name.toLowerCase()
  for (const other of names) if (other !== name && other.toLowerCase() === folded) return other
  return undefined
}
