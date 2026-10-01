param([ValidateSet('FAST','STANDARD','STRONG','MAX')][string]$Class='STANDARD', [string]$Role='coder', [string]$ExcludeOrigin, [string]$MaxReason, [switch]$Json, [double]$TaskMinutes=30, [switch]$Important)
. "$PSScriptRoot/ai-team-common.ps1"
$taskArgs = @('budget','--class',$Class,'--role',$Role,'--task-minutes',[string]$TaskMinutes)
if ($Important) { $taskArgs += '--important' }
if ($ExcludeOrigin) { $taskArgs += @('--exclude-origin',$ExcludeOrigin) }
if ($MaxReason) { $taskArgs += @('--max-reason',$MaxReason) }
Invoke-TeamControl -TeamArguments $taskArgs
exit $script:TeamExitCode
