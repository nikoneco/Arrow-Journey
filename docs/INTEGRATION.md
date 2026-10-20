# 保存・外部接続

## 端末保存

Arrow Journey専用のIndexedDB `arrow-journey-local-v1` を使う。`guest` と `uid:<Firebase UID>` は完全に別のプロファイルで、自動取り込みしない。各所有者に途中盤面は1件。

```js
const store = await openStore({ validateGame: validateSavedGame });
let profile = await store.read("guest");
// profile全体を複製し、盤面・summary・clear・設定をまとめて変更する。
profile = await store.write("guest", nextProfile, profile.revision);
```

`read`で未保存ならrevision 0の初期値を返す。`write`は保存済みrevisionと期待値を同一トランザクションで照合し、成功時だけrevisionを1増やす。最後の除去・成績・クリア記録・activeGameのnull化を1回のwriteへまとめる。保存が完了してから描画状態を受理する。

`StorageConflictError`は古いタブの上書きを拒否する。最新プロファイルを読み直してから再操作する。`CorruptDataError`は元データを消さずに停止し、`store.exportRaw(owner)`から元の値を取得できる。通常の保存や新規ゲームで破損データを初期化しない。保存形式変更時は別途移行処理を設計する。

プロファイル形式は `schemaVersion, ownerKey, revision, activeGame, summaries, clears, settings`。summaryはplayIdキーで `{playId,difficulty,misses,hintsUsed}`。clearは盤面fingerprintキーで `{boardFingerprint,playId,difficulty,misses,hintsUsed,completedAt}`。ミスとヒントの保存済み値は減少させない。集計値を保存・加算する代わりに、`aggregateStats`が重複のない記録から算出する。

設定項目は `bgmEnabled,sfxEnabled,bgmVolume,sfxVolume,reducedMotion,arrowTheme,colorMode`。`updateSettings(profile,patch,deviceId,now)`を使い、各項目を `{value,updatedAt,deviceId}` として記録する。今回の実装では項目ごとの更新時刻、同時刻ならdeviceIdの辞書順で統合する。仕様書の提案「クラウドの確定順」とは異なる実装定義であり、端末時計のずれが同項目の競合へ影響する。設定を再操作すると、既知の最大時刻より新しい時刻を割り当てる。

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
- `users/{uid}/preferences/app`：許可された7項目の設定（旧5/6項目も読取互換）。

`firestore.rules`は本人UIDだけを許可し、不明領域・余分なフィールド・不正値・削除を拒否する。公開前に対象のArrow Journey用プロジェクトを確定し、このルールをFirestoreへ反映して、本人・別UID・未認証・不正値のエミュレータ確認と実環境確認を分けて行う。数独用プロジェクトやルールは変更しない。

## GAS / Sheets

`gas/Code.gs`は公開読取APIの雛形。`GET ?action=health`、`meta`、`difficulties`のみ許可する。POSTはREAD_ONLY、その他のactionはUNKNOWN_ACTION。JSONPは64文字以内の単一識別子callbackだけを許可し、ドットや括弧を拒否する。トークン、ユーザー成績、管理IDは返さない。

Script Propertiesに `ARROW_SPREADSHEET_ID`（管理対象シートのID）と任意の `DISTRIBUTION_VERSION` を設定する。IDをソースや公開文書へ記入しない。`DifficultyProfiles`の公開列A:Hは `difficulty,width,height,minLength,maxLength,density,profileVersion,sizes`。ヘッダー完全一致と値域を検証し、内部列をそのままJSONへ変換しない。未設定ならprofilesは空。シートの作成・変更・初期化APIは用意しない。

読取はAdvanced Sheets service v4の `Sheets.Spreadsheets.Values.get` を使い、OAuthスコープは `spreadsheets.readonly` のみ。`SpreadsheetApp.openById`はフル権限を要求するため使わない。manifestでAdvanced Sheetsを有効化し、Apps Script所有者が初回認可する。既存デプロイは保持して、本アプリ用の新しいデプロイを作る。

