Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:TeamRoot = Split-Path $PSScriptRoot -Parent
function Resolve-TeamPython {
    $configPath = Join-Path $script:TeamRoot 'config/ai-team.json'
    $config = Get-Content -Encoding UTF8 -LiteralPath $configPath -Raw | ConvertFrom-Json
    $python = [string]$config.python_exe
    if ([System.IO.Path]::IsPathRooted($python) -and (Test-Path -LiteralPath $python -PathType Leaf)) { return $python }
    $sibling = Join-Path (Split-Path $script:TeamRoot -Parent) $python
    if (Test-Path -LiteralPath $sibling -PathType Leaf) { return $sibling }
    $command = Get-Command $python -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    throw "Configured Python not found: $python"
}
function Invoke-TeamControl {
    param([string[]]$TeamArguments)
    $python = Resolve-TeamPython
    & $python -X utf8 (Join-Path $script:TeamRoot 'scripts/orchestration/team_control.py') @TeamArguments
    $script:TeamExitCode = $LASTEXITCODE
}
