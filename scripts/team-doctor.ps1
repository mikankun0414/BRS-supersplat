. "$PSScriptRoot/ai-team-common.ps1"
Invoke-TeamControl -TeamArguments @('doctor')
exit $script:TeamExitCode
