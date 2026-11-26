<#
.SYNOPSIS
  Confluence / 高级记忆 — offline end-to-end harness for the DSH 0.2.2-rc.1 host plugin (v0.4.0).

.DESCRIPTION
  v0.4.0 (ADR-0009, extends ADR-0008) keeps the per-workspace session bus and adds three
  profile-global memory layers plus an output side:
    workspace bus    — per-workspace keyed state + notes + addressed messages; never
                       merged across workspaces.
    long-term memory — `pattern` records, candidate-first: add stores a candidate,
                       promote (after user confirmation) makes it active.
    user persona     — the `profile` record type limited to six persona sections
                       (legacy preferences→communication / rules→boundaries).
    style cards      — `style` records in two channels (chat / engineering).
  A one-time migration converts v0.3 profile `tech`/`context` facts into patterns and
  writes a `memory-migration` marker.

  This harness proves the headline acceptance behaviours offline against a local
  Messages-API mock (loopback only, no network egress). It creates a throwaway
  DSH_HOME + headless scratch profile, installs this local bundle, then runs real
  headless sessions:

    seed      — write a v0.3 global journal shard (profile tech/context/preferences
                facts, no migration marker) so the first session triggers migration
    warm-up   — <run>/workspace-a: throwaway text-only session (absorbs the first-mount
                activation race; triggers the one-time migration)
    session A — <run>/workspace-a: `confluence_board` post publishes the bus note
    session E — <run>/workspace-b: `confluence_recall` finds a phrase spoken in A
    session P — <run>/workspace-a: `confluence_profile` set records a persona fact
    session I — <run>/workspace-a: `confluence_memory` import of a legacy v0.3
                `confluence.profile/v1` document (persona-only compatibility)
    session M1— <run>/workspace-a: `confluence_memory` add stores a CANDIDATE
    session M2— <run>/workspace-a: `confluence_memory` promote + export
                (the exported confluence.memory/v1 document is in the structured result)
    session T — <run>/workspace-a: `confluence_style` set writes an active chat rule
    session S — <run>/workspace-a: `confluence_send` broadcasts a notice (queued)
    session D — <run>/workspace-a: `confluence_context` set then get a shared key
    session C — <run>/workspace-a: `confluence_board` list (note + legacy note +
                through=) then `confluence_inbox` (notice + inbox=)
    session B — <run>/workspace-b: NO tool calls; its committed runtime context must
                carry FOUR prompt blocks (persona / long-term memory / style / pulse)
                and must NOT carry workspace-a bus data (isolation)

  After session A created the workspace-a journal, the harness seeds a v0.1.0-style
  per-workspace journal shard into that directory (v0.3/v0.4 reuse v0.1 workspace
  directories as the workspace bus). Session C must see the legacy note; session B
  must not; the seeded file and the existing manifest must stay byte-identical.

  `test/e2e/assert-e2e.mjs` then asserts the store layout (per-workspace bus +
  profile-global memory), the four committed prompt blocks, the candidate→promote
  flow, style injection, the legacy profile-document import, the v0.3→v0.4
  migration, workspace isolation, queued delivery and the watermark cursors. Every
  run directory is kept under `.tmp/e2e/run-<stamp>/` (git-ignored) for evidence.

  The real `~/.dsh` profile is never opened: DSH_HOME is overridden for every child
  process, and the script asserts the desktop profile files are unchanged and that
  the real store holds no trace of this run.

.PARAMETER DshPath
  The `dsh.cmd` launcher. Defaults to the installed DeepSeek Harness runtime;
  when missing the harness prints SKIPPED and exits 0.

.PARAMETER WorkRoot
  Overrides the scratch root (default: <repo>/.tmp/e2e).

.EXAMPLE
  pwsh -File scripts/e2e-dsh.ps1
#>
[CmdletBinding()]
param(
  [string]$DshPath = 'C:\Users\71408\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd',
  [string]$WorkRoot = ''
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($WorkRoot)) { $WorkRoot = Join-Path $Root '.tmp\e2e' }
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$RunDir = Join-Path $WorkRoot "run-$Stamp"
$ScratchHome = Join-Path $RunDir 'dsh-home'
$WorkspaceA = Join-Path $RunDir 'workspace-a'
$WorkspaceB = Join-Path $RunDir 'workspace-b'
$Profile = 'confluence-e2e'
$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
$Results = [System.Collections.Generic.List[object]]::new()
$Mocks = [System.Collections.Generic.List[object]]::new()

