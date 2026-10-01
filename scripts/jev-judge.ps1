param([ValidateSet('classify-task','gate-handoff','triage-review','needs-max','review-conflict','budget-escalation')][string]$Mode='classify-task', [Parameter(Mandatory=$true)][string]$StateFile, [string]$Model)
. "$PSScriptRoot/ai-team-common.ps1"
$jevArgs = @('jev','--mode',$Mode,'--state-file',$StateFile)
if ($Model) { $jevArgs += @('--model',$Model) }
Invoke-TeamControl -TeamArguments $jevArgs
exit $script:TeamExitCode
