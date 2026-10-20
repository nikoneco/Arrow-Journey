# 保存・外部接続

## 端末保存

Arrow Journey専用のIndexedDB `arrow-journey-local-v1` を使う。`guest` と `uid:<Firebase UID>` は完全に別のプロファイルで、自動取り込みしない。各所有者に途中盤面は1件。

```js
const store = await openStore({ validateGame: validateSavedGame });
let profile = await store.read('guest');
// profile全体を複製し、盤面・summary・clear・設定をまとめて変更する。
profile = await store.write('guest', nextProfile, profile.revision);
```

`read`で未保存ならrevision 0の初期値を返す。`write`は保存済みrevisionと期待値を同一トランザクションで照合し、成功時だけrevisionを1増やす。最後の除去・成績・クリア記録・activeGameのnull化を1回のwriteへまとめる。保存が完了してから描画状態を受理する。

`StorageConflictError`は古いタブの上書きを拒否する。最新プロファイルを読み直してから再操作する。`CorruptDataError`は元データを消さずに停止し、`store.exportRaw(owner)`から元の値を取得できる。通常の保存や新規ゲームで破損データを初期化しない。保存形式変更時は別途移行処理を設計する。

プロファイル形式は `schemaVersion, ownerKey, revision, activeGame, summaries, clears, settings`。summaryはplayIdキーで `{playId,difficulty,misses,hintsUsed}`。clearは盤面fingerprintキーで `{boardFingerprint,playId,difficulty,misses,hintsUsed,completedAt}`。ミスとヒントの保存済み値は減少させない。集計値を保存・加算する代わりに、`aggregateStats`が重複のない記録から算出する。

設定項目は `bgmEnabled,sfxEnabled,bgmVolume,sfxVolume,reducedMotion`。`updateSettings(profile,patch,deviceId,now)`を使い、各項目を `{value,updatedAt,deviceId}` として記録する。今回の実装では項目ごとの更新時刻、同時刻ならdeviceIdの辞書順で統合する。仕様書の提案「クラウドの確定順」とは異なる実装定義であり、端末時計のずれが同項目の競合へ影響する。設定を再操作すると、既知の最大時刻より新しい時刻を割り当てる。

## 任意のGoogle連携

`initializeCloud(firebaseConfig,{onUser,onStatus})`は `{configured,currentUser,login,logout,sync,dispose}` を返す。未設定ならconfigured=falseで端末プレイは利用でき、login/syncはUNCONFIGUREDエラーとなる。Firebase SDKはnpmの固定版をビルドに含め、CDNを必須にしない。

`login`は利用者のクリックから呼ぶGoogleポップアップ認証。認証画面ではArrow Journey用プロジェクトとGoogleアカウントの選択だけを扱い、Drive・Sheets権限を求めない。Googleログインを有効にし、実際の公開ドメインをAuthenticationの承認済みドメインへ登録する。Firebase Web構成は公開可能な識別用設定であり、管理者鍵を置かない。

```js
const owner = ownerForUid(user.uid);
const snapshot = await store.read(owner);
const merged = await cloud.sync(owner, snapshot); // profileを直接返す
await store.write(owner, merged, snapshot.revision);
```

通信中のローカル更新でCASが競合したら、最新プロファイルから改めて同期する。古い結果をそのまま保存しない。同期開始時のUIDと世代を各非同期境界で照合し、アカウント切替後の結果を適用しない。アカウント切替時にはトップへ戻り、対象所有者の途中盤面だけを読み込む。

全summary・clear・設定のローカル台帳を永続的な送信待ちの集計元にして、同期ごとに再送する。成功後に台帳を削除しないため、応答喪失・再読み込み・オフライン・途中失敗で統計が失われない。クラウド成功と、返された統合結果のローカル保存成功を別々に扱う。再送量は履歴に比例するため、長期運用で履歴が増えた際は確認済み版の差分送信を追加できる。

クラウドへ送るものは `toCloudPayload`の許可項目だけ。途中盤面、セル列、シード、残存ID、除去履歴、ヒント位置、パン・ズームは送らない。プレイ要約は同IDの最大値、クリアはfingerprintごとの初回受理記録を正本とする。クリアの難易度や内容が競合しても二重計上しない。

Firestoreの領域:

