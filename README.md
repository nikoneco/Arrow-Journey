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

- Easy 20×20 / Normal 24×24 / Hard 28×28 / Expert 32×32。難易度の行を押すと新規開始。
- 長さ2〜30の片端矢印が盤面を100%占有。シード再現、構造検証、独立解法とDAGで全消去確認。
- 先端の直線上に残存矢印がなければ除去。胴体は元の経路に沿って移動。
- ミスによる終了・時間制限なし。ヒントは1盤面3回。同じ盤面状態の再表示は追加消費しない。
- ドラッグ・ピンチ・ホイール・ズームボタン。ドラッグや空白タップはミスに数えない。
- 途中盤面は端末内のみ。新規開始で置換。成績・設定と原子的に保存し、古いタブからの上書きを拒否。
- BGM・効果音の個別ON/OFFと音量、動きを減らす設定。音はWeb Audioによるオリジナルの合成音。
- オフラインで新規生成・再開。更新待機中は「更新」ボタンを表示し、保存後に切替。

## 検証

```sh
npm test
# 別ターミナルで npm run preview を起動してから:
npm run test:e2e
```

自動ブラウザー検証はインストール済みGoogle Chromeを使用する。Nodeの通常テストには各難易度100シード・計400盤面の全消去検証を含む。Firestore Emulatorによるルール試験は通常は明示的にskipする。実行方法は [INTEGRATION.md](docs/INTEGRATION.md) を参照。

## クラウドと公開の状態

2026-10-20: ゲーム本体・端末保存・オフラインはローカル実装済み。Firebase専用環境は未作成で、`js/config.js` は未接続。設定画面でもGoogle連携が未設定であることを表示する。実アカウントでのGoogleログイン・複数端末同期、GAS配信、GitHub Pages公開、iPhone/Android実機は未確認。

- Firebase Authentication / Firestoreの接続処理・UID別ルール・同期テストを用意。途中盤面は送信しない。
- `gas/` は公開読取API。現在は端末生成のためゲーム開始にGAS接続を要求しない。
- 公開対象候補: `nikoneco/Arrow-Journey` のGitHub Pages。manifestのIDは `/Arrow-Journey/`。数独の `/Sudoku/` と既存ルートIDは変更しない。
- `.github/workflows/pages.yml` はmainへのpushまたは手動実行で `dist/` を公開する。新規公開の対象と承認、PagesのActions設定を確認してから使用する。
- 管理ID、認証情報、接続先の完全仕様書は公開ソースへ追加しない。

仕様と実装判断: [IMPLEMENTATION.md](docs/IMPLEMENTATION.md)。外部接続と保存契約: [INTEGRATION.md](docs/INTEGRATION.md)。
