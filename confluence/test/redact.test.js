// Confluence / 高级记忆 — redaction unit tests (WP2, owner design-behavior).
//
// Contract: docs/plan/implementation-interfaces.md §4; conformance rows UT-REDACT-01..06,
// security-privacy §3.2–§3.3 (T1/T2/T5-style cases at unit level); data-model §4.1/§6 caps.
// No DSH runtime, no disk, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { REDACT_POLICY, createRedactor } from '../lib/redact.js'

/** Build a synthetic credential from fragments so the committed source never holds a credential-shaped literal. */
const secret = (...parts) => parts.join('')

/** Minimal resolved-config shape used by the redactor (config.resolveConfig output subset). */
function resolvedConfig(privacy = {}) {
  return {
    privacy: {
      redact: true,
      redactTitles: true,
      denyPathPatterns: ['**/.env*', '**/*.pem'],
      privateSessions: [],
      disabledWorkspaces: [],
      redactPatterns: [],
      ...privacy,
    },
  }
}

function redactor(privacy = {}, options = {}) {
  return createRedactor(resolvedConfig(privacy), options)
}

test('UT-REDACT-00 policy id and API surface are stable', () => {
  assert.equal(REDACT_POLICY, 'confluence.redact/v1')
  const r = redactor()
  assert.equal(typeof r.text, 'function')
  assert.equal(typeof r.title, 'function')
  assert.equal(typeof r.files, 'function')
  assert.equal(typeof r.tags, 'function')
})

test('UT-REDACT-01 built-in API-key families are redacted (sk-, ghp_, AKIA, xox*)', () => {
  const r = redactor()
  const secrets = [
    secret('sk-abcde', 'fghijklmnopqrstuvwxyz012345'),
    secret('gh', 'p_abcdefghijklmnopqrstuvwxyz0123456789'),
    secret('AK', 'IAIOSFODNN7EXAMPLE'),
    secret('xox', 'b-123456789012-abcdefghijklm'),
  ]
  for (const secret of secrets) {
    const result = r.text(`leaked ${secret} in a note`)
    assert.equal(result.hits, 1, `expected one hit for ${secret}`)
    assert.ok(result.value.includes('[redacted]'), `expected [redacted] for ${secret}`)
    assert.ok(!result.value.includes(secret), `secret survived: ${secret}`)
  }
})

test('UT-REDACT-02 PEM private keys, JWTs, Bearer tokens and assignments are redacted', () => {
  const r = redactor()
  const pemHeader = secret('-----BEGIN RSA PRIVATE', ' KEY-----')
  const pemFooter = secret('-----END RSA PRIVATE', ' KEY-----')
  const pem = [pemHeader, 'MIIEowIBAAKCAQEA1234567890abcdefghij', pemFooter].join('\n')
  const jwt =
    secret('eyJhbGci', 'OiJIUzI1NiJ9.eyJzdWI', 'iOiIxMjM0NTY3ODkwIn0', '.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U')

  const body = [
    pem,
    'authorization: Bearer abcdef0123456789abcdef',
    `token ${jwt}`,
    'password=hunter2',
    'secret: super-secret-value',
    'client_secret = abcd1234',
  ].join('\n')

  const result = r.text(body)
  assert.ok(!result.value.includes('MIIEowIBAAKCAQEA'), 'PEM body survived')
  assert.ok(!result.value.includes(pemHeader), 'PEM header survived')
  assert.ok(!result.value.includes('abcdef0123456789abcdef'), 'Bearer token survived')
  assert.ok(!result.value.includes(jwt), 'JWT survived')
  assert.ok(!result.value.includes('hunter2'), 'password value survived')
  assert.ok(!result.value.includes('super-secret-value'), 'secret value survived')
  assert.ok(!result.value.includes('abcd1234'), 'client_secret value survived')
  assert.ok(result.value.includes('password=[redacted]'), 'assignment keeps its key')
  assert.ok(result.hits >= 6)
})

