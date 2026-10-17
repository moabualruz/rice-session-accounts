// Quoting for commands a person copies into a terminal, shared by the plugin
// and its terminal setup helper. Each function returns one shell word that the
// named shell reads back as exactly the original text, and refuses text that a
// pasted line cannot carry (line breaks, NUL and other control characters).

/** C0 and C1 controls, DEL and the Unicode line and paragraph separators. */
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/

/** PowerShell reads all of these as a single quote, inside and outside quoted strings. */
const POWERSHELL_QUOTES = /['\u2018\u2019\u201a\u201b]/g

export const SHELLS = Object.freeze(['portable', 'posix', 'fish', 'powershell', 'cmd'])

export class UnquotableError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UnquotableError'
  }
}

function printable(value) {
  if (typeof value !== 'string') throw new UnquotableError('A command value must be text.')
  if (UNPRINTABLE.test(value)) throw new UnquotableError('A path or name contains a line break, NUL or another control character, so it cannot be printed as a terminal command.')
  return value
}

/** sh, dash, bash and zsh: one single-quoted word; an embedded quote closes, escapes and reopens. */
export function quotePosix(value) {
  return `'${printable(value).replace(/'/g, `'\\''`)}'`
}

/** fish: inside single quotes fish still reads \\ and \' as escapes, so both are escaped. */
export function quoteFish(value) {
  return `'${printable(value).replace(/[\\']/g, '\\$&')}'`
}

/**
 * One form that sh, dash, bash, zsh and fish all read the same way: runs of
 * ordinary characters in single quotes, and each quote or backslash escaped
 * with a backslash outside them, where every one of those shells agrees.
 */
export function quotePortable(value) {
  printable(value)
  if (value === '') return "''"
  let word = ''
  let run = ''
  for (const char of value) {
    if (char === "'" || char === '\\') {
      if (run) word += `'${run}'`
      run = ''
      word += `\\${char}`
    } else run += char
  }
  return run ? `${word}'${run}'` : word
}

/** PowerShell: a single-quoted string; each of its five single-quote characters is doubled. */
export function quotePowerShell(value) {
  return `'${printable(value).replace(POWERSHELL_QUOTES, '$&$&')}'`
}

/**
 * Command Prompt (cmd.exe with delayed expansion off, its default), for a
 * program that splits its command line with the Microsoft C runtime rules,
 * such as node.exe. Inside double quotes cmd keeps & | < > ^ literal but still
 * expands %NAME%, so each % is written outside the quotes as ^%, which cmd
 * cannot pair into a variable. Backslashes before a closing quote are doubled.
 */
export function quoteCmd(value) {
  printable(value)
  if (value.includes('"')) throw new UnquotableError('A value containing a double quote cannot be passed safely through Command Prompt.')
  return value.split('%').map(part => `"${part.replace(/(\\+)$/, '$1$1')}"`).join('^%')
}

/** The quoting for one target shell. */
export function quoteFor(shell, value) {
  switch (shell) {
    case 'portable': return quotePortable(value)
    case 'posix': return quotePosix(value)
    case 'fish': return quoteFish(value)
    case 'powershell': return quotePowerShell(value)
    case 'cmd': return quoteCmd(value)
    default: throw new UnquotableError(`Unknown shell: ${String(shell)}`)
  }
}