- `users/{uid}/playSummaries/{playId}`：単調増加するミス・ヒント要約。
- `users/{uid}/clears/{boardFingerprint}`：作成後不変のクリア記録。
- `users/{uid}/preferences/app`：許可された5項目の設定。

`firestore.rules`は本人UIDだけを許可し、不明領域・余分なフィールド・不正値・削除を拒否する。公開前に対象のArrow Journey用プロジェクトを確定し、このルールをFirestoreへ反映して、本人・別UID・未認証・不正値のエミュレータ確認と実環境確認を分けて行う。数独用プロジェクトやルールは変更しない。

## GAS / Sheets

`gas/Code.gs`は公開読取APIの雛形。`GET ?action=health`、`meta`、`difficulties`のみ許可する。POSTはREAD_ONLY、その他のactionはUNKNOWN_ACTION。JSONPは64文字以内の単一識別子callbackだけを許可し、ドットや括弧を拒否する。トークン、ユーザー成績、管理IDは返さない。

Script Propertiesに `ARROW_SPREADSHEET_ID`（管理対象シートのID）と任意の `DISTRIBUTION_VERSION` を設定する。IDをソースや公開文書へ記入しない。`DifficultyProfiles`の公開列A:Gは `difficulty,width,height,minLength,maxLength,density,profileVersion`。ヘッダー完全一致と値域を検証し、内部列をそのままJSONへ変換しない。未設定またはタブなしならprofilesは空。シートの作成・変更・初期化APIは用意しない。

現在のゲームは端末生成で遊べるため、GAS接続はゲーム開始の必須条件にしない。管理プロジェクトへの反映、Script Properties設定、Webアプリ公開、Sheets更新はそれぞれ対象と承認範囲を確定して実施する。

## 現在確認した環境と未設定項目

ローカルでNode.js、npm、claspを確認した。Firebase CLIはグローバルPATHに存在しない。Arrow Journey用の既存Firebase接続設定やclasp連携ファイルは確認できていない。数独はFirebase Authentication/Firestore、IndexedDB、読取専用GASの構成を参照しただけで、ファイル・接続先・資格情報をコピー・変更していない。

外部接続にはArrow Journey専用FirebaseのprojectId、公開Web構成、Googleプロバイダー有効化、Firestore作成・地域、許可ドメイン、ルール反映先の確定が必要。GASには指定プロジェクトの現行ソース・Script Properties・Webアプリ実行URLの確認が必要。管理画面URLから実行URLを推測しない。本資料は外部環境の設定済み・公開済みを示さない。

公式資料: [Firestoreトランザクション](https://firebase.google.com/docs/firestore/manage-data/transactions)、[Googleログイン](https://firebase.google.com/docs/auth/web/google-signin)、[ルールのフィールド制約](https://firebase.google.com/docs/firestore/security/rules-fields)。

## ローカル検証

`node --test tests/storage.test.js tests/cloud.test.js tests/cloud.gas.test.js`で、IndexedDBの所有者分離・CAS・破損保持・単調増加、同期の再送・アカウント切替・盤面除外、GASの読取制限を確認できる。

ルール実行試験は `tests/cloud.rules.test.js`。ローカルFirestore Emulatorを専用の `demo-arrow-journey` で127.0.0.1に起動し、`FIRESTORE_EMULATOR_HOST=127.0.0.1:<port>`を指定する。`@firebase/rules-unit-testing`がプロジェクトにない場合、`ARROW_RULES_TEST_MODULE`へ既存の同パッケージのエントリーファイル絶対パスを指定できる。エミュレータ未指定の通常テストではこの1件だけ明示的にskipする。本番プロジェクトを指定しない。

初回実装では、ローカルのFirestore Emulator v1.22.0とOpenJDK 21を127.0.0.1:8197へ一時起動し、ルール評価と実SDK統合を含む19テストが成功した。本人・別UID・未認証、summary減少・ID変更・盤面混入、clearの不変性、設定の型・範囲・時刻競合を実際のルール評価で確認し、cloud.jsの実modular SDKトランザクションによる再送も確認した。終了後にエミュレータを停止し、8197の待受がないことを確認した。実FirebaseプロジェクトのGoogle認証・ルール反映、GAS実行URL・シートの実読取、スマートフォン認証は未確認。
