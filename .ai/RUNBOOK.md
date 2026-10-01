# Runbook
必ずorca skills get orchestrationで実行中バージョンのガイドを読む。
scripts/refresh-latest.ps1、scripts/check-budget.ps1 -JsonをRun開始と起動前に実行。
Runは実際のCoordinator端末から作成。別端末IDや古いDispatchを借りない。
全起動にEXTERNAL_DECISIONS.jsonのrouting-baselineを要求。checked_at/sources/impactは24h以内。
Taskにはtarget/change/constraints/ownership/acceptance/role/classを記入する。
scripts/start-team-task.ps1はdry-run既定。契約とargvを確認し-Executeで1回起動。
成功receiptはresult.state=ready。失敗・unknownは保存してrecovery referenceを読む。重複起動しない。
Task完了はauthoritative worker_doneを受理して確認。timeoutは終了証拠ではない。
受理後にrelease/reuse/retainし、全messagesを処理してからDeliveryをackする。
worker-list --run <run-id> --terminal-state reclaimable --jsonが空であることを確認。
Orcaのボード: 起動成功で自動でIn progress。受理したworker_doneをrelease/ackした後に scripts/board.ps1 sync -RunId <run> (全員成功ならIn review、失敗・質問・作業中はIn progress)。ユーザーのOKまたはpushの後に scripts/board.ps1 done (Done)。
Orcaなしではファイル状態を引き継ぎ、Orca Task/Dispatch成功を偽造しない。
環境チェックは config/ai-team.json の doctor_checks に書く。
Quick CommandはREADMEの手順で手動登録。
