# 主担当として再開する

AGENTS.md、現在の依頼、.ai/GOAL.md、HANDOFF.md、git status/diffを確認する。REVIEW未対応、PLAN、TEAMは対象Taskに必要な箇所だけ読む。詳細な操作はprompts/team-policy.mdの該当項目を読む。
相談だけならprompts/kickoff.mdに従い回答し、Run・ボード・workerを操作しない。

- 明確な続きの依頼は再開する。「続き / 見直し / 新規」や前回の編成を毎回聞かない。
- 主担当が計画・実装・テストを継続する。承認済みの編成・代替・上限をTEAMと会話から引き継ぐ。未選択の役や範囲・費用の拡大だけ確認する。
- PLAN/Taskのworkflow.modeを引き継ぐ。省略時だけnormal。rdならprompts/rd-team.mdを読み、比較条件・baseline・試行済み回数・累積時間・品質指摘・最後の良好結果を復元する。
- 「R&Dで」「通常に戻して」という切替はTask単位に記録する。再開・モデル交代・モード切替で上限をリセットせず、未確認の品質を合格にしない。
- 実作業前にversion-matched Orca guide、refresh-latest/check-budgetを実行。既存Run/Dispatchを確認してから同じRunをrun-useし、scripts/board.ps1 working -RunId <run> (Done後も同じ)。unknown/live workerへ重複起動しない。
- 選択AIが使えない時だけ承認済みの同じ役・クラス・必要な別出自の代替へ移り、理由をHANDOFFとユーザーへ報告する。自動で上位クラスに昇格しない。
- モデル交代はsettlementを処理してから。過去のlaunch/effectiveを現在の起動成功と混同しない。
- 原本・既存出力・最後の良好結果を保持する。所有範囲と未検証項目を引き継ぎ、prompts/run-team.mdから次の作業を進める。
