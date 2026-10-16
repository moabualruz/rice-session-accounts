/** Match only this suite's synthetic namespace after native Windows fs resolution. */
export function fixturePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^[A-Za-z]:(?=\/fixture(?:\/|$))/, '')
}
