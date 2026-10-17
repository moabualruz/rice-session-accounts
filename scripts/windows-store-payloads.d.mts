export const WINDOWS_PRIVATE_DIRECTORY: string
export const WINDOWS_CREDENTIAL_STORE: string
export const WINDOWS_EXIT: Readonly<{
  NOT_FOUND_CREDENTIAL: 44
  FAILED: 46
  PATH_TOO_LONG: 48
  CONSTRAINED_LANGUAGE: 49
  ACCESS_DENIED: 51
  NOT_FOUND: 52
  NO_LOGON_SESSION: 53
}>
export const WINDOWS_FOLDER_LIMIT: number
export function windowsStoreProblem(exitCode: number | null, subject?: string, detail?: string): string