`js/public-config.js`の `loadPublicConfig(url,{timeoutMs:4500})` は `{source,reason,distributionVersion,profiles}` を返す。匿名fetch、失敗時のJSONPを合計の制限時間内で試し、オフライン・未設定・不正データは `source:'bundled'` へ戻す。受理するのはGASの `/macros/s/.../exec` HTTPS URLだけ。schemaVersion、配信版、4難易度の重複、公開フィールドを検証し、engineの版・旧寸法・サイズ配列・長さ上限下限・密度と一致しない値を拒否する。配信するmetadataで生成器のパラメーターを変更しない。現在の許可長は全難易度2〜30で、重み付きの長さ設定は上限下限を表すものではない。

現在のゲームは端末生成で遊べるため、GAS接続はゲーム開始の必須条件にしない。管理プロジェクトへの反映、Script Properties設定、Webアプリ公開、Sheets更新はそれぞれ対象と承認範囲を確定して実施する。

## 初回接続の実施記録

2026-10-20、利用者の指定したArrow Journey用GAS・既存Google Sheetsへ接続した。事前にシート全範囲のCellDataとスクリプトを読み、ローカルの非公開`.local`へバックアップした。既存GASは空のmyFunctionだけだった。数独のファイル・接続先・資格情報はコピー・変更していない。

既存の「シート1」（1000行×26列）を保持し、新しい `DifficultyProfiles!A1:G5` だけに公開メタデータを作成した。4難易度は20/24/28/32角、長さ2〜30、密度1、profileVersion 2.0.0。最終版への更新はG2:G5だけを変更し、A:Fの値・書式等と元のシート全範囲が同じことを再読取で確認した。値・ヘッダー書式・列幅はネイティブAPIで確認した。Google画面上の文字収まり確認は別途扱う。

Script Propertiesの接続先と配信版0.2.0を設定し、所有者が読取専用権限を認可した。独立レビュー後にAdvanced Sheetsを使う版をpushし、今回新しく作成したWebアプリデプロイだけをversion 3へ更新した。元からあった2つのデプロイは保持した。管理IDと復旧用ファイルは`.local`またはScript Propertiesだけに置き、公開実行URLはアプリの `js/config.js` から参照する。

匿名HTTPでhealth/meta/difficultiesの成功、配信版0.2.0、profileVersion 2.0.0を確認した。save/delete/import/admin/initはUNKNOWN_ACTION、POSTはREAD_ONLY、正規JSONPは成功、不正callbackはGoogleの入口でHTTP400となった。公開レスポンスにはシートID・スクリプト管理ID・ユーザー成績を含めていない。実際の公開URLを使うNode版 `loadPublicConfig` も `source:'remote'` として受理した。ブラウザーのCORS・JSONP実行、Pages表示、スマートフォン、Firebase認証と同期の実証はそれぞれ独立した確認とする。