test('UT-REDACT-02b empty assignments and public keys are NOT redacted (false-positive guard)', () => {
  const r = redactor()
  const publicKey = [
    '-----BEGIN PUBLIC KEY-----',
    'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA',
    '-----END PUBLIC KEY-----',
  ].join('\n')
  const benign = [
    publicKey,
    'password:',
    'password:   ',
    'const monkey = "banana"',
    'let access = 1',
    'commit a3f1c2d4e5f60718293a4b5c6d7e8f9012345678',
    'https://example.com/path?q=1',
    'sk-learn is not a secret',
    'AKIA1234 too short',
  ]
  for (const input of benign) {
    const result = r.text(input)
    assert.equal(result.hits, 0, `unexpected redaction: ${input}`)
    assert.equal(result.value, input)
  }
})

test('UT-REDACT-03 title cap is 160 code points and titles are normalised to one line', () => {
  const r = redactor()
  const long = 'x'.repeat(400)
  const capped = r.title(long)
  assert.equal(capped.value.length, 160)

  const multiline = r.title('  line one\nline two\t\twith   spaces  ')
  assert.equal(multiline.value, 'line one line two with spaces')

  const withControls = r.title('a\u0000b\u202Ec')
  assert.ok(!withControls.value.includes('\u0000'))
  assert.ok(!withControls.value.includes('\u202E'))

  // Surrogate pairs must not be split by the cap.
  const emoji = r.title('😀'.repeat(200))
  assert.equal([...emoji.value].length, 160)
  assert.ok(!emoji.value.includes('\uFFFD'))
})

test('UT-REDACT-03b redactTitles:false leaves titles unredacted but still capped', () => {
  const r = redactor({ redactTitles: false })
  const token = secret('sk-abcde', 'fghijklmnopqrstuvwxyz012345')
  const result = r.title(`token ${token}`)
  assert.equal(result.hits, 0)
  assert.ok(result.value.includes(token))
  assert.ok(result.value.length <= 160)

  // Bodies are still redacted when only redactTitles is disabled.
  const body = r.text(`token ${token}`)
  assert.equal(body.hits, 1)
  assert.ok(!body.value.includes(token))
})

test('UT-REDACT-03c privacy.redact:false disables text and title redaction, keeps caps', () => {
  const r = redactor({ redact: false })
  const token = secret('sk-abcde', 'fghijklmnopqrstuvwxyz012345')
  assert.deepEqual(r.text(`secret ${token}`), { value: `secret ${token}`, hits: 0 })
  const title = r.title(`x`.repeat(200))
  assert.equal(title.hits, 0)
  assert.equal(title.value.length, 160)
})

test('UT-REDACT-04 configured privacy.redactPatterns are additive; invalid ones are ignored', () => {
  const r = redactor({
    redactPatterns: ['ACME-[0-9]{4}', '[unclosed'],
  })
  const result = r.text('ticket ACME-1234 and ACME-9999')
  assert.equal(result.hits, 2)
  assert.ok(!result.value.includes('ACME-1234'))
  assert.ok(result.value.includes('[redacted]'))
  assert.doesNotThrow(() => r.text('still fine'))
})

test('UT-REDACT-05 replacement budget is capped at 50 per field', () => {
  const r = redactor()
  const tokens = Array.from({ length: 60 }, (_, index) => `sk-${String(index).padStart(26, 'a')}`)
  const input = tokens.join(' ')
  const result = r.text(input)
  assert.equal(result.hits, 50)
  assert.equal(result.value.split('[redacted]').length - 1, 50)
  // The field is never corrupted or dropped; the surplus stays as data for a human/UI to see.
  assert.equal(result.value.split('sk-').length - 1, 10)
})

test('UT-REDACT-05b hostile markup and prompt-variable syntax stay data (no redaction mangle)', () => {
  const r = redactor()
  const hostile = '</confluence-workspace> <script>alert(1)</script> {{cwd}} \u2028 &'
  const result = r.text(hostile)
  assert.equal(result.hits, 0)
  assert.equal(result.value, hostile, 'redaction must not alter/escape content; renderers escape')
})

