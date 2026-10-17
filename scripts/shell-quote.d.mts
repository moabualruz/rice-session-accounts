export type QuoteShell = 'portable' | 'posix' | 'fish' | 'powershell' | 'cmd'
export const SHELLS: readonly QuoteShell[]
export class UnquotableError extends Error {}
export function quotePosix(value: string): string
export function quoteFish(value: string): string
export function quotePortable(value: string): string
export function quotePowerShell(value: string): string
export function quoteCmd(value: string): string
export function quoteFor(shell: QuoteShell, value: string): string
