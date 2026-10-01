# Team
Coordinatorだけが共有PLAN/HANDOFF/REVIEWを編集する。
Coderは指定したファイルだけを編集。TesterとReviewer A/BとJudgeは原則reportのみ。
同一ファイルに複数writerを割り当てない。独立レビューは相手の結果を見る前にreportを提出する。
候補はconfig/ai-team.json。初期状態はdisabled。catalog/認証/quotaを確認して有効化する。
軽量Coder→テスト→別出自Reviewer。複数ファイル・重要ロジック・権限・並列処理は独立2モデル。
同種失敗1回は同クラス、2回はSTRONG、STRONG失敗でSol highを検討。MAXは明示した根拠が必要。
Jevは助言。キーなし・通信不可・低confidenceはCoordinatorが判定。
計画役(planner)はSTRONG以上。計画と振り分け案は prompts/plan-team.md でreportに書かせる。

## 今回の編成
kickoffでユーザーが役ごとに選んだAIを書く (役 / agent / model / effort / 理由)。未記入。

## プロジェクト固有のワークフローとスキル
最初から作らない。作業しながら、同じ手順を2回やったらスキルやworkflowにして、ここに一覧を足す。
