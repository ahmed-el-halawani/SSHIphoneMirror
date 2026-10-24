param(
    [ValidateSet('Start', 'Stop', 'Check')]
    [string]$Action = 'Start',
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'

function Get-PairUrl([string]$Response) {
    $data = $Response | ConvertFrom-Json
    $uri = [uri]$data.url
    if ($uri.Scheme -ne 'https' -or $uri.Host -ne 'app.simbeam.dev' -or
        $uri.Fragment -notmatch 'daemon=' -or $uri.Fragment -notmatch 'pair=') {
        throw 'The Mac returned an unexpected pairing URL.'
    }
    return $uri.AbsoluteUri
}

if ($SelfTest) {
    $sample = '{"url":"https://app.simbeam.dev/#daemon=test&pair=test","ttl_seconds":300}'
    if ((Get-PairUrl $sample) -ne 'https://app.simbeam.dev/#daemon=test&pair=test') {
        throw 'Pairing URL self-check failed.'
    }
    foreach ($bad in @('{"url":"http://app.simbeam.dev/#daemon=x&pair=y"}',
                       '{"url":"https://example.com/#daemon=x&pair=y"}',
                       '{"url":"https://app.simbeam.dev/"}')) {
        $rejected = $false
        try { $null = Get-PairUrl $bad } catch { $rejected = $true }
        if (-not $rejected) { throw 'Unsafe pairing URL accepted.' }
    }
    Write-Host 'Self-check passed: pairing response parsing and URL validation.'
    exit 0
}

$managerDir = Join-Path $env:LOCALAPPDATA 'SSHResourceManager'
$askpass = Join-Path $managerDir 'askpass.cmd'
$knownHosts = Join-Path $managerDir 'known_hosts'
foreach ($file in @($askpass, $knownHosts)) {
    if (-not (Test-Path -LiteralPath $file)) { throw "SSH Resource Manager file missing: $file" }
}
Get-Command ssh -ErrorAction Stop | Out-Null
$env:SSH_ASKPASS = $askpass
$env:SSH_ASKPASS_REQUIRE = 'force'
$env:SSHRM_HOST_ID = '3ff49720-2b02-42f9-9eca-d7230ab1af45'
$sshArgs = @('-o', 'BatchMode=no', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=5', '-o', 'ServerAliveInterval=5',
    '-o', 'ServerAliveCountMax=2', '-o', 'PreferredAuthentications=password,keyboard-interactive',
    '-o', 'PubkeyAuthentication=no', '-o', 'NumberOfPasswordPrompts=1',
    '-o', ('UserKnownHostsFile="' + $knownHosts.Replace('\', '/') + '"'),
    '-p', '22', '-o', 'User=ahmedelhalawany', '--', '192.168.8.222')

if ($Action -eq 'Check') {
    $remote = @'
set -e
sw_vers -productVersion
"$HOME/.local/bin/simbeamd" version
"$HOME/.local/bin/simbeam-control" --protocol
xcrun simctl list devices booted
'@
} elseif ($Action -eq 'Stop') {
    $remote = @'
set -e
pattern="^$HOME/.local/bin/simbeamd serve -addr 127.0.0.1:18080 -no-update-check$"
if pgrep -f "$pattern" >/dev/null; then
    pkill -TERM -f "$pattern"
    echo 'Mirror daemon stopped. The simulator remains open.'
else
    echo 'Mirror daemon is already stopped.'
fi
'@
} else {
    $remote = @'
set -e
export PATH="$HOME/.local/bin:$PATH"
test -x "$HOME/.local/bin/simbeamd"
test -x "$HOME/.local/bin/simbeam-control"
pattern="^$HOME/.local/bin/simbeamd serve -addr 127.0.0.1:18080 -no-update-check$"
if ! pgrep -f "$pattern" >/dev/null; then
    nohup "$HOME/.local/bin/simbeamd" serve -addr 127.0.0.1:18080 -no-update-check >/tmp/iphonemirror-simbeam.log 2>&1 </dev/null &
    sleep 2
fi
if ! pgrep -f "$pattern" >/dev/null; then
    cat /tmp/iphonemirror-simbeam.log >&2
    exit 1
fi
"$HOME/Documents/Codex/developer-tools/node/bin/node" -e 'const fs=require("fs");const c=JSON.parse(fs.readFileSync(process.env.HOME+"/.simbeam/control.json","utf8"));fetch("http://"+c.addr+"/pair",{method:"POST",headers:{Authorization:"Bearer "+c.token},signal:AbortSignal.timeout(10000)}).then(async r=>{if(!r.ok)throw Error("Pairing failed: "+r.status);console.log(await r.text())}).catch(e=>{console.error(e.message);process.exitCode=1})'
'@
}

Write-Host "Connecting to the Mac ($Action)..."
$response = & ssh @sshArgs $remote
if ($LASTEXITCODE -ne 0) { throw "Remote command failed (exit $LASTEXITCODE). Check the Mac and SSH Resource Manager." }
if ($Action -eq 'Start') {
    $url = Get-PairUrl ($response -join "`n")
    Write-Host 'Opening SimBeam. Click Pair this Mac, then select iPhone 16e.'
    Write-Host 'The pairing link expires in 5 minutes. Run this again if it expires.'
    Start-Process $url
} else {
    $response | Write-Output
}
