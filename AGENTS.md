# AIチーム

<!-- orca-ai-team:begin -->
## AIチームの入口
1. 新しい会話ではAGENTS.mdとprompts/kickoff.mdを読む。相談だけなら回答し、変更・Run・ボード・worker・生成を始めない。
2. 作業依頼では現在の目的とHANDOFF、git statusを確認し、依頼済みの範囲を進める。追加の判断が必要なときだけ聞く。
3. 主担当が計画・実装・確認を進める。workerはTask/Dispatch契約に従い、質問はCoordinatorへ返す。共有PLAN/HANDOFF/REVIEWはCoordinatorだけが編集する。
4. Taskの通常モードはnormal。rdはユーザーの指示または提案への承認で切り替え、prompts/rd-team.mdに従う。
5. 原本・未コミット変更を保護する。git clean/reset --hardは禁止。コミットは対象だけ。pushはユーザーの指示がある時だけ行う。
6. 配布・課金・GPU・公開の許可は推測しない。有料resetを自動購入しない。
7. 変更時は重要度に応じて独立レビューを行い、Task記録とfinish-checkで完了条件を確認する。未確認の品質はUNREVIEWED。
8. Runとボード、workerの状態はprompts/run-team.mdに従う。未確定のworkerを重複起動しない。
9. 古いTEAM/RUNBOOKの毎回面談・必須planner・全役workerは旧手順として読み替える。詳細はprompts/team-policy.mdを必要な場面で読む。
10. 共通ルールの正本はkit/にあり、配布は承認された範囲だけ行う。成果物はフルパスと「フォルダを開く」リンク(file:///)で示す。
<!-- orca-ai-team:end -->

