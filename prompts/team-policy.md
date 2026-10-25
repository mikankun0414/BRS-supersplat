# AIチームの詳細運用

相談では入口だけを読む。作業では対象の操作に必要な項目を参照する。Run・ボード・workerは運用項目、レビューはレビュー項目、配布はworktreeと配布項目を読む。

## 0. 会話の始め方
1. 新しい会話ではAGENTS.mdとprompts/kickoff.mdを読む。相談・質問はその場で答える。相談だけではファイル変更・Run作成・ボード操作・worker起動・生成をしない。
2. 作業依頼ならHANDOFFと現在の状態を確認し、依頼された範囲を進める。「続き / 見直し / 新規」を毎回聞かず、対象や意図が不明な時だけ質問する。既に答えたことや承認済み条件は聞き直さない。
3. 基本は現在の主担当1人が計画・実装・テストを担当し、必要な独立レビューを呼ぶ。承認済み基本編成はTEAMから引き継ぐ。初回の必要な役と、未承認の範囲・費用・権限の拡大だけ確認する。
4. Taskのworkflow.modeはnormal (通常・省略時の既定) / rd (制作・R&D)。「ここからR&Dで」「品質を見ながら繰り返して」「通常に戻して」などのユーザー指示でTask単位に切り替え、PLAN/HANDOFFに記録する。AIの切替提案は承認後に適用する。AIが自分でrdにしない。rdを始める前に主担当・品質担当 (別出自) のAI・モデルをユーザーに確認し、Taskのworkflow.approval / workflow.teamに記録する。
5. rdはprompts/rd-team.mdに従い、実物や計測→判断→修正→再評価を繰り返す。モード切替は生成・GPU・課金・配布・pushの許可や未解決指摘の解消を意味しない。
6. Orca workerとしてTask/Dispatch契約が渡されている場合は入口面談を行わず、契約の役割・所有範囲・モードに従う。
7. 共通の入口・編成・モード運用はAGENTS.mdの入口とprompts/を正本とする。印の外や古いTEAM/RUNBOOKに残る「毎回の面談・必須planner・全役worker」は旧共通手順として読み替える。プロジェクト固有の対象・品質条件は未確定時に確認し、GPU・費用・原本保護・配布・コミット・公開の許可条件は保持する。

