# Arrow Journey

曲がった矢印を順番に抜いていくパズルPWA。Vanilla JavaScript / SVG / IndexedDB、Viteで配布用ファイルを生成する。

## 起動

Node.js 22.12以降を使用する。

```sh
npm ci
npm run dev
```

本番ビルドとオフライン動作の確認:

```sh
npm run build
npm run preview
```

プレビューは `http://127.0.0.1:4173/`。Service Workerは本番ビルドだけに登録する。

## 機能

- Easy / Normal / Hard / Expertの各難易度で20/24/28/32角を生成。大きさと難易度を分離し、抜ける候補数・選択肢の推移・依存深さで調整。難易度の行を押すと新規開始。
- 長さ2〜30の片端矢印が盤面を100%占有。シード再現、構造検証、独立解法とDAGで全消去確認。
- 先端の直線上に残存矢印がなければ除去。胴体は元の経路に沿って移動。
- ミスによる終了・時間制限なし。ヒントは1盤面3回。同じ盤面状態の再表示は追加消費しない。
- 消去済みマスの中心に薄いドット。PC盤面のカーソルは人差し指で統一。ドラッグ・ピンチ・ホイール・ズームボタン。ドラッグや空白タップはミスに数えない。
- 途中盤面は端末内のみ。新規開始で置換。成績・設定と原子的に保存し、古いタブからの上書きを拒否。
- 4色の矢印、ライト/ダーク/端末連動、角丸の経路、移動演出・保存中の連続操作。BGM・効果音の個別ON/OFFと音量、動きを減らす設定。音はWeb Audioによるオリジナルの合成音。
- 盤面の連続タップによるブラウザー拡大を抑止。ゲーム内のピンチ・ドラッグ・ズームボタンを維持。
- オフラインで新規生成・再開。更新待機中は「更新」ボタンを表示し、保存後に切替。

## 検証

```sh
npm test
# 別ターミナルで npm run preview を起動してから:
npm run test:e2e
```

自動ブラウザー検証はインストール済みGoogle Chromeを使用する。Nodeの通常テストには各難易度×4サイズ×100シード・計1600盤面の全消去検証を含む。Firestore Emulatorによるルール試験は通常は明示的にskipする。実行方法は [INTEGRATION.md](docs/INTEGRATION.md) を参照。

## クラウドと公開の状態

0.3.1。公開先: [Arrow Journey PWA](https://nikoneco.github.io/Arrow-Journey/)。生成器3.0.0で可変サイズと候補数に基づく難易度を導入。矢印が占有する各マスの全体でタップを受け付け、線から離れた端や角も選択できる。公開・認証・同期の確認記録は [INTEGRATION.md](docs/INTEGRATION.md) に記載する。iPhone/Android実機の確認は別途必要。

- Arrow Journey専用FirebaseをSparkプランで作成。Google認証・本人UID別のFirestoreルールを設定。途中盤面は送信しない。
- `gas/` は公開読取API。実Sheetの4難易度metadataを匿名配信し、接続失敗時は同梱値を使う。ゲーム開始にGAS接続を要求しない。
- `nikoneco/Arrow-Journey` のGitHub Pages。manifestのIDは `/Arrow-Journey/`。数独の `/Sudoku/` と既存ルートIDは変更しない。
- `.github/workflows/pages.yml` はmainへのpushまたは手動実行で `dist/` を公開する。現在の依頼で新規公開まで承認済み。
- 管理ID、認証情報、接続先の完全仕様書は公開ソースへ追加しない。

仕様と実装判断: [IMPLEMENTATION.md](docs/IMPLEMENTATION.md)。外部接続と保存契約: [INTEGRATION.md](docs/INTEGRATION.md)。
