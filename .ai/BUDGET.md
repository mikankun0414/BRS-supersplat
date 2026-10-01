# Budget Scheduler v2
採用元: Orca_AIチーム運用プラン_2026-09-30最新版_v2.md

scripts/check-budget.ps1 -Class STANDARD -Role coder -TaskMinutes 30 -Json

旧版70%/85%一律切替は廃止。config/ai-team.json のtarget/hard_stopで運用する。
|枠|target|hard stop|reserve|
|---|---|---|---|
|短期|93%|98%|0%|
|週|88%|95%|10%|
|月|83%月末|95%|10%|

同クラス・役割適性を先に制約し、期間経過率、targetに対する消費ペース、usable budget/time to reset、上位枠の安全性、小さなprovider偏りペナルティで順位を決める。
短期95%以上は15分以下の短Taskだけ。short98%、weekly/monthly95%は停止。チケットはhard stopを上書きしない。
windowMinutesとreset timestampから期間開始を導く。期間長/resetが不明ならpace_unknownと表示し、架空の月初やリセット日を使わない。
認証error・quota不明/15分超・local model未確認は自動起動を止める。候補ゼロで高価なクラスに自動昇格しない。
task durationは見積りであり、残り%からTaskの消費トークンを保証しない。model/effort/roleが適切な候補だけ比較する。

## reset ticket
Orca account list の rateLimitResetCredits を取得し、available/期限/枚数を保存。
近い期限、重要Task、短期と週枠がほぼ消費済み、通常resetがまだ先、をreset_review_recommendedとして提案する。
短期の自然resetが近い/期限が遠い/別providerの同クラス余剰が十分な場合は温存を検討。出力はreset_action=none。
無料ticketも自動消費しない。Coordinatorが最新の適用先・周期影響を確認して使用を判断。有料resetは自動購入せず、人の承認が必要。
Jev budget-escalationは助言であり、MAXや購入権限を作らない。

## 出力
selectedと互換top-level agent/model/effort、budget_reason、budget_state.windowsのpace/expiry/safety、banked_reset、alternativesを返す。
直近5 providerはreadyと確認した実Dispatch receiptから取得。dry-run/起動失敗は履歴に加えない。
Antigravity内部quota APIは未実装・disabled。Cursor expiredも除外。UNKNOWNを0消費扱いしない。