# v0.4.0 constants (docs/plan/v0.4-interfaces.md).
$GlobalScopeKey = 'ws_0000000000000000'
$GlobalScopeLabel = 'All sessions'
$NoteTitle = 'Workspace-bus harness gotcha'
$NoteBody = 'Synthetic workspace-bus note written by the offline Confluence v0.4 E2E harness. Safe to delete.'
$NoticeBody = 'Workspace-bus E2E notice from the offline harness.'
$ContextKey = 'e2e.phase'
$ContextValue = 'note-posted'
$PersonaSection = 'communication'
$PersonaKey = 'e2e.language'
$PersonaValue = 'mock E2E persona language'
$PatternKey = 'e2e.windows-retry'
$PatternTitle = 'Windows rename needs a retry'
$PatternBody = 'Synthetic long-term pattern written by the offline Confluence v0.4 E2E harness; promote only after the user confirms.'
$StyleKey = 'e2e.concise'
$StyleRule = 'Keep answers short and structured for the E2E harness.'
$ImportedPersonaKey = 'e2e.imported'
$ImportedPersonaValue = 'imported persona fact'
$LegacyTitle = 'Legacy workspace note'
$LegacyBody = 'Pre-existing v0.1.0 note; in v0.3+ it is read as this workspace bus journal record.'
$LegacyCreatedAt = '2026-01-02T03:04:05.000Z'
$LegacySeq = '01J9Z8K4M2' + ('0' * 14) + '1A'
$MigrationTechKey = 'project'
$MigrationTechValue = 'dsh-confluence e2e migration fact'
$MigrationContextKey = 'repo'
$MigrationContextValue = 'e2e migration context'

function Add-Result([string]$Id, [string]$Label, [bool]$Ok, [string]$Detail) {
  $Results.Add([pscustomobject]@{ Id = $Id; Label = $Label; Ok = $Ok; Detail = $Detail })
  $tag = if ($Ok) { 'PASS' } else { 'FAIL' }
  Write-Host ("{0}    {1}  {2}{3}" -f $tag, $Id, $Label, $(if ($Detail) { " — $Detail" } else { '' }))
}

function Wait-PortFile([string]$Path, [int]$TimeoutMs = 15000) {
  $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path $Path) {
      $value = (Get-Content $Path -Raw).Trim()
      if ($value -ne '') { return $value }
    }
    Start-Sleep -Milliseconds 100
  }
  throw "mock LLM did not write its port file within ${TimeoutMs}ms"
}

function Start-Mock([string]$Scenario, [string]$LogName, [string]$PortFile) {
  $scenarioPath = if ([System.IO.Path]::IsPathRooted($Scenario)) { $Scenario } else { Join-Path $Root "test\e2e\scenarios\$Scenario" }
  if (-not (Test-Path $scenarioPath)) { throw "scenario file not found: $scenarioPath" }
  if (Test-Path $PortFile) { Remove-Item $PortFile -Force }
  $arguments = @(
    (Join-Path $Root 'test\e2e\mock-llm.mjs'),
    '--scenario', $scenarioPath,
    '--log', (Join-Path $RunDir $LogName),
    '--host', '127.0.0.1', '--port', '0',
    '--print-port-file', $PortFile
  )
  $process = Start-Process -FilePath $Node -ArgumentList $arguments -PassThru -WindowStyle Hidden
  $Mocks.Add($process)
  return @{ Process = $process; Port = (Wait-PortFile $PortFile) }
}

function Stop-Mock($Mock) {
  if ($null -eq $Mock) { return }
  try {
    if (-not $Mock.Process.HasExited) { Stop-Process -Id $Mock.Process.Id -Force -ErrorAction Stop }
  } catch {
    # Best effort.
  }
}

# Run one headless session from $Cwd against a private mock. Returns the exit code.
function Invoke-Session([string]$Name, [string]$Cwd, [string]$Scenario, [string]$Prompt) {
  $mock = Start-Mock $Scenario "mock-$Name.jsonl" (Join-Path $RunDir "mock-$Name.port")
  $env:DEEPSEEK_BASE_URL = "http://127.0.0.1:$($mock.Port)"
  Push-Location $Cwd
  try {
    & $DshPath --profile $Profile $Prompt 1> (Join-Path $RunDir "session-$Name.out.txt") 2> (Join-Path $RunDir "session-$Name.err.txt")
    $exitCode = $LASTEXITCODE
  } finally {
    Pop-Location
    Stop-Mock $mock
  }
  return $exitCode
}

function Show-StderrTail([string]$Name) {
  $file = Join-Path $RunDir "session-$Name.err.txt"
  if (-not (Test-Path $file)) { return }
  Write-Host "--- session $Name stderr (tail) ---"
  Get-Content $file -Tail 20 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
}

