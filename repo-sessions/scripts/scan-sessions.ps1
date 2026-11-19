# Reads Claude Code session transcripts (.jsonl) and prints one metadata record per file.
# READ-ONLY: files are opened with FileAccess.Read and never written, moved or deleted.
#
# stdin : {"files": ["C:\\...\\<id>.jsonl", ...]}  (ASCII JSON, non-ASCII as \uXXXX)
# stdout: [{"path","customTitle","aiTitle","firstPrompt","lastPrompt","gitBranch","cwd",
#           "hasPrompt","hasAssistant","error"}, ...]  (ASCII JSON, non-ASCII as \uXXXX)
#
# The transcript format is internal to Claude Code and changes between versions, so every
# field is best effort: a field that cannot be read is null, and a file that cannot be read
# at all carries "error" instead of stopping the scan.

$ErrorActionPreference = 'Stop'

$HeadBytes = 262144        # first prompt lives near the start
$TailBytes = 262144        # custom-title / ai-title / last-prompt are re-appended near the end
$FullScanLimit = 16MB      # a file whose tail holds no custom-title is scanned whole up to this size

function Read-Chunk([string]$Path, [long]$Offset, [int]$Count) {
    $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
    $fs = New-Object IO.FileStream($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, $share)
    try {
        [void]$fs.Seek($Offset, [IO.SeekOrigin]::Begin)
        $buf = New-Object byte[] $Count
        $read = 0
        while ($read -lt $Count) {
            $n = $fs.Read($buf, $read, $Count - $read)
            if ($n -le 0) { break }
            $read += $n
        }
        return [Text.Encoding]::UTF8.GetString($buf, 0, $read)
    } finally { $fs.Dispose() }
}

function Try-Json([string]$Line) {
    try { return $Line | ConvertFrom-Json } catch { return $null }
}

# A user record's typed text, or $null for tool results, meta rows and slash-command echoes.
function Get-PromptText($Rec) {
    if ($null -eq $Rec -or $Rec.isMeta -or $Rec.isSidechain -or $Rec.isCompactSummary) { return $null }
    $content = $Rec.message.content
    $text = $null
    if ($content -is [string]) { $text = $content }
    elseif ($null -ne $content) {
        foreach ($block in @($content)) {
            if ($block.type -eq 'text' -and $block.text) { $text = [string]$block.text; break }
        }
    }
    if (-not $text) { return $null }
    $t = $text.Trim()
    if ($t -eq '' -or $t -match '^<(command-name|command-message|command-args|local-command-[a-z]+|system-reminder)>') { return $null }
    return $t
}

$BranchRe = [regex]'"gitBranch":"((?:[^"\\]|\\.)*)"'
$CwdRe = [regex]'"cwd":"((?:[^"\\]|\\.)*)"'

function Unescape-JsonString([string]$s) {
    try { return ('"' + $s + '"' | ConvertFrom-Json) } catch { return $s }
}

function Scan-File([string]$Path) {
    $r = [ordered]@{
        path = $Path; customTitle = $null; aiTitle = $null; firstPrompt = $null; lastPrompt = $null
        gitBranch = $null; cwd = $null; hasPrompt = $false; hasAssistant = $false; error = $null
    }
    try {
        $len = (New-Object IO.FileInfo $Path).Length
        if ($len -le ($HeadBytes + $TailBytes)) {
            $head = Read-Chunk $Path 0 ([int]$len); $tail = ''
        } else {
            $head = Read-Chunk $Path 0 $HeadBytes
            $tail = Read-Chunk $Path ($len - $TailBytes) $TailBytes
            $nl = $tail.IndexOf("`n")                       # drop the line cut by the seek
            $tail = if ($nl -ge 0) { $tail.Substring($nl + 1) } else { '' }
        }

        foreach ($part in @(@{ text = $head; isHead = $true }, @{ text = $tail; isHead = $false })) {
            foreach ($line in $part.text.Split("`n")) {
                if ($line.Length -lt 2) { continue }
                if ($line.Contains('"type":"custom-title"')) {
                    $o = Try-Json $line; if ($o -and $o.customTitle) { $r.customTitle = [string]$o.customTitle }
                } elseif ($line.Contains('"type":"ai-title"')) {
                    $o = Try-Json $line; if ($o -and $o.aiTitle) { $r.aiTitle = [string]$o.aiTitle }
                } elseif ($line.Contains('"type":"last-prompt"')) {
                    $o = Try-Json $line; if ($o -and $o.lastPrompt) { $r.lastPrompt = [string]$o.lastPrompt; $r.hasPrompt = $true }
                } elseif ($line.Contains('"type":"user"')) {
                    if ($part.isHead -and -not $r.firstPrompt) {
                        $p = Get-PromptText (Try-Json $line)
                        if ($p) { $r.firstPrompt = $p; $r.hasPrompt = $true }
                    }
                } elseif ($line.Contains('"type":"assistant"')) {
                    $r.hasAssistant = $true
                }
                $m = $BranchRe.Match($line); if ($m.Success -and $m.Groups[1].Value) { $r.gitBranch = Unescape-JsonString $m.Groups[1].Value }
                $m = $CwdRe.Match($line); if ($m.Success -and $m.Groups[1].Value) { $r.cwd = Unescape-JsonString $m.Groups[1].Value }
            }
        }

        if (-not $r.customTitle -and $tail -ne '' -and $len -le $FullScanLimit) {
            $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
            $fs = New-Object IO.FileStream($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, $share)
            $sr = New-Object IO.StreamReader($fs, [Text.Encoding]::UTF8)
            try {
                while ($null -ne ($line = $sr.ReadLine())) {
                    if ($line.Contains('"type":"custom-title"')) {
                        $o = Try-Json $line; if ($o -and $o.customTitle) { $r.customTitle = [string]$o.customTitle }
                    }
                }
            } finally { $sr.Dispose() }
        }
    } catch {
        $r.error = $_.Exception.Message
    }
    return [pscustomobject]$r
}

try {
    $req = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $files = @($req.files)
} catch {
    [Console]::Out.Write('{"fatal":"bad input: ' + ($_.Exception.Message -replace '[^\x20-\x7E]', '?' -replace '"', "'") + '"}')
    exit 2
}

$out = New-Object System.Collections.ArrayList
foreach ($f in $files) { [void]$out.Add((Scan-File ([string]$f))) }

$json = ConvertTo-Json -InputObject @($out.ToArray()) -Depth 3 -Compress
# Escape everything outside ASCII so the console code page can never mangle Korean text.
$json = [regex]::Replace($json, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
[Console]::Out.Write($json)
