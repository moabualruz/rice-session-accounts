#!/usr/bin/env node
// Fails when a tracked text file contains an en dash (U+2013) or an em dash (U+2014).
// Scans every file Git tracks (plus new files that are not ignored, so a local run sees work
// before it is staged). Binary files and files over 1 MiB are skipped. The two characters are
// built from their code points so that this file passes its own check.
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const maxBytes = 1024 * 1024
const enDash = String.fromCharCode(0x2013)
const emDash = String.fromCharCode(0x2014)
const pattern = new RegExp(`[${enDash}${emDash}]`, 'g')
const names = new Map([[enDash, 'U+2013 en dash'], [emDash, 'U+2014 em dash']])

const listing = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
const files = [...new Set(listing.split('\0').filter(Boolean))].sort()

const findings = []
const affected = new Set()
let scanned = 0
let skippedBinary = 0
let skippedLarge = 0
for (const file of files) {
  const path = join(root, file)
  let size
  try {
    const info = statSync(path)
    if (!info.isFile()) continue
    size = info.size
  } catch (error) {
    // A tracked file deleted from the working tree has nothing to scan.
    if (error?.code === 'ENOENT') continue
    throw error
  }
  if (size > maxBytes) { skippedLarge += 1; continue }
  const bytes = readFileSync(path)
  if (bytes.includes(0)) { skippedBinary += 1; continue }
  scanned += 1
  const lines = bytes.toString('utf8').split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    for (const match of lines[index].matchAll(pattern)) {
      findings.push(`${file}:${index + 1}:${match.index + 1}: ${names.get(match[0])}`)
      affected.add(file)
    }
  }
}

if (findings.length > 0) {
  console.error(`Typographic dashes found (use a hyphen, comma, semicolon, colon or parentheses):\n${findings.join('\n')}`)
  console.error(`${findings.length} occurrence(s) in ${affected.size} file(s).`)
  process.exitCode = 1
} else {
  console.log(`No en or em dashes in ${scanned} text file(s) (${skippedBinary} binary and ${skippedLarge} over 1 MiB skipped).`)
}
