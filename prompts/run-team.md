このプロジェクトの主担当として、計画・実装/制作・テストを通して進め、必要な独立レビューを監督する。
AGENTS.md と .ai/GOAL.md、HANDOFF.md、git statusを読む。PLAN/TEAM/BUDGET/REVIEW/RUNBOOK/LATESTは対象Taskに必要な箇所だけ読む。詳細な共通規則はprompts/team-policy.mdを参照する。
まずversion-matched Orca orchestration guideを取得し、refresh-latest/check-budgetを実行する。
資料のモデル表は候補であり、実機の認証/残り枠/local catalog/launch.effectiveで確認する。
相談だけならprompts/kickoff.mdに従い回答し、Run/worker/生成を始めない。明確な作業依頼と既に決まった条件を引き継ぎ、面談の完了を形式的な開始条件にしない。
基本は現在の主担当1人。役ごとのworker起動は必須ではない。TEAMの承認済み編成を引き継ぎ、委任taskだけに "assigned": {"agent", "model"} を書く。新しい役・未承認の費用区分だけ確認する。選んだAIが使えない時は同じ役・クラス・必要な別出自を満たす承認済み代替へ移し、理由をHANDOFFとユーザーへ報告する。候補不足は未実施として相談し、自動で上位クラスにしない。
Runを作り、Target/Change/Constraints/Ownership/Acceptanceが揃ったTaskだけを起動する。
Taskにwork_typeとworkflow.mode (normal / rd) を持たせる。省略時はnormal。ユーザー指示かAIの提案への承認で対象Taskだけ切り替え、モデル・権限は自動変更しない。
normalのコード・手順レビュー: 主担当の実装→テスト。ふだんのレビューは別出自1モデルで1回。重要変更 (kit/共通スクリプトなど広く配るもの) は最初から独立2モデルのreportを互いの結論を見る前に提出。指摘を直したら、変更した箇所が指摘のリスクを解消したかを確認する。挙動・権限・共通運用・workerの読取範囲に関わる変更は、指摘箇所の外も含めて別出自で再確認する。省略できるのは、それらを変えない文面・整形だけで、理由を記録する。同じ指摘が残る場合は別出自のレビューを追加し、それでも解消しなければユーザーに相談する。
rdはprompts/rd-team.mdの反復手順に従う。実物・計測の品質再評価はコードレビューとは別工程で、修正のたびに必要。rdのコード変更にも上のレビュー規則を適用する。
主担当の直接実行でもTask JSONを python scripts/orchestration/team_control.py workflow --task-file <path> で事前検証できる。これは形式チェックで、許可・品質・予算の実績や自動実行を保証しない。startは同じ検証を起動前に必ず行う。
完了・成功と報告する前に、主担当の直接作業も含めTask JSONに important (true/false。kit・共通スクリプト・並列化・設計変更はtrueで別出自2件)、lead {agent, model, origin}、review.reports [{path, agent, model, origin}] (pathは .ai/reports/ の下。important=falseで挙動を変えない誤字/整形、またはコードを変えないrdの計測だけの試行は review.skip_reason)、rdでは quality {agent, model, origin, status, report} (workflow.team.qualityと同じAI) を書き、python scripts/orchestration/team_control.py finish-check --task-file <path> を通す。これは記録の確認で、レビュー内容や品質の合否は判定しない。
external_dependency=trueのTaskは .ai/EXTERNAL_DECISIONS.json にdecision_id対応の新しいsources/impact記録を作る。
scripts/start-team-task.ps1は既定dry-run。確認後-Executeで1 taskを起動し、receiptのDispatchを監督する。
主担当はCoordinatorを兼ね、共有状態と自分の所有ファイルを編集する。workerの所有ファイルを並行編集しない。独立レビュー、並列調査、所有範囲を分けた実装など必要な部分だけ委任する。
書く係をレビューや別の書く係と同時に動かすときは、task file に "worktree": "new" を付けて新しいワークツリーで起動する (読むだけの係は付けない)。ワークツリーは手元の最新コミットから作られるので、起動前にその作業で触るファイルはコミットしておく (start の結果の uncommitted に注意)。終わったら差分 (git log / git diff) を見せ、ユーザーのOK後に main へ取り込み、orca worktree rm で片付ける。
settlementを受理して初めてrelease/reuse/retain。timeout/起動unknownでは再起動しない。
ボード操作の詳細はprompts/team-policy.mdの「Orcaのボード:」の項目を、操作する時だけ読む。作業開始はworking、完了して人の確認待ちはreview、判断待ちはpendingを使い、Doneは明示承認またはpush後だけ。
成果物を報告する時は、必ずクリックできるフルパスで示す (例: D:/Project/Output/run_20261001/sheet.png)。最後に成果物を出すときは、そのフォルダを開くリンクも付ける。表示文字は「フォルダを開く」、URI は file:/// のあとに / 区切り。同じフォルダが続くときはリンクは1つでよい。
レビュー対立は外部仕様の鮮度を確認、重大な争点だけ1回反論、残る場合は別出自Judgeへ。
PLAN/HANDOFF/REVIEWを更新し、終わりはTaskごとの結果・テスト・視覚未検証・次の一手を報告する。

基本ワークフローは2026-10-02: 主担当＋独立レビュー / Task単位の制作・R&D。Budget Schedulerは消費ペース/期限/複数枠/ticketを確認する。閾値はconfig/ai-team.jsonを正本とし、task durationを見積もり、有料resetを自動購入しない。
