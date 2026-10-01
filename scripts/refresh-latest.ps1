param([switch]$FetchSources)
. "$PSScriptRoot/ai-team-common.ps1"
$taskArgs = @('snapshot')
if ($FetchSources) { $taskArgs += '--fetch-sources' }
Invoke-TeamControl -TeamArguments $taskArgs
exit $script:TeamExitCode