# Locate the single non-global workspace journal directory created by the first session.
function Find-WorkspaceDir {
  $workspacesRoot = Join-Path $ScratchHome 'storages\confluence\v1\workspaces'
  if (-not (Test-Path $workspacesRoot)) { return $null }
  $dirs = @(Get-ChildItem $workspacesRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^ws_[0-9a-f]{16}$' -and $_.Name -ne $GlobalScopeKey })
  if ($dirs.Count -eq 0) { return $null }
  return $dirs[0]
}

# Seed a v0.3 global journal with profile facts that v0.4 must migrate ONCE:
#   tech.project / context.repo  -> `pattern` records (source migration) + marker
#   preferences.answer.language  -> persona alias fold (preferences -> communication)
# The seeded shard must never be rewritten; migration appends new records.
function New-GlobalMemorySeed {
  $dir = Join-Path $ScratchHome "storages\confluence\v1\workspaces\$GlobalScopeKey"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $manifest = [ordered]@{
    format = 'confluence.store/v1'
    formatVersion = 1
    ws = $GlobalScopeKey
    workspace = [ordered]@{ key = $GlobalScopeKey; canonicalPath = ''; createdAt = '2026-01-02T03:04:05.000Z'; label = $GlobalScopeLabel }
    generation = 0
    snapshot = $null
    shards = @()
    seqRange = [ordered]@{ min = $null; max = $null }
    updatedAt = '2026-01-02T03:04:05.000Z'
  }
  $manifestPath = Join-Path $dir 'MANIFEST.v1.json'
  $manifest | ConvertTo-Json -Depth 8 | Set-Content $manifestPath -Encoding utf8
  $ts = (Get-Date).ToUniversalTime().AddDays(-1).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  function ProfileRecord([string]$seqSuffix, [string]$section, [string]$key, [string]$value) {
    $seq = '01J9Z8K4M2' + ('0' * 14) + $seqSuffix
    [ordered]@{
      v = 1; type = 'profile'; id = "prf_$seq"; ws = $GlobalScopeKey
      section = $section; key = $key; value = $value; confidence = 0.9; source = 'user'
      author = [ordered]@{ sessionId = 'session-v03-legacy'; title = 'v0.3 legacy profile' }
      seq = $seq; ts = $ts
    }
  }
  $records = @(
    (ProfileRecord '2A' 'tech' $MigrationTechKey $MigrationTechValue),
    (ProfileRecord '2B' 'context' $MigrationContextKey $MigrationContextValue),
    (ProfileRecord '2C' 'preferences' 'answer.language' 'mock legacy preference')
  )
  $journalPath = Join-Path $dir 'journal.9000-c0ffee02.v1.jsonl'
  ($records | ForEach-Object { ($_ | ConvertTo-Json -Depth 8 -Compress) }) -join "`n" | Set-Content $journalPath -Encoding utf8
  $seed = [ordered]@{
    wsKey = $GlobalScopeKey
    files = @(
      [pscustomobject]@{
        path = [System.IO.Path]::GetRelativePath($RunDir, $journalPath).Replace('\', '/')
        sha256 = (Get-FileHash $journalPath -Algorithm SHA256).Hash.ToLower()
        bytes = (Get-Item $journalPath).Length
      },
      [pscustomobject]@{
        path = [System.IO.Path]::GetRelativePath($RunDir, $manifestPath).Replace('\', '/')
        sha256 = (Get-FileHash $manifestPath -Algorithm SHA256).Hash.ToLower()
        bytes = (Get-Item $manifestPath).Length
      }
    )
    facts = @(
      [pscustomobject]@{ section = 'tech'; key = $MigrationTechKey; value = $MigrationTechValue },
      [pscustomobject]@{ section = 'context'; key = $MigrationContextKey; value = $MigrationContextValue },
      [pscustomobject]@{ section = 'preferences'; key = 'answer.language'; value = 'mock legacy preference' }
    )
  }
  $seed | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $RunDir 'memory-seed.json') -Encoding utf8
  return $seed
}

# Seed a v0.1.0-style journal shard into the existing workspace-a journal directory.
# The store reuses v0.1 workspace directories as the workspace bus; the record must be
# read as-is, and nothing may be rewritten or migrated. The manifest already exists
# (created by the first session) and must stay byte-identical.
function New-LegacySeed([System.IO.DirectoryInfo]$wsDir) {
  $wsKey = $wsDir.Name
  $entryTs = (Get-Date).ToUniversalTime().AddDays(-1).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  $entry = [ordered]@{
    v = 1
    type = 'entry'
    id = "cnf_$LegacySeq"
    ws = $wsKey
    kind = 'decision'
    title = $LegacyTitle
    body = $LegacyBody
    tags = @('legacy', 'fixture')
    author = [ordered]@{ sessionId = 'session-legacy-alpha'; title = 'Legacy alpha session'; origin = 'agent' }
    seq = $LegacySeq
    ts = $entryTs
  }
  $journalPath = Join-Path $wsDir.FullName 'journal.9001-c0ffee01.v1.jsonl'
  ($entry | ConvertTo-Json -Depth 8 -Compress) + "`n" | Set-Content $journalPath -Encoding utf8 -NoNewline
  $manifestPath = Join-Path $wsDir.FullName 'MANIFEST.v1.json'
  $seed = [ordered]@{
    wsKey = $wsKey
    label = $wsDir.Name
    dir = [System.IO.Path]::GetRelativePath($RunDir, $wsDir.FullName).Replace('\', '/')
    entry = [ordered]@{ id = "cnf_$LegacySeq"; title = $LegacyTitle; kind = 'decision'; seq = $LegacySeq; ts = $entryTs }
    files = @(
      [pscustomobject]@{
        path = [System.IO.Path]::GetRelativePath($RunDir, $journalPath).Replace('\', '/')
        sha256 = (Get-FileHash $journalPath -Algorithm SHA256).Hash.ToLower()
        bytes = (Get-Item $journalPath).Length
      },
      [pscustomobject]@{
        path = [System.IO.Path]::GetRelativePath($RunDir, $manifestPath).Replace('\', '/')
        sha256 = (Get-FileHash $manifestPath -Algorithm SHA256).Hash.ToLower()
        bytes = (Get-Item $manifestPath).Length
      }
    )
  }
  $seed | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $RunDir 'legacy-seed.json') -Encoding utf8
  return $seed
}

# Read the writer note back from the workspace-a journal.
function Find-WorkspaceNote([string]$wsKey, [string]$Title) {
  $dir = Join-Path $ScratchHome "storages\confluence\v1\workspaces\$wsKey"
  if (-not (Test-Path $dir)) { return $null }
  foreach ($file in Get-ChildItem $dir -Filter 'journal.*.v1.jsonl' -File -ErrorAction SilentlyContinue) {
    foreach ($line in Get-Content $file.FullName -ErrorAction SilentlyContinue) {
      if ([string]::IsNullOrWhiteSpace($line)) { continue }
      try { $record = $line | ConvertFrom-Json } catch { continue }
      if ($record.type -eq 'entry' -and $record.title -eq $Title) { return $record }
    }
  }
  return $null
}

# Read the newest pattern record with a given key from the scratch global journal.
function Find-Pattern([string]$Key) {
  $dir = Join-Path $ScratchHome "storages\confluence\v1\workspaces\$GlobalScopeKey"
  if (-not (Test-Path $dir)) { return $null }
  $found = $null
  foreach ($file in Get-ChildItem $dir -Filter 'journal.*.v1.jsonl' -File -ErrorAction SilentlyContinue) {
    foreach ($line in Get-Content $file.FullName -ErrorAction SilentlyContinue) {
      if ([string]::IsNullOrWhiteSpace($line)) { continue }
      try { $record = $line | ConvertFrom-Json } catch { continue }
      if ($record.type -eq 'pattern' -and $record.key -eq $Key) {
        if ($null -eq $found -or [string]::CompareOrdinal($record.seq, $found.seq) -gt 0) { $found = $record }
      }
    }
  }
  return $found
}

# ── prerequisites ─────────────────────────────────────────────────────────
if ([string]::IsNullOrWhiteSpace($Node)) {
  Write-Host 'SKIPPED: node is not on PATH.'
  exit 0
}
if (-not (Test-Path $DshPath)) {
  Write-Host "SKIPPED: dsh launcher not found at $DshPath"
  exit 0
}

$realDshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$desktopPackage = Join-Path $realDshHome 'profiles\desktop\package.json'
$desktopPatch = Join-Path $realDshHome 'profiles\desktop\cordis.patch.yml'
$beforePackage = if (Test-Path $desktopPackage) { (Get-FileHash $desktopPackage -Algorithm SHA256).Hash } else { '' }
$beforePatch = if (Test-Path $desktopPatch) { (Get-FileHash $desktopPatch -Algorithm SHA256).Hash } else { '' }
$realStore = Join-Path $realDshHome 'storages\confluence'
$realStoreExistedBefore = Test-Path $realStore

New-Item -ItemType Directory -Force -Path $RunDir, $ScratchHome, $WorkspaceA, $WorkspaceB | Out-Null
Write-Host "Confluence v0.4 three-layer memory + style E2E — $Stamp"
Write-Host "  repo:        $Root"
Write-Host "  run dir:     $RunDir"
Write-Host "  dsh home:    $ScratchHome (scratch only)"
Write-Host "  workspace A: $WorkspaceA"
Write-Host "  workspace B: $WorkspaceB"

$savedDshHome = $env:DSH_HOME
$savedBaseUrl = $env:DEEPSEEK_BASE_URL
$savedApiKey = $env:DEEPSEEK_API_KEY
$noteEntry = $null
$legacySeed = $null
$memorySeed = $null
$workspaceDir = $null
$writerAttempts = 0
$promotedPattern = $null
try {
  $env:DSH_HOME = $ScratchHome
  $env:DEEPSEEK_API_KEY = 'mock-e2e-key'
  $env:DEEPSEEK_BASE_URL = 'http://127.0.0.1:1' # replaced per mock below

  # ── seed the v0.3 global journal before the first session (migration fixture) ──
  $memorySeed = New-GlobalMemorySeed
  $seedOk = Test-Path (Join-Path $ScratchHome "storages\confluence\v1\workspaces\$GlobalScopeKey\MANIFEST.v1.json")
  Add-Result 'E2E-00a' 'v0.3 global profile journal seeded for the one-time migration' $seedOk ''

  # ── E2E-00: scratch profile + bundle install ───────────────────────────
  $createOut = & $DshPath --profile $Profile --from-default-profile headless --dump-config 2>&1 | Out-String
  $createOk = ($LASTEXITCODE -eq 0) -and ($createOut -match 'dsh-headless')
  Add-Result 'E2E-00b' 'fresh headless scratch profile composes' $createOk ($createOut -split "`n" | Select-Object -First 1)
  if (-not $createOk) { throw 'scratch profile creation failed' }

  $installOut = & $DshPath plugin --profile $Profile add $Root 2>&1 | Out-String
  $installOk = ($LASTEXITCODE -eq 0) -and ($installOut -match 'dsh-confluence')
  Add-Result 'E2E-00c' 'local bundle installs into the scratch profile' $installOk (($installOut -split "`n" | Where-Object { $_ -match 'dsh-confluence' } | Select-Object -First 1))

  $dump = & $DshPath --profile $Profile --dump-config 2>&1 | Out-String
  $rowOk = $dump -match '(?m)^- id: confluence\s*$' -and $dump -match 'name: dsh-confluence' -and $dump -match '(?m)^\s+memory:\s*$' -and $dump -match '(?m)^\s+style:\s*$'
  Add-Result 'E2E-00d' 'composed profile contains the confluence row with memory + style sections' $rowOk ''

  # ── warm-up: absorb the post-install activation race and trigger migration ──
  $warmupExit = Invoke-Session 'warmup' $WorkspaceA 'warmup.json' 'Warm-up session: reply with one short sentence.'
  $warmupOut = Get-Content (Join-Path $RunDir 'session-warmup.out.txt') -Raw -ErrorAction SilentlyContinue
  $warmupOk = ($warmupExit -eq 0) -and ($warmupOut -match 'Warm-up session completed')
  Add-Result 'E2E-00e' 'scratch-profile warm-up exits 0 (absorbs activation race and triggers migration)' $warmupOk "exit=$warmupExit"
  if (-not $warmupOk) { Show-StderrTail 'warmup' }

  # ── session A: publish the workspace-bus note ──────────────────────────
  $writerPrompt = 'Publish one workspace-bus note about the workspace-bus E2E harness gotcha.'
  $writerAttempts = 0
  $writerExit = 1
  $writerOut = ''
  while ($writerAttempts -lt 2) {
    $writerAttempts += 1
    $writerExit = Invoke-Session 'a' $WorkspaceA 'board-post.json' $writerPrompt
    $writerOut = Get-Content (Join-Path $RunDir 'session-a.out.txt') -Raw -ErrorAction SilentlyContinue
    $writerAnswered = ($writerExit -eq 0) -and ($writerOut -match 'Workspace note accepted')
    $workspaceDir = Find-WorkspaceDir
    $noteEntry = if ($null -ne $workspaceDir) { Find-WorkspaceNote $workspaceDir.Name $NoteTitle } else { $null }
    if ($writerAnswered -and $null -ne $noteEntry) { break }
    if ($writerAttempts -lt 2) {
      Write-Host '  WARN: writer note missing after attempt 1 (likely cold-start activation race); retrying once.'
      Remove-Item (Join-Path $RunDir 'mock-a.jsonl'), (Join-Path $RunDir 'session-a.out.txt'), (Join-Path $RunDir 'session-a.err.txt') -Force -ErrorAction SilentlyContinue
    }
  }
  $writerOk = ($writerExit -eq 0) -and ($writerOut -match 'Workspace note accepted') -and ($null -ne $noteEntry)
  Add-Result 'E2E-01a' 'session A (workspace-a) posts the workspace-bus note' $writerOk "exit=$writerExit attempts=$writerAttempts"
  if (-not $writerOk) { Show-StderrTail 'a' }

  $noteId = if ($null -ne $noteEntry) { [string]$noteEntry.id } else { '' }
  $workspaceOk = -not [string]::IsNullOrWhiteSpace($noteId) -and $null -ne $workspaceDir -and $workspaceDir.Name -ne $GlobalScopeKey
  Add-Result 'E2E-01b' "writer note is in the workspace journal (workspaces/<wsKey>, not $GlobalScopeKey)" $workspaceOk "id=$noteId dir=$($workspaceDir.Name)"
  if (-not $workspaceOk) {
    Write-Host "  expected the note under $ScratchHome\storages\confluence\v1\workspaces\<wsKey>"
  }

  # ── session E: recall (runs right after A, within recall.maxSessions) ──
  $recallExit = Invoke-Session 'e' $WorkspaceB 'recall.json' 'Recall what an earlier session said about the workspace-bus E2E harness gotcha.'
  $recallOut = Get-Content (Join-Path $RunDir 'session-e.out.txt') -Raw -ErrorAction SilentlyContinue
  $recallOk = ($recallExit -eq 0) -and ($recallOut -match 'Workspace-bus recall confirmed')
  Add-Result 'E2E-01c' 'session E (workspace-b) recalls an excerpt from session A in another directory' $recallOk "exit=$recallExit"
  if (-not $recallOk) { Show-StderrTail 'e' }

  # ── session P: persona fact ───────────────────────────────────────────
  $profileExit = Invoke-Session 'p' $WorkspaceA 'profile-set.json' 'Record one durable persona fact from this E2E run.'
  $profileOut = Get-Content (Join-Path $RunDir 'session-p.out.txt') -Raw -ErrorAction SilentlyContinue
  $profileOk = ($profileExit -eq 0) -and ($profileOut -match 'Profile fact accepted')
  Add-Result 'E2E-01d' "session P (workspace-a) records a persona fact ($PersonaSection.$PersonaKey)" $profileOk "exit=$profileExit"
  if (-not $profileOk) { Show-StderrTail 'p' }

  # ── session I: import a legacy v0.3 profile document ───────────────────
  $importExit = Invoke-Session 'i' $WorkspaceA 'memory-import.json' 'Import the legacy profile document for portability compatibility.'
  $importOut = Get-Content (Join-Path $RunDir 'session-i.out.txt') -Raw -ErrorAction SilentlyContinue
  $importOk = ($importExit -eq 0) -and ($importOut -match 'Legacy profile document imported')
  Add-Result 'E2E-01e' 'session I (workspace-a) imports a legacy confluence.profile/v1 document' $importOk "exit=$importExit"
  if (-not $importOk) { Show-StderrTail 'i' }

  # ── session M1: add a long-term memory CANDIDATE ───────────────────────
  $candidateExit = Invoke-Session 'm1' $WorkspaceA 'memory-add.json' 'Propose one durable long-term memory pattern from this E2E run.'
  $candidateOut = Get-Content (Join-Path $RunDir 'session-m1.out.txt') -Raw -ErrorAction SilentlyContinue
  $candidateOk = ($candidateExit -eq 0) -and ($candidateOut -match 'Memory candidate accepted')
  Add-Result 'E2E-01f' "session M1 (workspace-a) stores pattern '$PatternKey' as a candidate" $candidateOk "exit=$candidateExit"
  if (-not $candidateOk) { Show-StderrTail 'm1' }

  # ── session M2: promote the candidate, then export the document ───────
  $promoteExit = Invoke-Session 'm2' $WorkspaceA 'memory-promote-export.json' 'Promote the confirmed long-term memory pattern, then export the portable memory document.'
  $promoteOut = Get-Content (Join-Path $RunDir 'session-m2.out.txt') -Raw -ErrorAction SilentlyContinue
  $promoteOk = ($promoteExit -eq 0) -and ($promoteOut -match 'Memory promoted and exported')
  $promotedPattern = Find-Pattern $PatternKey
  $promotedOk = $promoteOk -and $null -ne $promotedPattern -and $promotedPattern.status -eq 'active'
  Add-Result 'E2E-01g' "session M2 (workspace-a) promotes the candidate and exports confluence.memory/v1" $promotedOk "exit=$promoteExit status=$($promotedPattern.status)"
  if (-not $promotedOk) { Show-StderrTail 'm2' }

  # ── session T: style rule ─────────────────────────────────────────────
  $styleExit = Invoke-Session 't' $WorkspaceA 'style-set.json' 'Record one explicit output-style rule for conversational answers.'
  $styleOut = Get-Content (Join-Path $RunDir 'session-t.out.txt') -Raw -ErrorAction SilentlyContinue
  $styleOk = ($styleExit -eq 0) -and ($styleOut -match 'Style rule saved and applied')
  Add-Result 'E2E-01h' "session T (workspace-a) saves chat style rule '$StyleKey'" $styleOk "exit=$styleExit"
  if (-not $styleOk) { Show-StderrTail 't' }

  # ── session S: queue a workspace broadcast message ────────────────────
  $sendExit = Invoke-Session 's' $WorkspaceA 'send-notice.json' 'Send one workspace-bus notice to the peers in this workspace.'
  $sendOut = Get-Content (Join-Path $RunDir 'session-s.out.txt') -Raw -ErrorAction SilentlyContinue
  $sendOk = ($sendExit -eq 0) -and ($sendOut -match 'Notice queued')
  Add-Result 'E2E-01i' 'session S (workspace-a) queues a workspace-bus notice (no interruption)' $sendOk "exit=$sendExit"
  if (-not $sendOk) { Show-StderrTail 's' }

  # ── session D: set then get the shared state key ──────────────────────
  $contextExit = Invoke-Session 'd' $WorkspaceA 'context-kv.json' 'Set one shared state key for this workspace, then read it back.'
  $contextOut = Get-Content (Join-Path $RunDir 'session-d.out.txt') -Raw -ErrorAction SilentlyContinue
  $contextOk = ($contextExit -eq 0) -and ($contextOut -match 'Context state confirmed')
  Add-Result 'E2E-01j' 'session D (workspace-a) sets and reads the shared state pool entry' $contextOk "exit=$contextExit"
  if (-not $contextOk) { Show-StderrTail 'd' }

  # ── seed the v0.1.0 workspace journal shard (after the first session created the dir) ──
  if ($null -ne $workspaceDir) {
    $legacySeed = New-LegacySeed $workspaceDir
    $seedFile = Join-Path $RunDir ($legacySeed.files[0].path -replace '/', '\')
    $legacyOk = Test-Path $seedFile
    Add-Result 'E2E-01k' "legacy v1 workspace shard seeded read-only into $($workspaceDir.Name) ($LegacyTitle)" $legacyOk ''
  } else {
    Add-Result 'E2E-01k' 'legacy v1 workspace shard seeded read-only' $false 'workspace-a journal directory missing'
  }

  # ── session C: read the workspace bus + inbox (same directory) ────────
  $boardExit = Invoke-Session 'c' $WorkspaceA 'board-read.json' 'Read this workspace bus: which notes and queued messages are here?'
  $boardOut = Get-Content (Join-Path $RunDir 'session-c.out.txt') -Raw -ErrorAction SilentlyContinue
  $boardOk = ($boardExit -eq 0) -and ($boardOut -match 'Workspace bus and inbox confirmed')
  Add-Result 'E2E-01l' 'session C (workspace-a) lists the bus notes (incl. legacy) and reads the queued inbox' $boardOk "exit=$boardExit"
  if (-not $boardOk) { Show-StderrTail 'c' }

  # ── session B: isolation + four prompt blocks in a DIFFERENT directory ─
  $pulseExit = Invoke-Session 'b' $WorkspaceB 'text-answer.json' 'Check your injected context: what persona, long-term memory, style and workspace state do you see?'
  $pulseOut = Get-Content (Join-Path $RunDir 'session-b.out.txt') -Raw -ErrorAction SilentlyContinue
  $pulseOk = ($pulseExit -eq 0) -and ($pulseOut -match 'Hello from the Confluence E2E mock model')
  Add-Result 'E2E-01m' 'session B (workspace-b) exits 0 with the mock answer' $pulseOk "exit=$pulseExit"
  if (-not $pulseOk) { Show-StderrTail 'b' }

  # ── assertion script (store layout + four blocks + candidate flow + migration) ──
  $assertArgs = @(
    (Join-Path $Root 'test\e2e\assert-e2e.mjs'),
    '--run', $RunDir,
    '--dsh-home', $ScratchHome,
    '--workspace-a', $WorkspaceA,
    '--workspace-b', $WorkspaceB,
    '--legacy-seed', (Join-Path $RunDir 'legacy-seed.json'),
    '--memory-seed', (Join-Path $RunDir 'memory-seed.json')
  )
  & $Node @assertArgs
  $assertExit = $LASTEXITCODE
  $assertOk = ($assertExit -eq 0)
  Add-Result 'E2E-02' 'assert-e2e.mjs: three-layer memory, four blocks, candidate flow, migration, bus isolation' $assertOk "exit=$assertExit"
} catch {
  Add-Result 'E2E-ERROR' 'harness aborted before completing every check' $false $_.Exception.Message
} finally {
  foreach ($mock in $Mocks) { Stop-Mock $mock }
  $env:DSH_HOME = $savedDshHome
  $env:DEEPSEEK_BASE_URL = $savedBaseUrl
  $env:DEEPSEEK_API_KEY = $savedApiKey

  # ── guards: the real profile and its store were not touched ───────────
  $afterPackage = if (Test-Path $desktopPackage) { (Get-FileHash $desktopPackage -Algorithm SHA256).Hash } else { '' }
  $afterPatch = if (Test-Path $desktopPatch) { (Get-FileHash $desktopPatch -Algorithm SHA256).Hash } else { '' }
  $profileUntouched = ($beforePackage -eq $afterPackage) -and ($beforePatch -eq $afterPatch)
  Add-Result 'GUARD-01' 'real desktop profile files unchanged' $profileUntouched ''
  $realStoreFiles = 0
  $realStoreTraces = @()
  if (Test-Path $realStore) {
    $realFiles = @(Get-ChildItem -Recurse -File $realStore -ErrorAction SilentlyContinue)
    $realStoreFiles = $realFiles.Count
    if ($realFiles.Count -gt 0) {
      $realStoreTraces = @($realFiles | Select-String -SimpleMatch -Pattern @($NoteTitle, $LegacyTitle, $PatternTitle, "run-$Stamp") -List -ErrorAction SilentlyContinue)
    }
  }
  $noRealTrace = ($realStoreTraces.Count -eq 0)
  $guardDetail = if ($realStoreExistedBefore) {
    "pre-existing real store ($realStoreFiles file(s)) scanned for this run's artifacts"
  } else {
    'real store absent before and after'
  }
  Add-Result 'GUARD-02' 'real DSH_HOME Confluence store contains no trace of this run' $noRealTrace $guardDetail
  $noScratchProfile = -not (Test-Path (Join-Path $realDshHome "profiles\$Profile"))
  Add-Result 'GUARD-03' 'no scratch e2e profile leaked into the real DSH_HOME' $noScratchProfile ''

  $summary = [pscustomobject]@{
    stamp = $Stamp
    runDir = $RunDir
    dshPath = $DshPath
    scratchDshHome = $ScratchHome
    workspaceA = $WorkspaceA
    workspaceB = $WorkspaceB
    globalScope = [pscustomobject]@{ key = $GlobalScopeKey; label = $GlobalScopeLabel }
    workspaceScope = if ($null -ne $workspaceDir) { $workspaceDir.Name } else { $null }
    note = if ($null -ne $noteEntry) { [pscustomobject]@{ id = $noteEntry.id; seq = $noteEntry.seq; title = $noteEntry.title } } else { $null }
    notice = [pscustomobject]@{ body = $NoticeBody; kind = 'notice' }
    context = [pscustomobject]@{ key = $ContextKey; value = $ContextValue }
    persona = [pscustomobject]@{ section = $PersonaSection; key = $PersonaKey; value = $PersonaValue }
    importedPersona = [pscustomobject]@{ key = $ImportedPersonaKey; value = $ImportedPersonaValue }
    pattern = if ($null -ne $promotedPattern) { [pscustomobject]@{ key = $promotedPattern.key; title = $promotedPattern.title; status = $promotedPattern.status; seq = $promotedPattern.seq } } else { $null }
    style = [pscustomobject]@{ channel = 'chat'; key = $StyleKey; rule = $StyleRule }
    migrationSeed = if ($null -ne $memorySeed) { $memorySeed } else { $null }
    legacy = if ($null -ne $legacySeed) { [pscustomobject]@{ wsKey = $legacySeed.wsKey; entry = $legacySeed.entry } } else { $null }
    writerAttempts = $writerAttempts
    realStoreExistedBefore = [bool]$realStoreExistedBefore
    checks = $Results
    passed = @($Results | Where-Object { $_.Ok }).Count
    failed = @($Results | Where-Object { -not $_.Ok }).Count
  }
  $summary | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $RunDir 'summary.json') -Encoding utf8
  Write-Host ''
  Write-Host ("Confluence v0.4 E2E — {0} passed, {1} failed; artifacts: {2}" -f $summary.passed, $summary.failed, $RunDir)
  if ($summary.failed -gt 0) { exit 1 }
  exit 0
}