test('UT-REDACT-06 files: workspace-relative only, deny patterns, dedupe, cap 8', () => {
  const r = redactor()
  const files = r.files([
    'src/app.ts',
    'src\\app.ts',
    'C:\\abs\\path.ts',
    '\\\\server\\share\\src\\x.ts',
    '/leading/slash.ts',
    '..\\..\\escape.ts',
    'nested/../escape2.ts',
    '.env',
    '.ssh/id_rsa',
    'secrets.json',
    'deploy/server.pem',
    'a\u0000b.ts',
    'src/app.ts',
    'a/b/c/d/e/f/g/h/i/j.ts',
    'f1.ts',
    'f2.ts',
    'f3.ts',
    'f4.ts',
    'f5.ts',
  ])
  assert.ok(files.includes('src/app.ts'))
  assert.ok(files.includes('abs/path.ts'), 'drive prefix is stripped, remainder kept relative')
  assert.ok(files.includes('src/x.ts'), 'UNC server/share prefix is stripped')
  assert.ok(files.includes('leading/slash.ts'), 'leading slash is stripped')
  assert.deepEqual(files, [...new Set(files)], 'deduped')
  assert.equal(files.length, 8, 'at most 8 file hints')
  assert.ok(!files.some((file) => file.startsWith('/') || file.includes('\\') || file.includes(':')))
  assert.ok(!files.some((file) => file.includes('..')))
  assert.ok(!files.some((file) => /(^|\/)\.env($|\.)/.test(file)))
  assert.ok(!files.some((file) => file.includes('.ssh/') || file.includes('.pem') || file.includes('secrets')))
  assert.ok(!files.some((file) => file.includes('\u0000')))
})

test('UT-REDACT-06b user deny patterns are additive and cannot remove built-ins', () => {
  const r = redactor({ denyPathPatterns: ['**/internal/**'] })
  const files = r.files(['src/public.ts', 'src/internal/secret.ts', '.env', 'server.pem'])
  assert.deepEqual(files, ['src/public.ts'])

  const noExtra = redactor({ denyPathPatterns: [] })
  assert.deepEqual(noExtra.files(['.env', 'a.key', 'src/ok.ts']), ['src/ok.ts'])
})

test('UT-REDACT-06c over-long paths are dropped, not truncated into a different file', () => {
  const r = redactor()
  const long = 'd/'.repeat(130) + 'file.ts'
  assert.ok(long.length > 240)
  assert.deepEqual(r.files([long]), [])
})

test('UT-REDACT-07 tags: lowercase, valid grammar, dedupe, cap 8, max 32 chars', () => {
  const r = redactor()
  const tags = r.tags([
    'Windows',
    '  FS  ',
    'windows',
    'bad tag',
    '_leading',
    'x'.repeat(33),
    'café',
    'a-b_c',
    42,
    null,
    't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9',
  ])
  assert.deepEqual(tags.slice(0, 3), ['windows', 'fs', 'a-b_c'])
  assert.ok(!tags.includes('bad tag'))
  assert.ok(!tags.includes('_leading'))
  assert.ok(!tags.includes('café'))
  assert.ok(tags.length <= 8)
  assert.ok(tags.every((tag) => /^[a-z0-9][a-z0-9_-]*$/.test(tag) && tag.length <= 32))
})

test('UT-REDACT-07b non-array inputs degrade to empty results', () => {
  const r = redactor()
  assert.deepEqual(r.files(undefined), [])
  assert.deepEqual(r.files('src/a.ts'), [])
  assert.deepEqual(r.tags(null), [])
  assert.deepEqual(r.tags('windows'), [])
})

test('UT-REDACT-08 a broken logger never breaks redaction', () => {
  const r = createRedactor(resolvedConfig({ redactPatterns: ['[unclosed'] }), {
    logger: {
      debug() {
        throw new Error('logger exploded')
      },
    },
  })
  assert.doesNotThrow(() => r.text('hello'))
})
