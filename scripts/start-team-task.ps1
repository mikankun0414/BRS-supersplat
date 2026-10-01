param([Parameter(Mandatory=$true)][string]$TaskFile, [Parameter(Mandatory=$true)][string]$RunId, [switch]$Execute, [string]$CoordinatorHandle)
. "$PSScriptRoot/ai-team-common.ps1"
$taskArgs = @('start','--task-file',$TaskFile,'--run',$RunId)
if ($Execute) { $taskArgs += '--execute' }
if ($CoordinatorHandle) { $taskArgs += @('--from',$CoordinatorHandle) }
Invoke-TeamControl -TeamArguments $taskArgs
exit $script:TeamExitCode
