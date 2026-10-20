param(
    [Parameter(Mandatory=$true)][ValidateSet('sync','done','pending','review','working','failed')][string]$Action,
    [string]$RunId,
    [ValidateSet('good','ok','bad')][string]$Rating,
    [string]$Note,
    [string]$Reason,
    [ValidateSet('ai-suggested','user')][string]$RatingSource = 'user',
    [string[]]$Rate,
    [string]$TaskFile,
    [string]$NoChange
)
. "$PSScriptRoot/ai-team-common.ps1"
$requiresRun = @('sync','done','pending','review','working','failed')
if ($requiresRun -contains $Action -and -not $RunId) {
    Write-Error "board $Action requires -RunId"
    exit 2
}
$boardArgs = @('board',$Action)
if ($RunId) { $boardArgs += @('--run',$RunId) }
if ($Rating) { $boardArgs += @('--rating',$Rating) }
if ($Reason) { $boardArgs += @('--reason',$Reason) }
$boardArgs += @('--rating-source',$RatingSource)
foreach ($dispatchRating in $Rate) { $boardArgs += @('--rate',$dispatchRating) }
if ($Note) { $boardArgs += @('--note',$Note) }
if ($TaskFile) { $boardArgs += @('--task-file',$TaskFile) }
if ($NoChange) { $boardArgs += @('--no-change',$NoChange) }
Invoke-TeamControl -TeamArguments $boardArgs
exit $script:TeamExitCode
