このプロジェクト のAIチームを再開する。AGENTS.md、HANDOFF、REVIEW未対応、PLANとgit status/diffを先に確認。
続きか見直しかが決まっていなければ prompts/kickoff.md の判定から入る。計画を変える必要が出たら、作業を止めて kickoff の「見直し」に戻る。
作業に入る前に、役ごとに scripts/check-budget.ps1 -Role <役> -Class <区分> -Json を実行し、候補表 (役 / 前回の編成 / 今の推奨 / 次の候補 / 枠の状況 / 使えない理由と直し方) を見せて「前回のまま / 変える」をユーザーに確認する。答えを .ai/TEAM.md の「今回の編成」に書いてから作業に入る。
作業中に選んだAIがログイン期限切れ・枠切れなどで使えない時は、止めずに同じ役の次の候補へ自動で移す (check-budgetの assigned_unavailable)。移した理由をHANDOFFに書き、ユーザーに報告する。
refresh-latestとcheck-budgetを実行。既存Run/Dispatchを確認してから同じRunをrun-useする。作業に入る時に scripts/board.ps1 working -RunId <run> でカードをIn progressに戻す (Doneからの再開も同じ)。unknown/live workerへ重複起動しない。
既存の成果物や出力を上書きしない。担当の編集所有と確認済みテストを引き継ぎ、次の未完了Taskを進める。
モデル切替はsettled workerを処理後、新workerで行う。最新のmodel ID/quotaを再確認。
未検証の視覚QA/独立レビューを合格に書き換えず、実物で検証してから状態更新する。

採用プランは2026-10-01_v3 (v2を土台に始め方・面談・planner・ユーザー選択を変更)。Budget Schedulerは消費ペース/期限/複数枠/ticketを確認し、70/85%一律切替を使わない。task durationを見積もり、有料resetを自動購入しない。