## AIチームの共通ルール (orca-ai-team が管理。配布先は手で直さない)
- ユーザーの現在の依頼を優先する。成果・範囲・費用・権限を変える曖昧さだけ、選択肢と推奨を付けて聞く。通常の実装判断は主担当が進める。
- workerは直接ユーザーに聞かず、Coordinatorへquestionで返す。Coordinatorがユーザーに聞く。
- 作業前に .ai/GOAL.md、HANDOFF.md、git statusを読む。LATEST/PLAN/REVIEWなどは対象Taskに必要な箇所だけ読む。
- Coordinatorだけが共有PLAN/HANDOFF/REVIEWを編集。workersは所有する別ファイル/reportのみ。
- 主担当はCoordinatorを兼ね、自分が所有する実装・テストを直接行える。workerと同じファイルを同時編集しない。役ごとのworker起動は必須ではない。
- git clean/reset --hard は使わない。コミットは対象だけ。pushはユーザーの指示がある時だけ。
- Run開始と起動前に scripts/refresh-latest.ps1 と scripts/check-budget.ps1 を実行する。
- AIの候補は config/ai-team.json。指名したAIがログイン切れ・枠切れ・契約切れで使えない時は、同じ役の次の候補へ自動で移り、理由をHANDOFFに書いてユーザーに伝える。契約が戻るかもしれないAIも enabled=true のままにする。
- 外部仕様の判断は公式情報を読み、.ai/EXTERNAL_DECISIONS.json に checked_at / sources / impact を記録する。
- モデル表は候補。catalog / 認証 / quota / launch.effective / Task成功は別の証拠。
- 短期・週・月の消費ペース、reset、上位枠、ticket期限を評価する。有料resetは自動購入しない。
- normalのコード・手順レビュー: 主担当の実装→テスト。ふだんのレビューは別出自1モデルで1回。重要変更 (kit/共通スクリプトなど広く配るもの) は最初から独立2モデルのreport提出後に比較する。指摘を直したら、変更した箇所が指摘のリスクを解消したかを確認する。挙動・権限・共通運用・workerの読取範囲に関わる変更は、指摘箇所の外も含めて別出自で再確認する。省略できるのは、それらを変えない文面・整形だけで、理由を記録する。同じ指摘が残る場合は別出自のレビューを追加し、それでも解消しなければユーザーに相談する。
- 主担当が会話の中で直接作業した場合も、コードや成果物を変えたらTask JSON (.ai/tasks/) に important (true/false)・lead・review.reports (.ai/reports/ の下。rdは quality も) を書き、完了・成功と報告する前に python scripts/orchestration/team_control.py finish-check --task-file <path> を通す。通らなければ未完了として足りないものを報告する。ファイルサイズの一致を中身の一致と言わない。
- rdの実物・計測の品質再評価は上のコードレビュー回数制限とは別工程。変更した成果物を再評価し、未確認はUNREVIEWED。rdでもコードの重要変更には独立2モデルレビューを適用する。
- 実行前に orca skills get orchestration を読み、注入されたTask/Dispatch契約に従う。
- worker_doneの成功/失敗を区別し、受理したsettlementだけ release / reuse / retain する。timeoutは失敗・終了の証拠ではない。unknown / live の重複起動はしない。
- Orcaのボード: AIが動いている間はIn progress、ユーザーの判断待ちはIn review。起動成功でIn progress。作業を始める・再開するとき (Done後の再開も) は最初に scripts/board.ps1 working -RunId <run>。受理したworker_doneをrelease/ackした後に scripts/board.ps1 sync -RunId <run> (変更を含む作業は -TaskFile <Task JSON> を付ける。finish-checkを通らないsyncはIn reviewへ進めず「完了チェック待ち」でIn progressのまま。カードはプロジェクト全体で1枚。登録したRun (起動・working・明示操作をしたRun) のどれかが動いていればIn progress、全部が判断待ちになったらIn review、全部Doneならcompleted。登録していない古いRunはカードを動かせない。未確定・失敗・attentionはIn progressのまま、全員成功のみIn review。止めたRunは review か done で閉じる。進行役が自分の作業をまだ続けるなら sync せず、終わってから sync か review)。通常会話で依頼した作業が終わり人の確認待ちになったら scripts/board.ps1 review -RunId <run> -TaskFile <Task JSON> -Note "短い理由" (Doneにしない。reviewはfinish-checkを通ったTaskだけ。相談・調査だけでファイルを変えていなければ -TaskFile の代わりに -NoChange "理由"。doneもfinish-checkの代わりにならない)。ユーザーへの質問や承認待ちで会話が止まるときは scripts/board.ps1 pending -RunId <run> -Reason "短い理由" (Pending列が config の orca_board.pending_status で設定されていればその列、なければIn review + [AI] 判断待ち)。中断・失敗を明示するときは scripts/board.ps1 failed -RunId <run> -Reason "短い理由" (DoneやIn reviewに推測で進めない)。Doneはユーザーの明示承認またはpushの後だけ scripts/board.ps1 done -RunId <run>。Doneの前に python scripts/orchestration/team_control.py history suggest --run <run> (レビューの修正記録があれば --report <path>) を実行する。dispatchごとに、使ったAI・評価候補 good / ok / bad・そのAIの理由を1件ずつ見せ、ユーザーには「受け入れる / 変える」だけを聞く。承認なら python scripts/orchestration/team_control.py board done --run <run> --rate <dispatch_id>=<候補> --rate <別dispatch_id>=<候補> --rating-source ai-suggested --note "承認"、変更なら各 --rate をユーザー評価にして --rating-source user を使う。答えが無ければ --rate / --rating を付けず、評価を記録しない。--rating はRun全体への互換入力として残す。
- 書く係をレビューや別の書く係と同時に動かすときは、task file に "worktree": "new" を付けて新しいワークツリーで起動する (読むだけの係は付けない)。ワークツリーは手元の最新コミットから作られるので、起動前にその作業で触るファイルはコミットしておく (start の結果の uncommitted に注意)。終わったら差分 (git log / git diff) を見せ、ユーザーのOK後に main へ取り込み、orca worktree rm で片付ける。
- 使ったAIと結果は .ai/history/model-usage.jsonl に残る。Taskには work_type を付ける。
- 成果物を報告する時は、必ずクリックできるフルパスで示す (例: D:/Project/Output/run_20261001/sheet.png)。最後に成果物を出すときは、そのフォルダを開くリンクも付ける。表示文字は「フォルダを開く」、URI は file:/// のあとに / 区切り。同じフォルダが続くときはリンクは1つでよい。
- Jevだけで視覚合格・権限・MAX・worker解放を決めない。実機生成・独立レビュー未実施を完了扱いしない。視覚未確認はUNREVIEWED。
- 全チームでやったほうがいい改善に気づいたら、共通のしくみ (scripts/・prompts/・この印の内側) は直さず、Coordinator が .ai/TEAM_PROPOSALS.md に1件追記してユーザーに伝える。採用は orca-ai-team で kit/ を直して oat sync で配る。