公式資料: [Firestoreトランザクション](https://firebase.google.com/docs/firestore/manage-data/transactions)、[Googleログイン](https://firebase.google.com/docs/auth/web/google-signin)、[ルールのフィールド制約](https://firebase.google.com/docs/firestore/security/rules-fields)。

## 専用Firebaseの設定記録

2026-10-20、ChromeでArrow Journey専用の `arrow-journey-74d42` を新規作成。Sparkプラン、Analytics無効。Webアプリを登録し、公開Web構成だけをconfigへ設定した。Googleプロバイダー有効、承認済みドメインへ `nikoneco.github.io` を追加した。管理者鍵やアカウントメールを公開ソースに置いていない。

Firestore Standardのdefaultデータベースを東京 `asia-northeast1` に本番環境モードで作成。`firestore.rules` と空白・コメント以外が一致するルールを管理画面で公開し、公開済み表示と本文一致を確認した。匿名REST読取は403 PERMISSION_DENIED。本人の認証・書込・同期と別端末の挙動は、この設定完了や匿名拒否だけで検証済みとはしない。

## Pages公開と公開後の確認

公開URLは https://nikoneco.github.io/Arrow-Journey/ 。2026-10-20、コミット `3b0630c` をmainへpushし、GitHub Actions run `39433490044` のbuild/deployがsuccessで完了した。公開資産13件（HTML、JS、Worker、CSS、アイコン、manifest、SW）はすべてHTTP200、ローカルビルドとのSHA256一致。manifestの解決後ID・start・scopeはこのURLで一致し、数独のIDや公開先は変更していない。

公開URL専用に起動先を合わせたブラウザー試験5件が成功。ミス・ヒント・再開・新規置換、全消去と二重計上防止、390/354px、オフライン生成、旧タブ競合、除去中ホームを確認。Chromeでも公開Expertを開いて表示を確認した。実ブラウザーからGASへ送られた公開metadata読取のHTTP200、schema整合、配信版0.2.0を確認した。

ローカルの更新試験は待機SWの更新ボタンと保存保持、資産URL変更を伴う2版・2タブのオフライン生成、旧タブ更新後のキャッシュ整理を確認。これらは公開サービスへの意図的な二版切替実験とは区別する。通常Node試験45件成功、Firestore Emulator専用1件は通常skip。独立レビューは修正後35ファイル固定候補でPASS。

Googleアカウントへのログインは利用者から完了報告あり。Arrow JourneyアプリへのOAuthポップアップ選択と実同期は別の確認で、現在利用者のアカウント選択を依頼中。スマートフォン実機のタップ・音・インストール、物理的に別の端末間の同期は未確認。

## ローカル検証

0.3.1 (2026-10-21): iPhone/iPadのホーム画面PWAで、次の矢印をすぐタップするとブラウザーが拡大するという利用者報告への対策。CSSのtouch-action指定に加えて、盤面SVGのtouchstart/move/endとdblclickの既定動作を非passiveリスナーで抑止する。ゲーム入力は従来のPointer Eventsだけを使い、連続入力の間引きや待ち時間は設けない。ページ全体のuser-scalable/maximum-scale制限は追加しない。

WebKitには[touch-actionでダブルタップ拡大を抑止できない報告](https://bugs.webkit.org/show_bug.cgi?id=218015)があり、[Touch Events仕様](https://www.w3.org/TR/touch-events/#the-touchstart-event)の既定動作キャンセルを盤面内に補完した。ただし、その既知事例が利用者の端末で起きた現象の原因と実証したわけではない。

Node72成功・Emulator専用1skip。ローカルChromeでブラウザー15試験成功。390×844、isMobile/hasTouchの試験で40px以内の2本を300ms以内に実タッチ入力し、2本の保存、visualViewport.scaleの不変、既定動作の抑止を確認。CDPの2本指入力で盤面だけのピンチ、1本指ドラッグ、拡大/全体表示ボタン、ミス0を確認した。時間差の明示的な検証を追加した後も対象試験1件成功。Browser skillは一覧にないため既存Playwrightを使用。Windows Chromeのタッチ試験はiOS/WebKitのホーム画面PWA実機での実証と区別する。公開後に利用者端末での確認が残る。

0.3.0: 全難易度で20/24/28/32角を生成し、同じサイズ内の候補数と依存深さで難易度を分離。GAS公開schemaは2、profileは3.0.0、sizesを追加した。表示はライト/ダーク/端末連動、矢印は4色。colorModeを含む7項目設定に対応し、旧5/6項目は読み出し値だけ補完する。元の途中盤面、revision、設定時刻を維持する。旧0.2.xのJSは新しいキーを拒否するため、新版で7項目を保存・同期した後は旧タブも「更新」または再読込する。保存データを初期化しない。

消去済みセルの中心に薄いドットを描画。再開、パン・ズーム、明暗切替に追従する。PC盤面は線上・セル角・ドラッグ中をpointerで統一。保存中のタップも所有者・世代・プレイID付きのFIFOで保持し、次の矢印の操作を落とさない。画面やアカウントが変わった入力は適用しない。

通常Node72件成功・Emulator専用1件skip、ローカルブラウザー14件成功。生成器は4難易度×4サイズ×100シードの1,600盤面を別の除去判定と合法順でも全消去した。表示354/390px、明暗と4色の保存、端末表示の追従、カーソル、ドット、演出中の連続操作、意図的に保存を遅らせた場合の入力、オフラインと更新ボタンを検証した。専用demo-arrow-journeyのローカルFirestore Emulatorと実SDKは29件成功。これは本番アカウントの認証・同期やスマートフォン実機の証拠には含めない。

0.2.2: 角丸経路、4色arrowTheme、保存後に次の矢印を選べる並行演出を追加。旧5項目の端末設定は読み出し値だけ補完し、元データ・途中盤面・revisionを維持する。Firestoreのthemeは省略可能、存在後の削除は拒否、値は4IDに限定する。新アプリは旧クラウドへ安全に色設定を追加できる。旧0.2.1のJSは未知の設定キーを拒否するため、同じ端末の別タブで新6項目を保存した場合の最新プロファイル読込も、色が同期されたアカウントのクラウド同期も、アプリ更新が必要。元データを初期化せず「更新」または再読込で新しい版へ切り替える。

通常Node57件成功・Emulator専用1件skip、ブラウザー10件成功。同時に2本が移動する状態、通常演出ありの全消去、4色即反映と再読込、マス全体入力を確認。専用demo-arrow-journeyのローカルFirestore Emulatorと実SDKで24件成功。本番データへ試験書込はしておらず、終了後8197の待受停止も確認した。物理端末間の色同期と実スマートフォンはこの結果に含めない。

0.2.1の入力修正: 線から0.3マス以内という制限を、占有セルの正方形全体へ変更した。追加Node試験は四隅・共有境界・空き/除去/演出中・拡大移動・表示領域外を検証。追加ブラウザー試験は実マウスイベントとエミュレートしたタッチで、尾/胴体/先端の各4隅、除去後の空きマス、拡大後の端を検証した。通常Node48件成功・Emulator専用1件skip、ローカルブラウザー8件成功。Browser skillは一覧にないため、既存のPlaywright試験を使用した。PC1440×1000とモバイル幅354×780での結果であり、物理的なスマートフォンの確認ではない。

`node --test tests/storage.test.js tests/cloud.test.js tests/cloud.gas.test.js`で、IndexedDBの所有者分離・CAS・破損保持・単調増加、同期の再送・アカウント切替・盤面除外、GASの読取制限を確認できる。

ルール実行試験は `tests/cloud.rules.test.js`。ローカルFirestore Emulatorを専用の `demo-arrow-journey` で127.0.0.1に起動し、`FIRESTORE_EMULATOR_HOST=127.0.0.1:<port>`を指定する。`@firebase/rules-unit-testing`がプロジェクトにない場合、`ARROW_RULES_TEST_MODULE`へ既存の同パッケージのエントリーファイル絶対パスを指定できる。エミュレータ未指定の通常テストではこの1件だけ明示的にskipする。本番プロジェクトを指定しない。

初回実装では、ローカルのFirestore Emulator v1.22.0とOpenJDK 21を127.0.0.1:8197へ一時起動し、ルール評価と実SDK統合を含む19テストが成功した。本人・別UID・未認証、summary減少・ID変更・盤面混入、clearの不変性、設定の型・範囲・時刻競合を実際のルール評価で確認し、cloud.jsの実modular SDKトランザクションによる再送も確認した。終了後にエミュレータを停止し、8197の待受がないことを確認した。GAS公開・シート実読取の追加検証は上の接続記録に記載している。実FirebaseのGoogle認証・同期とスマートフォン認証は、このエミュレーター検証に含めない。
