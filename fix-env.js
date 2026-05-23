#!/usr/bin/env node
/**
 * fix-env.js — repair a Windows-mangled .env.local so Next.js can parse it.
 *
 * Detects the file's encoding from its byte-order mark, decodes accordingly
 * (UTF-16 LE, UTF-16 BE, or UTF-8), strips the BOM, normalises line endings
 * to LF, trims stray whitespace around each KEY=VALUE pair, then writes the
 * file back as plain UTF-8 with NO BOM.
 *
 * Usage:   node fix-env.js
 */

const fs   = require('fs')
const path = require('path')

const ENV_PATH = path.resolve(process.cwd(), '.env.local')

// ─── Read raw bytes ──────────────────────────────────────────────────────────

if (!fs.existsSync(ENV_PATH)) {
  console.error(`✗ Not found: ${ENV_PATH}`)
  console.error('  Run this script from the project root (the folder with package.json).')
  process.exit(1)
}

const raw = fs.readFileSync(ENV_PATH)
console.log(`→ Read ${raw.length} bytes from ${ENV_PATH}`)

// ─── Detect BOM / encoding ────────────────────────────────────────────────────

let detected = 'utf8 (no BOM)'
let decoded  = ''

if (raw.length >= 2 && raw[0] === 0xFF && raw[1] === 0xFE) {
  // UTF-16 LE BOM
  detected = 'UTF-16 LE (with BOM)'
  decoded  = raw.slice(2).toString('utf16le')
} else if (raw.length >= 2 && raw[0] === 0xFE && raw[1] === 0xFF) {
  // UTF-16 BE BOM — Node has no native utf16be, byte-swap then decode as LE
  detected  = 'UTF-16 BE (with BOM)'
  const swapped = Buffer.alloc(raw.length - 2)
  for (let i = 2; i < raw.length; i += 2) {
    swapped[i - 2] = raw[i + 1]
    swapped[i - 1] = raw[i]
  }
  decoded = swapped.toString('utf16le')
} else if (raw.length >= 3 && raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) {
  // UTF-8 BOM
  detected = 'UTF-8 (with BOM)'
  decoded  = raw.slice(3).toString('utf8')
} else {
  // Plain UTF-8 (or close enough). Belt-and-braces: strip any U+FEFF that
  // somehow slipped through.
  detected = 'UTF-8 (no BOM)'
  decoded  = raw.toString('utf8')
}

console.log(`→ Detected encoding: ${detected}`)

// ─── Clean the decoded text ──────────────────────────────────────────────────

const cleaned = decoded
  .replace(/^﻿/, '')                          // any leftover BOM codepoint
  .replace(/\r\n/g, '\n')                          // CRLF → LF
  .replace(/\r/g, '\n')                            // lone CR → LF
  .split('\n')
  .map((line) => {
    // Preserve blank lines and comments verbatim
    if (line.trim() === '' || line.trim().startsWith('#')) return line.trimEnd()
    // For KEY=VALUE rows: trim key, trim value, strip surrounding quotes
    const eq = line.indexOf('=')
    if (eq === -1) return line.trimEnd()
    const key = line.slice(0, eq).trim()
    let   val = line.slice(eq + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    return `${key}=${val}`
  })
  .join('\n')
  .replace(/\n{3,}/g, '\n\n')                      // collapse 3+ blank lines

// Ensure trailing newline
const final = cleaned.endsWith('\n') ? cleaned : cleaned + '\n'

// ─── Write back as UTF-8 (no BOM) ─────────────────────────────────────────────

fs.writeFileSync(ENV_PATH, final, { encoding: 'utf8' })
const written = fs.readFileSync(ENV_PATH)
console.log(`→ Wrote ${written.length} bytes back as UTF-8 (no BOM)`)

// ─── Summary (mask values) ───────────────────────────────────────────────────

const keys = final
  .split('\n')
  .filter((l) => l.trim() && !l.trim().startsWith('#'))
  .map((l) => {
    const [k, ...rest] = l.split('=')
    const v = rest.join('=')
    return `  • ${k.padEnd(25)} (${v.length} chars)`
  })

console.log('\n✓ Cleaned successfully.\nKeys present:')
console.log(keys.length ? keys.join('\n') : '  (none found — file may be empty)')
console.log('\nNext step: restart `npm run dev` so Next.js re-reads .env.local.')
