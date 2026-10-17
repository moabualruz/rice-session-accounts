export const RESERVED_NAMES: readonly string[]
export function isStoredAccountName(name: unknown): name is string
export function isWindowsDeviceName(name: unknown): boolean
export function accountNameProblem(name: unknown): string | undefined
export function isAccountName(name: unknown): name is string
export function legacyNameNote(name: string): string | undefined
export function caseConflict(names: Iterable<string>, name: string): string | undefined
