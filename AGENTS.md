# AIチーム

<!-- orca-ai-team:begin -->
## 0. 会話の始め方 (最初の返事の前に必ず)
1. 新しい会話では、最初の返事の前に prompts/kickoff.md を読み、その手順に従う。ユーザーの最初のメッセージが具体的な依頼でも同じ。
2. .ai/HANDOFF.md のやりかけを短くまとめ、「続き / 見直し / 新規」をユーザーに選んでもらう。答えを聞くまで作業・生成・worker起動をしない。
3. 続きでも新規でも、役ごとの候補表を見せ、使うAIをユーザーに確認してから作業に入る。
4. 例外: Orca から worker として起動され、Task契約が渡されている時はこの手順を飛ばし、Task に従う。

## AIチームの共通ルール (orca-ai-team が管理。この印の内側は手で直さない)
- ユーザーの現在の依頼を優先する。進行中のTaskで条件が曖昧になった時は、選択肢(A/B/C)と推奨を付けて聞いてから進める。
- workerは直接ユーザーに聞かず、Coordinatorへquestionで返す。Coordinatorがユーザーに聞く。
- 作業前に .ai/GOAL.md、LATEST.md、PLAN.md、HANDOFF.md、REVIEW.md を読む。
- Coordinatorだけが共有PLAN/HANDOFF/REVIEWを編集。workersは所有する別ファイル/reportのみ。
- git clean/reset --hard は使わない。コミットは対象だけ。pushはユーザーの指示がある時だけ。
- Run開始と起動前に scripts/refresh-latest.ps1 と scripts/check-budget.ps1 を実行する。
- AIの候補は config/ai-team.json。指名したAIがログイン切れ・枠切れ・契約切れで使えない時は、同じ役の次の候補へ自動で移り、理由をHANDOFFに書いてユーザーに伝える。契約が戻るかもしれないAIも enabled=true のままにする。
- 外部仕様の判断は公式情報を読み、.ai/EXTERNAL_DECISIONS.json に checked_at / sources / impact を記録する。
- モデル表は候補。catalog / 認証 / quota / launch.effective / Task成功は別の証拠。
- 短期・週・月の消費ペース、reset、上位枠、ticket期限を評価する。有料resetは自動購入しない。
- 軽量実装→テスト→別出自レビュー。ふだんのレビューは別出自1モデルで1回。重要変更 (kit/共通スクリプトなど広く配るもの) は最初から独立2モデルのreport提出後に比較する。修正後はテストで確認し、再レビューしない。同じ箇所を2回目に直すときだけ別出自のレビューを1つ足す。それでも直らなければユーザーに相談する。
- 実行前に orca skills get orchestration を読み、注入されたTask/Dispatch契約に従う。
- worker_doneの成功/失敗を区別し、受理したsettlementだけ release / reuse / retain する。timeoutは失敗・終了の証拠ではない。unknown / live の重複起動はしない。
- Orcaのボード: AIが動いている間はIn progress、ユーザーの判断待ちはIn review。起動成功でIn progress。作業を始める・再開するとき (Done後の再開も) は最初に scripts/board.ps1 working -RunId <run>。受理したworker_doneをrelease/ackした後に scripts/board.ps1 sync -RunId <run> (カードはプロジェクト全体で1枚。登録したRun (起動・working・明示操作をしたRun) のどれかが動いていればIn progress、全部が判断待ちになったらIn review、全部Doneならcompleted。登録していない古いRunはカードを動かせない。未確定・失敗・attentionはIn progressのまま、全員成功のみIn review。止めたRunは review か done で閉じる。進行役が自分の作業をまだ続けるなら sync せず、終わってから sync か review)。通常会話で依頼した作業が終わり人の確認待ちになったら scripts/board.ps1 review -RunId <run> -Note "短い理由" (Doneにしない)。ユーザーへの質問や承認待ちで会話が止まるときは scripts/board.ps1 pending -RunId <run> -Reason "短い理由" (Pending列が config の orca_board.pending_status で設定されていればその列、なければIn review + [AI] 判断待ち)。中断・失敗を明示するときは scripts/board.ps1 failed -RunId <run> -Reason "短い理由" (DoneやIn reviewに推測で進めない)。Doneはユーザーの明示承認またはpushの後だけ scripts/board.ps1 done -RunId <run>。Doneの前に python scripts/orchestration/team_control.py history suggest --run <run> (レビューの修正記録があれば --report <path>) を実行する。dispatchごとに、使ったAI・評価候補 good / ok / bad・そのAIの理由を1件ずつ見せ、ユーザーには「受け入れる / 変える」だけを聞く。承認なら python scripts/orchestration/team_control.py board done --run <run> --rate <dispatch_id>=<候補> --rate <別dispatch_id>=<候補> --rating-source ai-suggested --note "承認"、変更なら各 --rate をユーザー評価にして --rating-source user を使う。答えが無ければ --rate / --rating を付けず、評価を記録しない。--rating はRun全体への互換入力として残す。
- 書く係をレビューや別の書く係と同時に動かすときは、task file に "worktree": "new" を付けて新しいワークツリーで起動する (読むだけの係は付けない)。ワークツリーは手元の最新コミットから作られるので、起動前にその作業で触るファイルはコミットしておく (start の結果の uncommitted に注意)。終わったら差分 (git log / git diff) を見せ、ユーザーのOK後に main へ取り込み、orca worktree rm で片付ける。
- 使ったAIと結果は .ai/history/model-usage.jsonl に残る。Taskには work_type を付ける。
- 成果物を報告する時は、必ずクリックできるフルパスで示す (例: D:/Project/Output/run_20261001/sheet.png)。
- Jevだけで視覚合格・権限・MAX・worker解放を決めない。実機生成・独立レビュー未実施を完了扱いしない。視覚未確認はUNREVIEWED。
- 全チームでやったほうがいい改善に気づいたら、共通のしくみ (scripts/・prompts/・この印の内側) は直さず、Coordinator が .ai/TEAM_PROPOSALS.md に1件追記してユーザーに伝える。採用は orca-ai-team で kit/ を直して oat sync で配る。
<!-- orca-ai-team:end -->

