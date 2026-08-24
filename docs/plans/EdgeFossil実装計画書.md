# EdgeFossil 実装計画書

作成日: 2026-08-24  
最終レビュー: 2026-08-24  
改訂: Revision 4（段階別USER-ACTION checkpointを反映）  
対象: EdgeFossil v0 から最初の一般公開版まで  
文書種別: 実行計画。構想・調査結果を、実装順序、成果物、合格条件、判断 gate に変換したもの

計画の承認範囲: P0–P1 は着手可能。P2以降は直前gateでscope、見積り、Cloudflare仕様を再確認して承認するrolling-wave planとする。

参照した設計・調査:

- [`Cloudflare Workersネイティブな「Fossilの後継」を設計する — 統合型SCMの再構成案.md`](../notes/Cloudflare%20Workersネイティブな「Fossilの後継」を設計する%20—%20統合型SCMの再構成案.md)
- [`EdgeFossil実装具体化のための深掘り調査メモ.md`](../notes/EdgeFossil実装具体化のための深掘り調査メモ.md)
- [`EdgeFossil単一プロジェクト版とDOなし構成の調査メモ.md`](../notes/EdgeFossil単一プロジェクト版とDOなし構成の調査メモ.md)
- [`EdgeFossilの追跡・公開・アクセス制御を分離する設計調査メモ.md`](../notes/EdgeFossilの追跡・公開・アクセス制御を分離する設計調査メモ.md)
- [`EdgeFossil実装前にユーザーが準備するものの調査メモ.md`](../notes/EdgeFossil実装前にユーザーが準備するものの調査メモ.md)

---

## 1. 計画の結論

### 1.1 最初に作る製品

最初の一般公開版は、次の形に限定する。

> **一つの deployment が一つの project を表し、local SQLite と Cloudflare 上の Repository Durable Object + R2 の間で完全な project state を同期できる EdgeFossil Single Edition**

初期 profile:

| profile | 位置づけ | 初回公開での扱い |
|---|---|---|
| `local` | offline-first の基礎 | 必須 |
| `single-static` | read-only公開・archive・portable formatの基準 | 必須 |
| `single-do` | browser writeと共同作業を持つ基準cloud authority | 必須 |
| `single-r2` | strict DO-freeの比較PoC | experimental。MVPのcritical pathにしない |
| `single-d1` | SQL型の代替authority | 要求が具体化するまで延期 |
| Multi Edition | 一serviceで複数project | Single Edition安定後 |

`single-do` を先にする理由は、artifact acceptance、ACL、realm head、ref CAS、projection、outbox を一つの SQLite transaction で説明できるためである。`single-r2` は依存productが少ない一方、journal、checkpoint、operation repair、GCを自作するため、最初の正しさの証明には不利である。

### 1.2 最初の公開版で実現する利用体験

```text
ef init
  ↓
編集、snapshot、checkpoint、履歴閲覧
  ↓
ef cloud init --profile single-do
  ↓
ef sync
  ↓
別端末からef clone
  ↓
Webでtimeline/files/issues/wikiを閲覧・更新
  ↓
ef export --view authority-complete
  ↓
Cloudflareなしでef verify / ef import
```

public project では、同じ project 内に最低二つの realm を持てる。

```text
public     匿名clone/Web/exportに含む
members    認証済みmemberだけが同期・閲覧できる
local      authorityへ一切送らない端末内履歴
```

`maintainers` と custom realm は data model で表現可能にするが、UIを含む正式supportは v1.1 へ送る。

### 1.3 実装のcritical path

```text
Executable specification
        ↓
Local repository + export/import
        ↓
single-static publish
        ↓
RepositoryDO + R2 write path
        ↓
resumable sync + conflict preservation
        ↓
realm別public/member view
        ↓
large blob + complete restore
        ↓
integrated Web UI
        ↓
security / reliability hardening
```

Cloudflare integrationから開始しない。artifact bytes、semantic root、bundleを先に固定し、localとcloudが同じprojectを別の物理storageで表せることを先に証明する。

### 1.4 この計画の運用方法

milestoneは大きな成果物の境界であり、そのまま一つの開発iterationにはしない。実作業は1–2週間のdemo可能なincrementへ分ける。

- 詳細化するのは常に「現在のincrement」と「次のincrement」まで。
- それ以降は成果物、exit gate、依存関係だけを維持し、直前gateで再見積りする。
- 一つのissueは通常0.5–3 engineer-days、最大5 engineer-daysにする。
- 5日を超えるissueは、仕様、実装、fixture、fault testなどへ分割する。
- engineer一人あたり同時に一つの実装issueだけを進行中にする。
- 週に一度main上のwalking skeletonをdemoする。
- 2週間ごとにscope、risk、計測値、未解決decisionをレビューする。
- increment planning時にSection 6.5の`USER-ACTION` triggerを確認し、該当する場合だけaccount ownerへその時点で必要な手順を提示する。
- billing、2FA、credential発行、domain/DNS変更はaccount owner本人が行う。実装担当者やautomationは、明示的な依頼なしに代行しない。
- red CI、未解決data corruption、privacy regressionがある間は新機能へ進まない。
- 連続2週間、仕様だけを書いて実行可能なtest/vectorが増えない状態を許さない。

この運用により、長いphaseの最後まで統合結果が分からない状態を避ける。

---

## 2. 成功条件と非目標

### 2.1 v0 core の成功条件

次の七条件をすべて満たした時、EdgeFossilの技術的核心が成立したと判断する。

1. Rust CLI と TypeScript Worker が同じlogical artifactから同じcanonical bytesとIDを生成する。
2. visible artifactは、検証済みblobだけを参照する。
3. mutationの再送、Queueの重複、response消失で副作用が増えない。
4. concurrent updateをlast-write-winsで黙って消さない。
5. local、cloud、exportで物理形式が違ってもsemantic rootが一致する。
6. public viewからmembers/local artifactのpath、hash、件数へ到達できない。
7. Cloudflare resourcesを空にした環境へcomplete bundleから復元できる。

### 2.2 最初の一般公開版の製品成功条件

- 一人の利用者が日常作業を `status`、`snapshot/checkpoint`、`sync` で完結できる。
- 二端末とcloudの三者間で中断・再開を含む同期が収束する。
- public sourceとmember-only fileを一projectで安全に管理できる。
- source、checkpoint、issue、wikiが一つのtimelineに現れる。
- public static siteと完全backupの両方を生成できる。
- repository ownerがCloudflare Dashboardで複数productを手作業設定せずにdeployできる。
- data loss、権限漏えい、互換性破壊を検出するautomated testがrelease gateに入る。

### 2.3 初回公開では作らないもの

- Git wire protocol互換
- GitHub互換PR、Actions、package/container registry
- 汎用CI runner
- Merkle trie、delta compression、cross-project deduplication
- project metadataの自動sharding
- arbitrary per-file ACL
- end-to-end encrypted sealed realm
- custom realmの複雑なDAG UI
- realtime共同編集
- AI/semantic search
- enterprise organization/SSO/billing
- browser内で巨大archiveを生成する処理

Git import/export bridgeは採用障壁に関わるが、canonical modelが固まる前に作るとEdgeFossil formatがGit都合へ引かれる。最初の一般公開後に追加する。

---

## 3. 固定するアーキテクチャ境界

### 3.1 state を三層に分ける

| state | 例 | clone/export | source of truth |
|---|---|---:|---|
| portable canonical | blob、tree、change、issue/wiki event、realm、signature | 対象 | artifact graph |
| authority operational | ACL、session、ref CAS generation、upload、idempotency、receipt、outbox | 通常対象外 | active authority |
| derived | timeline、current files/issues/wiki、FTS、static site、inventory summary | 再生成可能 | reducer output |

Cloudflare固有ID、DO SQLite raw dump、R2 ETag、Queue delivery状態をportable artifactへ入れない。

### 3.2 cloud の責務

```text
Edge Worker
  HTTP routing / auth / input limits / static assets
        │
        ▼
RepositoryDO
  ACL / realm validation / artifact acceptance / ref CAS
  receipt order / canonical projections / outbox
        │                         │
        │                         └── Queue + DLQ
        │                              notification / webhook / derived jobs
        ▼
R2
  PUBLIC_BLOBS      public content delivery
  RESTRICTED_BLOBS  Worker bindingからのみアクセス
  EXPORTS           temporary/generated bundles
```

Workflows は large export、restore、GC、migration が HTTP request の範囲を超えた段階で導入する。KV は authority、ACL、ref、idempotencyには使わない。

### 3.3 realm は最初のformatから入れる

後から公開範囲を追加すると、artifact ID、tree root、署名、public historyを変更することになる。従って v0 artifact body に `realm_id` を含める。

MVPのrule:

- realmごとにtree root、change DAG、refを持つ。
- public artifactからmembers/local artifactを参照できない。
- 一つのworking operationが複数realmを変更する場合、realmごとのchangeへ分割する。
- public projectionはpublic artifactだけから生成する。
- `tracking=local` objectはproject sync graphから参照できない。
- restricted→publicは新artifactを作るpromotionであり、metadata書換えではない。
- public→restrictedは将来の配布停止であり、過去公開の回収を約束しない。

### 3.4 storage key

| content | logical ID | physical key |
|---|---|---|
| public blob | SHA-256 | project-scoped hash key |
| restricted blob | SHA-256。realm外へ非公開 | random keyをDOのblob indexに保持 |
| staging | expected hash + upload session | random upload key |
| artifact body | SHA-256(canonical CBOR) | DO SQLite。必要なら将来R2へtiering |

restricted dataのcross-realm deduplicationは行わない。public/restrictedは別R2 bucket/bindingにし、restricted bucketでは`r2.dev`とcustom domainを有効にしない。

### 3.5 authority abstraction

coreから見えるinterfaceを早期に固定する。

```text
AuthorityStore
├ capabilities()
├ beginUpload()
├ finalizeUpload()
├ publishArtifacts(operation)
├ compareAndSwapRefs(operation)
├ inventory(view, cursor)
├ fetchArtifact(view, id)
├ fetchBlob(view, id)
├ export(view)
└ currentViewHeads(view)
```

最初の実装は `LocalAuthority` と `DurableObjectAuthority`。`StaticSnapshotAuthority` はread-only adapter。`R2JournalAuthority`は比較PoCで同じcontractを満たす。

---

## 4. repository 構成

現状は設計文書のみのgreenfield repositoryである。最初に次のmonorepoを作る。

```text
edgefoss/
├ Cargo.toml
├ package.json
├ pnpm-workspace.yaml
├ crates/
│  ├ ef-format/          canonical CBOR、ID、schema validation
│  ├ ef-core/            artifact graph、reducers、semantic root
│  ├ ef-store-sqlite/    local SQLite backend、migration
│  ├ ef-sync/            protocol state machine、retry/resume
│  ├ ef-cli/             `ef` binary
│  └ ef-testkit/         corpus、fault injection、synthetic repository
├ packages/
│  ├ protocol/           TypeScript codec/API types
│  └ ui-model/           view model。framework非依存部分
├ apps/
│  ├ worker/             Edge Worker、RepositoryDO、Queue/Workflow handler
│  └ web/                TypeScript + ViteのWeb UI
├ spec/
│  ├ artifact-v0.md
│  ├ bundle-v0.md
│  ├ sync-v0.md
│  ├ policy-v0.md
│  ├ errors-v0.md
│  └ vectors/             valid/invalid golden corpus
├ infra/
│  ├ wrangler.single-do.jsonc
│  ├ wrangler.single-static.jsonc
│  └ environments/       dev/staging/prodのresource manifest
├ tests/
│  ├ differential/
│  ├ convergence/
│  ├ leakage/
│  ├ fault/
│  └ e2e/
├ docs/
│  ├ adr/
│  ├ notes/
│  └ plans/
└ tools/                  corpus生成、bundle検査、benchmark
```

原則:

- Rust と TypeScript の実装を直接source共有しない。小さい永続仕様を両方で実装し、共通test vectorで差分検査する。
- generated schemaだけを真実にせず、人間が読めるnormative specを持つ。
- Web UI framework固有codeをprotocol/coreへ入れない。
- Cloudflare bindingをdomain logicへ直接伝播させずadapterで閉じる。
- dependency version、Wrangler config、Rust toolchainをlockfile/source controlで固定する。

---

## 5. 仕様化する v0

### 5.1 artifact kinds

実装順に絞る。

| stage | kind |
|---|---|
| core | `project.genesis`, `tree`, `change`, `checkpoint`, `tombstone` |
| integrated project | `issue.create`, `issue.patch`, `issue.comment`, `wiki.revision` |
| post-MVP | `thread.post`, `proposal.*`, `release.*`, `build.*` |

realmは全kind共通envelopeに持たせる。blobはraw bytes、artifactは小さいdeterministic CBOR objectとする。

### 5.2 canonical encoding

- hashは v0 では SHA-256だけを生成する。
- algorithm名をIDに含め、将来のalgorithm agilityを妨げない。
- RFC 8949 deterministic CBORをさらに制限したEdgeFossil profileを定義する。
- definite length、text map key、最短integer、duplicate key禁止、float/tag禁止。
- decode後の再encode bytesが入力と一致しなければrejectする。
- `artifact_id = SHA-256(canonical artifact body)`。
- 署名/attestation/server receiptはartifact bodyから分離する。

### 5.3 time と順序

- `created_at` は表示用で、認可やconflict winnerに使わない。
- artifactの因果順序はparentとlogical clockで表す。
- cloud受理順はauthority receiptの`repo_seq`。
- public/memberはrealmごとにtimeline sequenceを持ち、private eventによるpublic欠番を作らない。

### 5.4 path policy

- UTF-8 NFC、separatorは`/`。
- absolute、空segment、`.`、`..`、NULを禁止。
- Windows reserved name、末尾dot/space、case-fold collisionを検査。
- symlinkはmodeで明示し、checkout時にroot外escapeを拒否する。
- realmをまたぐ同一pathはMVPで禁止する。

### 5.5 semantic root

semantic rootは少なくとも次をbindする。

- project genesis ID
- format version
- realm別artifact set root
- realm別named heads/checkpoints
- portable policy version

authority receipt、repo sequence、FTS、cache、delivery stateは含めない。public exportのsemantic rootはmembers realmの変更だけでは変わらないことをproperty testにする。

---

## 6. milestone 計画

見積りは experienced engineer の実作業量を person-week で表した粗い範囲であり、納期の約束ではない。各phaseはexit gateを通るまで次のcritical phaseへ進めない。

### 6.1 phase と increment の関係

各phaseを次のincrementへ分ける。各incrementは単独でdemoでき、原則2週間以内に収める。表の順序は依存関係を表すが、test fixture、UI research、R1 spikeなど安全なread-only/experimental作業は並行できる。

| increment | demo可能な到達点 | 主な依存 |
|---|---|---|
| I0 | CI上で空のRust/Worker projectがtestされる | U0 |
| I1 | `project.genesis` がRust→TypeScript→Rustで同じIDになる | I0 |
| I2 | tree/change/realmのvalid・invalid corpusが両実装で一致する | I1 |
| I3 | localでinit→snapshot→checkpoint→export/importできる | I2 |
| I4 | EdgeFossil自身のnotesをlocal dogfoodできる | I3 |
| I5 | public bundleをstatic siteとしてdeployできる | I3、remote deploy時はU1 |
| I6 | 一つのsmall blob/artifactをstaging cloudへpublishできる | I2、I0、U1、U2 |
| I7 | response消失、重複、ref競合を含むcloud writeが安全 | I6 |
| I8 | 一端末からpull clone、続いてpush syncできる | I7、I3 |
| I9 | 二端末+cloudがdisconnect後に収束する | I8 |
| I10 | public/member viewがAPI、clone、exportで分離される | I9 |
| I11 | large blobとcomplete restoreが動く | I7、I9、direct upload採用時はU4 |
| I12 | read-only Web timeline/filesをcanary公開する | I10 |
| I13 | issueを同じartifact/timelineへ追加する | I12 |
| I14 | wiki、browser auth、searchを段階追加する | I13 |
| I15 | hardening済みrelease candidateを復元できる | I11、I14 |

### 6.2 早期walking skeleton

最初の6週間は仕様書を全面完成させることより、次の小さい縦切りを繰り返し太くする。

```text
Week 1
  repository/CI scaffold、ADR、空のRust/Worker test

Week 2
  project.genesis一種類だけのcross-language round trip

Week 3–4
  tree + path + public/members realm、invalid corpus

Week 5–6
  semantic root、最小bundle、local SQLite import/export
```

6週終了時に動くものが `project.genesis` だけでも、canonical bytes、cross-language compatibility、local persistence、bundle boundaryをend-to-endで通す。kindを横に増やすのはこの経路がgreenになってからにする。

### 6.3 依存関係上の停止規則

- G1未達ならlocal featureを増やさない。
- G2未達ならproduction-like cloud dataを作らない。
- G4未達ならbidirectional syncへ進まない。
- G5未達ならMerkle最適化やWeb writeを始めない。
- G6未達ならpublic canaryへrestricted test dataを置かない。
- G7のrestore drill未達なら一般公開日を決めない。
- experimental branch/profileの失敗でcritical pathを止めない。

### 6.4 dogfooding ladder

dogfoodingをP10まで待たない。利用範囲を段階的に広げ、各段階で戻せる既存手段を残す。

| 開始 | 対象 | 利用方法 | 失敗時のfallback |
|---|---|---|---|
| P2前半 | synthetic fixture | local commandだけ | fixture再生成 |
| P2後半 | EdgeFossilのnotes copy | local read/snapshot/export | 元repositoryを正本として維持 |
| P3 | 公開sample project | `single-static` read-only | static deployment rollback |
| P4 | 開発team一人 | stagingへのsingle-writer publish | local bundleから再作成 |
| P5 | 開発team二端末 | pull/push/sync | cloud read-only化、local export |
| P6 | 招待member | public/member canary | restricted route停止、token revoke |
| P8 | 少数外部tester | issue/wiki beta | feature flagでwrite停止 |
| P9 | EdgeFossil自身 | primary workflow候補 | 既存SCM mirrorを継続 |

dogfood dataを唯一のcopyにしない。G7のrestore drill完了までは、既存SCMまたはcomplete exportを並行のrecovery sourceとして保持する。

### 6.5 USER-ACTION checkpoint

Cloudflare accountやbillingを先に作り込まず、必要になるincrementの直前にだけaccount ownerへ依頼する。phase DRIまたは実装を支援するagentは、次のtriggerをincrement planningで確認する。

| ID | trigger | account ownerへ依頼すること | 完了証跡 | 未完了時 |
|---|---|---|---|---|
| U0 | P0/I0開始 | Node.js 24 LTSへ更新し、Git/Rust/pnpmを再確認 | version commandの値。秘密情報なし | I0を開始しない |
| U1 | P3、またはP3をlocalだけで終えた場合はP4で、初めてremote deployする直前 | Cloudflare account選択、2FA/recovery codes、project-local Wrangler OAuth、`workers.dev`設定 | account名を伏せてもよい`whoami`成功とdeploy先確認 | local/static buildは継続可、remote demoは停止 |
| U2 | P4aで最初のR2/DO resourceを作る直前 | R2 subscription checkout、data residency判断、`cloud:plan` review | subscription利用可、policy decision、承認したplan artifact | remote stateful sliceを開始しない |
| U3 | CI deploy jobを初めて有効にする直前 | account限定Cloudflare API tokenとaccount IDをCI secret/variableへ登録 | secret名、scope summary、作成日。値は記録しない | manual OAuth deployを継続しCI deployは停止 |
| U4 | P7aでdirect R2 upload方式を採用した時だけ | 対象bucket限定R2 S3 credentialsを発行しWorker secretへ登録 | credential名、bucket scope、作成日。値は記録しない | binding経由uploadを継続、direct uploadは停止 |
| U5 | P9でproduction topologyを確定する時 | custom domain採否、Workers Paid採否を実測から判断。採用時だけ設定 | decision record、domain healthまたはplan変更記録 | `workers.dev`/現planで成立するならblockしない |
| U6 | P10 production deploy直前 | production用token/secret、manual approval、backup責任者を最終確認 | redacted release checklist | production releaseを停止 |

#### checkpointを提示する形式

account ownerへは「Cloudflareを準備してください」だけで依頼しない。該当checkpointに到達したら、次の順で一つの作業票を提示する。

1. **なぜ今必要か**: この設定が必要になるincrementと、未実施なら止まる作業を一文で示す。
2. **今回行うことだけ**: dashboardのnavigation、copy可能なcommand、選択値を順番に示す。
3. **行わないこと**: まだ不要なplan、product、credential、domainを明記する。
4. **確認方法**: 期待する画面状態またはcommand結果を示す。tokenやrecovery codeの貼り付けを求めない。
5. **完了報告**: account ownerには成功/失敗と、秘密を除いた確認結果だけを返してもらう。
6. **記録**: gate evidenceへcheckpoint ID、日付、environment、非secretな結果を記録する。

画面名称やWrangler commandは変更され得る。作業票を提示する直前にCloudflare公式documentationとproject-local Wrangler versionで再確認し、調査メモの古い手順を機械的に転記しない。

#### promptの抑制

- trigger前にU2–U6の設定を促さない。
- `workers.dev`で要件を満たす間はdomain購入を促さない。
- Free planの実測範囲で要件を満たす間はWorkers Paidを促さない。
- WorkerのR2 bindingで足りる間はS3 credentialsを発行しない。
- D1、KV、Access、Turnstile、Workflows等は採用decisionができるまで準備項目へ加えない。

詳細なdashboard手順、秘密情報の保存先、troubleshootingは[`EdgeFossil実装前にユーザーが準備するものの調査メモ.md`](../notes/EdgeFossil実装前にユーザーが準備するものの調査メモ.md)を参照する。ただし、実行時には該当checkpointの必要部分を作業票へ再掲し、account ownerに文書全体から探させない。

### P0: bootstrap と設計決定（2–3 person-weeks）

実行状況（2026-08-24）: local scaffold、必須ADR、local check、dry-run build、commit `eb395ea`のGitHub Actions CIが完了し、G0はgo。詳細は[`G0 bootstrap evidence`](../evidence/g0-bootstrap-local-2026-08-24.md)を参照する。

開始checkpoint U0:

1. 実装担当者が先に`node --version`、`git --version`、`rustc --version`、`cargo --version`、`pnpm --version`をread-onlyで確認する。
2. Node.jsが`v24.`でなければ、account ownerへ次を案内する。PATH行は`~/.bash_profile`にまだない場合だけ追加し、既にv24ならinstallを促さない。

   ```bash
   brew install node@24
   echo 'export PATH="/opt/homebrew/opt/node@24/bin:$PATH"' >> ~/.bash_profile
   exec bash -l
   node --version
   pnpm --version
   ```

3. account ownerがversion確認結果を返し、gate evidenceへversionだけを記録する。
4. Cloudflare resource、R2 subscription、API tokenはこのcheckpointでは作らない。

成果物:

- monorepo scaffold、toolchain pin、CI skeleton
- contribution guide、coding conventions、release/versioning policy
- ADR templateと最初の必須ADR
- threat model v0
- `quality-targets.md`。correctnessは必須値、latency/costは仮説値として明示
- gate evidence template。command、commit、environment、result、artifact linkを記録
- `dev`、`staging`、`production` resource naming rule
- benchmark/fault testを実行できるtest harnessの骨格

必須ADR:

1. state三層分離
2. SHA-256 + deterministic CBOR
3. realm別artifact graph
4. `single-do` を最初のwrite authorityにする
5. public/restricted R2分離
6. upload-then-finalize
7. ref CAS
8. portable backupとPITRの分離

Exit gate G0:

- U0が完了し、pinned toolchainをlocalとCIで再現できる。
- CIがRust test、TypeScript test/typecheck、spec link checkを実行する。
- resource名と秘密情報の置き場所が文書化される。
- 仕様未決事項にownerとdecision deadlineがある。

### P1: executable specification（4–6 person-weeks）

P1で作るのは **v0 candidate** であり、外部互換性を約束するfreezeではない。実装前に曖昧さを減らす一方、local/cloud/syncで得た証拠を反映できる余地を残す。candidate bundleには`experimental` markerを入れ、一般利用者の永続dataとは区別する。

実行状況（2026-08-25）: I1–I2f、I3a–I3kはcommit/CI済み。I2fでrealm-isolated `bundle-v0`、Rust/TypeScript verifier、production codecに依存しないbundle readerが揃い、G1はgoとなった。P2 local repository critical pathではSQLite/CLIから3 realmの合成offline export/verify/import、process-kill recoveryまで確立した。I3kで10,000 filesと102,105 artifactsのrelease baselineを取得し、G2はgoとなった。詳細は[`I2f bundle evidence`](../evidence/i2f-bundle-local-2026-08-24.md)、[`G1 bundle reassessment`](../reviews/g1-bundle-reassessment-2026-08-24.md)、[`I3a local-store evidence`](../evidence/i3a-local-store-foundation-local-2026-08-24.md)、[`I3b CLI evidence`](../evidence/i3b-cli-init-status-local-2026-08-24.md)、[`I3c tracking evidence`](../evidence/i3c-working-copy-tracking-local-2026-08-24.md)、[`I3d snapshot evidence`](../evidence/i3d-working-snapshot-local-2026-08-24.md)、[`I3e checkpoint evidence`](../evidence/i3e-signed-checkpoint-local-2026-08-24.md)、[`I3f read-model evidence`](../evidence/i3f-realm-read-model-local-2026-08-24.md)、[`I3g public bundle evidence`](../evidence/i3g-public-bundle-local-2026-08-24.md)、[`I3h composed bundle evidence`](../evidence/i3h-composed-bundle-local-2026-08-24.md)、[`I3i transactional import evidence`](../evidence/i3i-transactional-import-local-2026-08-24.md)、[`I3j process-kill evidence`](../evidence/i3j-process-kill-local-2026-08-25.md)、[`I3k scale evidence`](../evidence/i3k-local-scale-baseline-2026-08-25.md)を参照する。

成果物:

- `artifact-v0`, `bundle-v0`, `policy-v0`, `errors-v0` draft
- Rust/TypeScript canonical encoder/decoder
- hash、Ed25519、path、realm flow validator
- 50個以上のvalid vectorと50個以上のinvalid vector
- semantic root calculator
- unknown kind/schemaの保存・reject rule

最低限のinvalid corpus:

- non-canonical CBOR
- duplicate key、deep nesting、oversize body
- wrong hash/signature/logical clock
- path traversal/case collision
- cross-project reference
- public→members reference
- project→local reference
- unknown required semantics

Exit gate G1:

- RustとTypeScriptが全vectorで同じbytes、ID、accept/reject codeを返す。
- public semantic rootがmembers-only inputに依存しない。
- specだけを読んだ第三者がvector verifierを実装できる程度に曖昧さが除かれる。

### P2: local repository alpha（7–10 person-weeks）

実行状況（2026-08-25）: I3a–I3kはcommit/CI済み。I3d–I3iでrealm別snapshot/checkpoint/read、3 realm合成bundle export/deep verify/transactional importを実装し、I3jの18 logical write pointで別processを実際に停止してSQLite integrityとtransaction原子性を確認した。I3kではformat上限内の3 realm accepted chainとdeep working treeを合成し、10,000 filesと102,105 SQLite artifactsのrelease command baselineを取得した。local exportの178–209秒が主要な性能課題であることもraw dataとして記録した。

成果物:

- local SQLite schema/migrations
- `ef init`, `status`, `track`, `snapshot`, `checkpoint`, `history`, `diff`
- blob store、tree builder、working-copy metadata
- `tracking=none/local/project`
- `public/members` classificationと`status --explain`
- local transaction/recovery
- `ef export`, `verify`, `import`
- issue reducerのCLI/test-only最小実装

CLIの最初のhappy path:

```text
ef keygen --output /safe/path/outside/project/owner.seed
ef init --actor-key <keygenが表示したactor-key>
ef track src/
ef track --realm members ops/runbook.md
ef track --local notes/private.md
ef snapshot
ef diff --realm public
ef checkpoint --realm public -m "Initial parser" --signing-key-file /safe/path/outside/project/owner.seed
ef history --realm public --limit 20
ef export --realm public --output public.edge
ef verify public.edge
ef import public.edge --path /path/to/empty-restore
```

local signing checkpoint U0.5:

1. 合成一時鍵を使うunit/E2E/CI中はuser作業を求めない。
2. 破棄不能な実データで最初の`ef init`を行う直前に、実装担当者はuserへ[`local署名鍵の手順`](../notes/EdgeFossil実装前にユーザーが準備するものの調査メモ.md#33-実データを扱う直前にlocal署名鍵を作る)を示す。
3. user自身にrepository外の保存先を選んで`ef keygen`を実行してもらい、permission、暗号化backup、表示されたpublic actor keyを確認してもらう。seed内容の貼り付けは求めない。
4. `ef init`後、最初の`checkpoint`直前にpublic messageが公開可能であることと、members/localは別commandであることを確認する。
5. このcheckpointではCloudflare account、Wrangler login、API token、R2、DOを求めない。

Exit gate G2:

- export → empty database import → exportでsemantic rootが一致する。
- write pointごとのprocess kill後もSQLiteが破損しない。
- untracked/local objectがproject exportへ入らない。
- 1万file、10万artifactのlocal fixtureで日常commandのbaselineを取得する。

現在の判定（2026-08-25）: 4条件すべてのlocal証跡とI3kのcommit/CI確認が揃ったためG2はgoである。P3 `single-static`のlocal buildを先に進め、remote deployの直前にU1のuser作業を案内する。

### P3: `single-static`（2–3 person-weeks）

実行状況（2026-08-25）: I4a〜I4eはcommit/CI済み。deep verify済みpublic bundleだけを受け取る決定的renderer、`ef static-build`、Worker script/bindingを持たないassets-only Wrangler profile、generated 404、3環境dry-run、実HTTP local smoke、bounded content chunk、recent timeline、complete bundleのrestore/re-export/site全byte一致、全deployable assetのHTTP response byte一致が揃った。U1はaccount ownerによる単一account選択、2FA/backup codes、intended accountへのproject-local Wrangler OAuth、macOS Keychain-backed encrypted storage、`workers.dev` subdomain設定をもって完了した。I4eではsynthetic public fixtureを`edgefoss-static-staging`へassets-only deployし、remoteの全6 deployable fileと生成byteの一致、security headers、404 body、`_headers`非公開、semantic root一致を確認し、commit `63f57c3`とGitHub Actions成功も確認した。production、R2、DO、Queue、custom domain、API tokenは対象外のままである。詳細は[`ADR 0021`](../adr/0021-deterministic-public-static-projection.md)、[`I4a evidence`](../evidence/i4a-public-static-projection-local-2026-08-25.md)、[`ADR 0022`](../adr/0022-assets-only-static-deployment-profile.md)、[`I4b evidence`](../evidence/i4b-assets-only-profile-local-2026-08-25.md)、[`ADR 0023`](../adr/0023-bounded-static-content-chunks.md)、[`I4c evidence`](../evidence/i4c-bounded-static-content-local-2026-08-25.md)、[`I4d evidence`](../evidence/i4d-static-regeneration-audit-local-2026-08-25.md)、[`U1 checkpoint`](../evidence/u1-cloudflare-access-checkpoint-2026-08-25.md)、[`I4e evidence`](../evidence/i4e-assets-only-remote-staging-2026-08-25.md)を参照する。

remote deploy開始checkpoint U1:

1. local static buildがgreenになってから、account ownerへCloudflare accountの選択と2FA/backup codesの保存を案内する。
2. P0で追加したproject-local Wranglerを使い、次を順に実行してもらう。

   ```bash
   cd /Users/dolphilia/github/edgefoss
   pnpm exec wrangler login --use-keyring
   pnpm exec wrangler whoami
   ```

3. Dashboardの`Workers & Pages`で公開用の`workers.dev` subdomainを設定してもらう。秘密やrestricted名称をsubdomainへ含めない。
4. 実装担当者は`whoami`のaccountが想定先であることを確認してからstaging deployを行う。account IDやtokenの貼り付けは求めない。
5. custom domain、R2、CI API tokenはこのcheckpointでは設定しない。

成果物:

- public bundleからstatic project snapshotを生成
- timeline/files/historyのread-only UI
- Workers Static Assets deploy profile
- large blob/bundleをR2へ分離できるmanifest
- Cloudflare以外のstatic hostでも表示できるoutput

Exit gate G3:

- Worker scriptなしでもpublic projectを閲覧できる。
- static outputがpublic realmだけから生成される。
- complete bundleから同じsite/semantic rootを再生成できる。
- artifact数増加時に一artifact一assetへ爆発しないchunk/paging方式が確認される。

現在の判定（2026-08-25）: 4条件すべてのlocal/remote証跡が揃ったためG3はgoであり、P3 `single-static`を完了した。P4a0のresource manifestと非mutating `cloud:plan`もlocal実装済みである。次はこの変更のcommit/CI確認後にU2を開始する。

### P4: `single-do` cloud authority vertical slice（7–10 person-weeks）

P4は一括実装しない。

| slice | 完了状態 |
|---|---|
| P4a0 readiness | resource manifest/provision commandをlocalで完成し、U2を通過 |
| P4a deployment | Worker、RepositoryDO、分離R2 bindingsがstagingで起動しhealth check可能 |
| P4b upload | small blobのstaging→verify→finalizeと再送が安全 |
| P4c publish | artifact acceptance、realm ref CAS、operation dedupeが一transaction |
| P4d recovery | outbox/alarm/Queue smokeとfailure matrixがgreen |

stateful resource作成checkpoint U2:

1. `cloud:plan`をresource作成なしで実行できる状態まで実装する。
2. account ownerへDashboardの`Storage & databases` → `R2` → `Overview`を開き、未契約ならcheckoutを完了してもらう。bucketはDashboardで作らない。
3. data residencyの法的・契約要件を確認してもらう。要件がなければR2はAutomatic、DO jurisdictionは指定なし、主利用地が日本ならDO location hintは`apac-ne`をplanへ記録する。
4. 次を実行してもらい、staging名、三つのR2 bucket、RepositoryDO、Queue/DLQ、jurisdictionをreviewしてもらう。

   ```bash
   pnpm run cloud:plan -- --env staging
   ```

5. 承認後にだけ、実装済みの次のcommandを案内する。

   ```bash
   pnpm run cloud:provision -- --env staging
   pnpm run cloud:verify -- --env staging
   ```

6. plan/provision/verify commandがまだ存在しない場合は実行を促さず、P4a0を未完了のままにする。

P4a0実行状況（2026-08-25）: staging/productionを分離した
[`resource manifest`](../../infra/cloud-resources.json)、fail-closedなvalidator、
非mutatingかつremote readもしないmachine-readable `cloud:plan`をlocal実装した。
staging plan digestは
`sha256:eb9e8f30df7070728d1e3aa433584b35b8a38bd82f03cbdd7bdfe8f181eede3d`
であり、preflightは意図どおり`USER_ACTION_REQUIRED / U2`で停止する。
`cloud:provision`と`cloud:verify`は未実装である。従ってP4a0のlocal readinessは
完了したが、U2は未通過でありstateful cloud mutationはまだ開始しない。詳細は
[`ADR 0024`](../adr/0024-reviewed-cloud-resource-manifest.md)と
[`P4a0 evidence`](../evidence/p4a0-cloud-plan-local-2026-08-25.md)を参照する。

CI deploy checkpoint U3:

- 最初のmanual OAuth deployとstaging smokeが成功してからCI deploy issueを開始する。
- その時点でだけ、account ownerへCloudflareの`Edit Cloudflare Workers` templateを起点としたaccount限定tokenの作成と、CIへの`CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`登録を案内する。
- 実際にCIが行うprovision/deploy operationにtemplate外のpermissionが必要なら、公式permission一覧で確認した必要最小scopeだけを追加する。
- token valueを完了報告、log、issue、repositoryへ貼らせない。

成果物:

- staging/productionのresource名、binding、jurisdictionを一つに定義するresource manifest
- 差分と作成対象を先に表示する`cloud:plan`、冪等な`cloud:provision`、作成後の`cloud:verify`
- 未完了checkpointをmutation前に案内するmachine-readable `USER_ACTION_REQUIRED` preflight
- stateless Edge Worker
- SQLite-backed `RepositoryDO`
- `PUBLIC_BLOBS`, `RESTRICTED_BLOBS`, `EXPORTS` R2 bindings
- owner bootstrap tokenとscoped API token
- small blob staging/finalize
- artifact publish transaction
- realm別ref CAS、ACL epoch、repo sequence
- operations idempotency table
- canonical timeline/current-files projection
- transactional outbox + DO alarm + Queue/DLQ
- machine-readable error model

canonical publish transaction:

```text
operation dedupe
  → current ACL/policy epoch確認
  → canonical bytes/hash/signature/realm/path検証
  → referenced blobs=verified確認
  → artifact/edges insert
  → realm head/ref CAS
  → canonical projection更新
  → receipt sequence採番
  → outbox insert
  → operation result保存
```

Exit gate G4:

- U2が完了し、承認済みresource planと非secretなverify結果がgate evidenceにある。
- staging resourceをDashboardで手作りせず、review済みplanからprovisionして再実行しても重複しない。
- R2 PUT、finalize、DO transaction、response、Queue送信の各境界でfailure injectionに合格する。
- 同じoperationを100回再送してcanonical side effectが一つになる。
- ACL revokeとconcurrent publishが一つのauthority orderへlinearizeする。
- visible artifactがmissing/unverified blobを参照しない。
- Queueを停止してもcanonical writeは成功し、復旧後outboxがdrainする。

### P5: sync v0（6–9 person-weeks）

P5は転送方向とconflictを分ける。

| slice | 完了状態 |
|---|---|
| P5a clone/pull | fresh local repositoryがcloudの一viewを復元 |
| P5b push | local artifact/blobをidempotentにcloudへpublish |
| P5c bidirectional | cursor resume、二端末、ref conflict、partial clone |

成果物:

- capability/version negotiation
- `HELLO/AUTH/INVENTORY/WANT/TRANSFER/PUBLISH/ACK/DONE`
- realm/view別paged inventory
- opaque cursorとresume token
- bounded batch、compression、retry/backoff
- promised blobを使う`metadata/source/history/complete` clone profile
- local A、local B、cloud間のconflict保持
- server receipt/accepted-rejected result

API原則:

- 全mutationに`operation_id`。
- cursor/tokenをproject、principal、view、policy epochへbindする。
- inaccessible artifactのhash、size、countを返さない。
- ref conflictは`409`とcurrent generationを返し、自動LWWしない。
- overload/retryableを区別し、jitter付きbackoffをclient libraryに一元化する。

Exit gate G5:

- random disconnect/timeout後にresumeしてartifact setが一致する。
- 同期順を変えた三者がcanonical setへ収束する。
- public cloneにmembersのpath/hash/artifact countが含まれない。
- expired/revoked credentialとstale cursorでrestricted contentを取得できない。
- million-artifact synthetic fixtureでv0 inventory costを計測し、Merkle導入要否の基準値を残す。

### P6: realm、公開経路、Web read model（5–7 person-weeks）

realmのformat自体はP1から入れる。このphaseでは公開surface全体を完成させる。

成果物:

- realm別tree/change DAG/timeline/search projection
- anonymous public viewとauthenticated member view
- `web=full/hidden`。metadata-onlyは延期
- public hashed blobのcache policy
- restricted responseの`Cache-Control: private, no-store`
- promotion/declassification operation
- distribution-stop operationとcache purge hook
- leakage test suite
- Web badgeとdangerous-action warning

Exit gate G6:

- public API、static output、export、search、Queue payload、log captureにrestricted path/hash/contentがない。
- members-only changeでpublic projectionがbyte-for-byte変化しない。
- `realm=members, replication=public` 等の危険な組合せをschema/authorityが拒否する。
- public→restricted UIが過去公開の回収を約束しない。

### P7: large blob、export、restore、GC（4–6 person-weeks）

| slice | 完了状態 |
|---|---|
| P7a large upload | multipart、quota、abort/orphan cleanup |
| P7b export/restore | cursor export、bundle verify、fresh environment restore |
| P7c GC | mark/grace/sweep、lease、dry-run、concurrent write test |

direct upload checkpoint U4:

- P7aの設計でpresigned URLによるdirect R2 uploadを採用した場合だけ発動する。
- account ownerへR2の`Manage API Tokens`から`Object Read & Write`、direct upload対象bucket限定のcredentialを作成してもらう。
- Access Key ID/Secret Access Keyは一度だけ安全に保存し、次のinteractive commandでWorker secretへ登録してもらう。値をcommand argumentへ含めない。

  ```bash
  pnpm exec wrangler secret put R2_UPLOAD_ACCESS_KEY_ID --env staging
  pnpm exec wrangler secret put R2_UPLOAD_SECRET_ACCESS_KEY --env staging
  ```

- direct uploadを採用しない場合はU4を`not applicable`として閉じ、credentialを作らない。

成果物:

- multipart/direct upload、quota reservation、short-lived capability
- server-side checksum/size verification
- orphan staging/final blob cleanup
- cursor-based complete export
- 必要になった時点でWorkflow orchestration
- bundle root/signature、offline verify
- mark/grace/sweep GC、dry-run
- fresh Cloudflare environmentへのrestore command/runbook

Exit gate G7:

- direct upload採用時はU4が完了し、非採用時は`not applicable`のdecisionが記録される。
- 100 MiB、1 GiB、multipart fixtureをWorker/CLIで全体buffer化しない。
- response消失後のfinalize再送が安全である。
- concurrent write中のGCがreachable objectを削除しない。
- Cloudflare resourcesを空にしたstagingへcomplete bundleから復元できる。
- public/member/authority-complete exportがそれぞれ正しいview rootを持つ。

### P8: integrated project Web beta（8–12 person-weeks）

P8は最もscopeが膨張しやすいため、次を独立release incrementにする。P8aを完了する前にP8bへ進まず、IssueとWikiを同時に実装しない。

| slice | user-visible release |
|---|---|
| P8a Web read alpha | timeline、files、history、diff。anonymous/member read |
| P8b Issue beta | issue create/patch/commentをartifact/timelineへ統合 |
| P8c Wiki beta | wiki revision/historyを同じreducer patternで追加 |
| P8d Auth/search beta | browser session、OIDC adapter、realm別最低限FTS |

成果物:

- timeline、files、history、diff
- issue create/patch/comment
- wiki revision/history
- public read、member write、owner adminのcapability分離
- browser session/OIDC adapterとCLI device token
- source/issue/wiki横断の最低限のFTS
- notificationはpolling/cursor catch-upを基準にし、WebSocketはoptional enhancement
- accessibility、responsive UI、Playwright E2E

Exit gate G8:

- source、checkpoint、issue、wikiが同じtimelineとartifact graphへ入る。
- public issue/wikiからrestricted artifactへ無断link/embedできない。
- 権限失効後にofflineで作ったartifactのpublishがrejectされる。
- browser reconnect後もauthoritative cursorから欠落なくcatch upする。
- keyboard操作と主要screen reader flowのE2Eが通る。

### P9: hardening と release candidate（6–9 person-weeks）

production topology checkpoint U5:

1. P4–P8のusage/cost/limit実測を提示し、Workers Paidが必要かaccount ownerに判断してもらう。具体的な不足がなければFreeを維持する。
2. 一般利用者へ安定したURLを提供する必要がある場合だけ、同じCloudflare accountのactive zoneにCustom Domainを設定してもらう。開発用にdomain購入を前提としない。
3. Custom Domain採用時はhostnameの既存DNS record衝突、certificate、HTTPS、rollbackをstaging相当で確認する。
4. `workers.dev`を無効化する場合はDashboard操作だけで終えず、`wrangler.jsonc`の`workers_dev: false`をsource of truthにする。

成果物:

- production threat-model review
- rate limit、quota、abuse control
- log/trace field allowlistとsecret redaction
- dependency/SBOM/license scan
- backup schedule、restore drill、incident runbook
- per-project cost/latency/storage telemetry
- schema/format migration rehearsal
- compatibility date更新手順
- CLI signed release、upgrade/rollback instructions
- public format/protocol documentation

Exit gate G9:

- U5のPaid/custom domain decisionと根拠がrelease recordにある。
- 30日相当のsynthetic soakまたは圧縮した長時間chaos testで不変条件違反がない。
- P95/P99、error rate、sync resume、outbox lag、restore timeにrelease thresholdが設定される。
- stagingでupgrade→write/read→rollback/forward-fix rehearsalに成功する。
- security-critical leakage/fault/property testsをrelease branchで必須化する。
- 別実装または独立verifierでcomplete bundleを検証できる。

### P10: first general release（3–4 person-weeks）

production release checkpoint U6:

- account ownerへrelease checklistのUSER-ACTION欄を提示し、production用token/secretの存在、scope、environment approval、backup責任者、recovery codesの保管を確認してもらう。
- credential値そのものは確認せず、secret名、scope summary、rotation/revoke手順が存在することを確認する。
- U6が未確認ならproduction deployを実行しない。staging artifactの検証は継続できる。

成果物:

- install/deploy/upgrade documentation
- example public projectとmember-only file example
- migration support policy
- format/protocol compatibility policy
- known limitationsとdata recovery guide
- dogfooding projectの運用開始

Release判定:

- U6が完了し、秘密値を含まないaccount-owner sign-offがある。
- G0–G9の証跡がrelease checklistから参照できる。
- blocker/critical既知不具合がない。
- backupからのrestoreをrelease candidate versionで再実施済み。
- public repositoryでrestricted test fixtureが全公開surfaceから非観測である。

---

## 7. parallel research track

### R1: `single-r2` CAS spike（P3後、2–3 person-weeks）

MVPのcritical pathと分離し、次だけを検証する。

- R2 `control/HEAD` conditional update
- immutable transaction chain
- 100 concurrent writer harness
- response消失とoperation ID retry
- checkpoint + tail replay
- authority readがCDN/cacheを通らないこと

Go条件:

- lost updateがない。
- project write envelopeが想定利用で許容できる。
- operation repair/checkpoint/GCを含めても`single-do`より運用上の価値がある。

No-go時:

- `single-r2` をexperimental designとして残す。
- personal profileも`single-do`をdefaultにする。
- portable format、CLI、exportには影響させない。

### R2: Git bridge（P7以降、2–4 person-weeks spike）

- Git commit/tree/blobとEdgeFossil public source realmの一方向mapping
- author/time/path portability
- merge commitとmultiple headの意味差
- issue/wikiを失わないproject exportとの区別

Go条件は、canonical modelへGit固有制約を入れずにsource historyのimport/exportができること。

### R3: sealed realm（一般公開後）

client-side encryption、key wrapping、revocation、search不可、promotion時scanを独立PoCにする。通常realm ACLの実装を待たせない。

---

## 8. cloud API v0

Single EditionではURLからproject selectorを省くが、wire artifactにはproject genesis IDを残す。

```text
GET  /api/v0/project
GET  /api/v0/capabilities
GET  /api/v0/views

POST /api/v0/uploads
POST /api/v0/uploads/{upload}/finalize

POST /api/v0/artifacts:publish
GET  /api/v0/artifacts/{artifact}
GET  /api/v0/blobs/{blob}

GET  /api/v0/refs
POST /api/v0/refs:compare-and-swap

POST /api/v0/sync/sessions
GET  /api/v0/inventory
POST /api/v0/want

GET  /api/v0/timeline
GET  /api/v0/files
GET  /api/v0/issues
GET  /api/v0/wiki

POST /api/v0/promotions
POST /api/v0/distribution-stops

POST /api/v0/exports
GET  /api/v0/exports/{export}
```

APIはOpenAPIだけで永続artifact formatを定義しない。HTTP APIはdeployment adapter、artifact/bundle/sync semanticsはCloudflareから独立したspecとする。

---

## 9. cloud schema の実装順

P4の最小schema:

```text
canonical / authority
  artifacts
  artifact_edges
  attestations
  receipts
  blobs
  realms
  realm_members
  refs                  PK(realm_id, ref_name)
  operations
  upload_sessions
  policy_versions
  outbox

derived
  timeline
  files_current
```

P8で追加:

```text
  issues_current
  issue_events
  wiki_current
  wiki_revisions
  search_fts_public
  search_fts_members
  sessions
```

schema rule:

- canonical rowとderived rowをtable名・migration・backup policyで区別する。
- artifact bodyを小さいBLOBとして保持し、大きな本文はR2 blob参照にする。
- 全realm-aware tableに`realm_id`を持たせる。
- public searchをmembers tableのquery後filterとして実装しない。
- `repo_seq` はauthority receipt orderでartifact IDに含めない。
- SQL migrationとreducer versionを独立してversion管理する。
- derived tableをdrop/rebuildするoperator commandを用意する。

---

## 10. test strategy

### 10.1 test pyramid

| layer | 主なtool | 対象 |
|---|---|---|
| format unit | Rust test / Vitest | canonical encode、hash、validation |
| property | proptest等 / property runner | graph、set、realm flow、reducer |
| differential | Rust CLI + Worker codec | bytes、ID、error code、projection |
| Worker unit | Workers Vitest integration | bindings、RepositoryDO、R2、Queue |
| Worker integration | production Worker build test harness | routeをまたぐHTTP flow |
| local E2E | shell/test harness | init→snapshot→export→import |
| cloud E2E | staging resources | upload→publish→sync→restore |
| browser E2E | Playwright | public/member UI、promotion warning |
| chaos/fault | ef-testkit | timeout、duplicate、reorder、kill、stale token |
| scale/cost | synthetic fixture | million artifact、large blob、concurrent CAS |

CloudflareのWorkers Vitest integrationはWorkers runtime内でR2やDurable Object bindingへ直接assertできるため、RepositoryDOのunit/integration testに使う。production buildとrouteを含む試験は別のintegration harnessとstaging smoke testで補う。

local testだけをproduction互換性の証拠にしない。Workers Vitest integrationがtest環境へcompatibility behaviorを補う場合があるため、`wrangler.jsonc`の実設定を使ったproduction build + `createTestHarness()` とremote staging canaryをgate evidenceに含める。

### 10.2 常時守るproperty

- canonical encodingは一意。
- set unionはidempotent、commutative、associative。
- reducerはvalid topological permutationで同じ結果。
- public graphからrestricted/local objectへ到達不能。
- capabilityを減らして見えるobjectが増えない。
- artifact acceptance前に参照blobがverified。
- ref CASはlost updateを起こさない。
- export/importでsemantic rootを保存。
- outbox/Queue/WebSocketの挙動はcanonical stateを変えない。
- GCはreachable objectを削除しない。

### 10.3 releaseで必須のfailure points

- staging R2 PUT 前後
- checksum verify 前後
- final object作成前後
- DO transaction 前後
- commit済みresponse消失
- outbox insert後、Queue send前後
- Queue duplicate/reorder/drop
- Workflow step retry
- ACL revokeとpublish競合
- sync cursor expiry/replay
- GC markとsweepの間
- public cacheに旧objectがある状態でdistribution stop

---

## 11. security plan

### 11.1 identity と capability

P4:

- deployment owner bootstrap secret
- hash化して保存するscoped API token
- actor public keyとprincipal binding
- roleは`reader`, `contributor`, `maintainer`, `owner`の小集合
- capabilityは`read`, `write`, `classify`, `declassify`, `publish`, `admin`へ展開

P8:

- OIDC provider adapterまたはpasskeyを評価しbrowser sessionを追加
- session cookieはsecure/httpOnly/sameSite policy
- roleだけでなくresource realmをauthorization inputにする

offline artifactは作成時刻ではなく、serverが受理する時点のACLで判断する。

### 11.2 restricted data

- restricted R2にpublic URLを付けない。
- restricted responseは`private, no-store`を明示する。
- presigned URLはbearer tokenとして短命・exact key/methodに限定する。
- 高機密または即時revoke要件ではWorker streamingを使う。
- path、artifact ID、presigned URL、message本文をlogしない。
- Queue、webhook、email、search index、error responseにもrealm projectionを適用する。
- build outputはinputの最もrestrictiveなrealmを継承する。build機能導入時の必須ruleとする。

### 11.3 abuse/resource limit

application limitはplatform上限より小さくする。初期候補は既存調査値を出発点にbenchmarkで調整する。

- artifact body、CBOR depth、parent/edge count
- publish/WANT batch
- path length
- small upload threshold
- per-principal concurrent upload
- project storage/operation quota
- pagination limit
- decompression ratio

unbounded inputやgraph traversalをHTTP requestに置かない。

---

## 12. deployment と operations

### 12.1 environments

```text
local     local SQLite + local Workers runtime
dev       開発者ごとのisolated resources
staging   production同等binding、synthetic data
prod      manual approval + immutable release artifact
```

Durable Object、R2、Queue等のbindingはenvironmentごとに明示し、production resourceをlocal/previewから参照しない。

### 12.2 Wrangler policy

- `wrangler.jsonc` をCloudflare構成のsource of truthにする。
- `compatibility_date` を必ず明示する。
- compatibility date更新は通常dependency updateと分け、full Worker test後にdeployする。
- 新規Durable Object class lifecycleは現行のdeclarative `exports` configurationを採用する。
- `exports` のdelete/rename/transferはdata lifecycleへ影響するため、Wrangler reconciliation output、binding参照、verified backupを確認するmanual approval対象にする。
- secretsをconfig/source controlへ書かない。
- generated binding typesをCIで再生成し、差分を確認する。
- static asset routeと`/api/*`のWorker-first routeを明示する。

### 12.3 deploy

`ef cloud deploy` または管理用toolが次を一つのdeployment operationとして扱う。

- Worker + Static Assets
- RepositoryDO export/binding
- public/restricted/export R2 bucket/binding
- Queue consumer + DLQ
- optional Workflow
- custom domain
- secret references
- jurisdiction/location policy
- backup/export schedule

management toolのpreflightは、該当するU1–U6が未完了ならresource mutationより前に停止し、machine-readableな`USER_ACTION_REQUIRED`と次を表示する。

- checkpoint IDと必要になった理由
- account ownerが開くDashboard pathまたは実行するproject-local command
- 選ぶべき最小scope/値と、今は選ばないoption
- secretを表示・貼り付けずに確認する方法
- 完了後に再実行するcommand

toolは2FA、billing checkout、API/S3 credential発行、domain/DNS変更を自動代行しない。`cloud:plan`は不足するUSER-ACTIONをread-onlyで列挙でき、`cloud:provision`は承認済みplanとcheckpoint evidenceがない限りpartial resourceを作らない。

最初は自作の一般IaC engineを作らず、version管理したWrangler configと小さいorchestration wrapperを使う。

### 12.4 observability

projectごとに次を測る。

- request/write rate、P50/P95/P99 latency
- DO overloaded/retryable error
- SQLite bytes、rows、rows read/written
- artifact/blob countとsize
- sync inventory bytes、missing ratio、resume回数
- outbox lag、Queue retry、DLQ depth
- R2 operations/storage
- export/restore duration
- public/restricted access denial

costは固定価格をproduct specへ埋め込まず、operation countから計算できるtelemetryを先に持つ。

quality targetをP9まで未定のままにしない。

- P2でlocal commandとbundle sizeのbaselineを記録する。
- P4でsmall publishのlatency/error/operation-count budgetを仮決定する。
- P5でclone/sync bytes、resume overhead、conflict rateを仮決定する。
- P7でexport/restore timeとlarge upload memory budgetを仮決定する。
- P9では新しく考えるのではなく、canary実績からrelease thresholdへ昇格・修正する。

correctness/security targetは平均値にしない。data loss、cross-realm leakage、invalid artifact acceptance、reachable objectのGC deletionはtest corpus上ゼロを必須とする。

### 12.5 backup と recovery

```text
Level 1  compensating artifact / undo
Level 2  local clone
Level 3  view-specific portable export
Level 4  authority-complete scheduled export
Level 5  DO PITR（metadata事故の最後の手段）
```

PITRはR2 blobとportable historyを一体で戻すbackupではない。release前にcomplete exportからfresh environmentへのrestoreを実演する。

---

## 13. engineering workflow

### 13.1 branch/change policy

EdgeFossil自身が使えるまでは通常のrepository workflowを使う。変更単位は小さくし、format/schema/security変更はADRとtest vectorを同じchangeに含める。

merge条件:

- format/protocol changeにspec差分がある。
- canonical behavior changeにRust/TypeScript vectorがある。
- schema changeにforward migrationとrebuild/rollback方針がある。
- security boundary changeにthreat-model差分とnegative testがある。
- Cloudflare binding/config changeにstaging smoke resultがある。

### 13.2 versioning

別々にversionを持つ。

- CLI/application release
- artifact format
- artifact kind schema
- sync protocol
- bundle format
- authority schema migration
- reducer version

application releaseを上げるだけで過去artifactを書き換えない。

### 13.3 Definition of Done

taskはcodeが動くだけでは完了しない。

- acceptance conditionを満たすautomated test
- error/timeout/retry behavior
- authorization/realm negative test
- metrics/logging。ただしrestricted fieldを含めない
- user/operator documentation
- `USER-ACTION`を伴う場合は、理由、最小手順、確認方法、秘密情報の扱い、未完了時の停止範囲
- migration/compatibility impact
- cleanup/rollback path

を含めて完了とする。

### 13.4 Definition of Ready

issueを進行中にする前に、最低限次を満たす。

- 一文で検証可能なoutcomeが書かれている。
- 対象外が明記されている。
- 依存issue/ADR/specが解決済み、または同じincrementに含まれる。
- happy pathだけでなく最低一つのnegative/failure caseがある。
- testをどのlayerへ追加するか決まっている。
- artifact/protocol/schema/realmへの影響が分類されている。
- 3日を超える見込みなら分割案がある。
- DRIとreviewerが一人ずつ決まっている。
- Section 6.5のtriggerに該当する場合、checkpoint ID、account ownerへ提示する作業票、必要になる日が決まっている。

仕様上の不明点を実装者が暗黙に補完しない。小さなspikeとしてtime-boxし、結果をADR/spec/test vectorへ戻す。

### 13.5 review cadence と可視化

| cadence | 内容 | output |
|---|---|---|
| 毎日 | mainのgreen確認、blocker、WIP | blocker ownerと次action |
| 毎週 | walking skeleton demo | 実行log、fixture、短いdecision note |
| 隔週 | increment review/planning | 次2週間のready backlog、再見積り |
| 月次 | risk/cost/restore review | risk register、cost baseline、restore result |
| gate時 | architecture/release decision | signed-off gate record |

進捗boardは `Ready / In Progress / Review / Verify / Done / Blocked` とする。`Review`はcode review、`Verify`はacceptance/fault/staging証跡を集める状態として分ける。

### 13.6 decision responsibility

teamの人数にかかわらず、責任を役割で固定する。

| decision | DRI | required reviewer |
|---|---|---|
| artifact/bundle compatibility | core/format lead | cloud lead + independent implementer |
| RepositoryDO/R2 correctness | cloud lead | core lead |
| realm/privacy behavior | security owner | core + Web owner |
| user-visible workflow | product/Web owner | CLI/core owner |
| Cloudflare account、billing、credential、domain | account owner（user） | phase DRIが最小手順と非secretな確認方法を提示 |
| gate通過 | current phase DRI | tech lead。privacy/release gateはsecurity reviewerも必要 |

一つのdecisionに複数DRIを置かない。異論が残る場合は期限付きspikeとacceptance resultで判断し、meeting consensus待ちにしない。

---

## 14. team と見積り

### 14.1 推奨最小team

| responsibility | 主担当 |
|---|---|
| artifact/core/local CLI | Rust engineer |
| Worker/DO/R2/sync | Cloudflare/TypeScript engineer |
| Web UI/product/accessibility | frontend/product engineer |
| property/fault/security | 全員。release前は独立review推奨 |

3人未満でも可能だが、format/coreとcloud authorityのcross-language differential testがserial bottleneckになる。

### 14.2 粗い規模

critical milestones P0–P10 のbase estimateは合計で約54–79 person-weeksである。これに未知のprotocol behavior、Cloudflare remote差異、security review、release engineeringへ25–30%のdiscovery/contingency reserveを置き、program envelopeを約68–103 person-weeksとする。reserveを通常featureへ先取り配分しない。

見積りに含むもの:

- code、test、spec、review、staging verification
- format/schema migration rehearsal
- fault/leakage/restore test

別途管理するもの:

- Cloudflare account/domain/legal準備
- design/brand/marketing/community運営
- 外部security auditの待ち時間・費用
- Git bridge、`single-r2`等のparallel research

目安:

- 1人: 16–24か月
- 2人: 11–17か月
- 3人: 8–13か月

これは専任、要件追加なし、Cloudflare account/CI/release signing等の準備が円滑という仮定である。人数で単純除算せず、P1、P4、P5の実測後にcalendar scheduleを更新する。critical pathのformat、authority、syncは並列化に限界がある。

### 14.3 進捗の測り方

percent completeではなくgateで測る。

| gate | 証明すること |
|---|---|
| G1 | 永続bytesを二実装で一致させられる |
| G2 | cloudなしでprojectを保存・復元できる |
| G3 | static hostだけでもprojectを公開できる |
| G4 | distributed writeの失敗でcanonical stateが壊れない |
| G5 | 中断・競合を含むsyncが収束する |
| G6 | restricted dataがpublic surfaceへ漏れない |
| G7 | large dataをexport/restore/GCできる |
| G8 | source以外も同じartifact systemで扱える |
| G9 | production運用とupgrade/recoveryが成立する |

### 14.4 risk register

`probability`と`impact`は開始時の相対評価である。隔週reviewで更新し、triggerが成立したriskには翌increment内のresponse ownerを割り当てる。

| risk | probability | impact | trigger | response | owner role |
|---|---|---|---|---|---|
| artifact formatを早く固定しすぎる | 中 | 極大 | local/cloud/syncでIDを変える必要が発生 | P1はcandidate、P6後にfreeze。experimental migrationを用意 | format lead |
| Rust/TypeScript codecが乖離する | 中 | 極大 | differential test不一致、error code差 | merge block、vectorを先に修正、unknown field ruleを明文化 | format lead |
| RepositoryDOとR2間でvisible missing blobが生じる | 中 | 極大 | fault testで参照切れ | publish停止、upload/finalize state machine修正、repair scan | cloud lead |
| public viewへrestricted metadataが漏れる | 中 | 極大 | leakage corpus、log、cacheから検出 | public route停止、token revoke/cache purge、root cause完了までrelease block | security owner |
| sync scopeが膨張する | 高 | 大 | Merkle/CRDT/deltaをG5前に要求 | paged inventoryとkind別conflictへ戻す。最適化をdecision gateへ | sync DRI |
| Web betaがmini GitHub化する | 高 | 大 | P8 sliceにIssueとWiki以外の新systemが入る | P8a–d WIP順序を守り、Proposal/CI等をpost-MVPへ | product owner |
| `single-r2`研究がMVPを止める | 中 | 中 | critical engineerが2週間超R1へ専有 | spike終了条件で停止し、`single-do` defaultを維持 | tech lead |
| cloud local emulatorとproductionに差がある | 中 | 大 | localとstagingでfailure/behavior差 | critical testをremote stagingでも実行、release前canary | cloud lead |
| large fixture/costが想定を超える | 中 | 中 | operation costまたはlatency budget超過 | fixtureを再現し、profile/limitを調整。価格でなくoperation数を記録 | cloud lead |
| restoreが手順依存で再現しない | 中 | 極大 | 別operatorのrestore失敗 | release block、restore command自動化、月次drill | operations owner |
| team capacity低下でWIPだけ増える | 中 | 大 | 2 increment連続でcarry-over > 30% | scopeを削り、WIP limitを1、parallel research停止 | tech lead |
| Cloudflare API/configが更新される | 中 | 中 | compatibility/changelogで利用機能変更 | gate前に公式docs/types/schema再確認、isolated update PR | cloud lead |

### 14.5 schedule control

- 通常incrementのcapacity目安をcritical path 70%、defect/test/documentation 20%、time-boxed research 10%とする。
- red CI、data integrity defect、privacy defectがある場合はresearch/new feature枠をrepairへ移す。
- 1 incrementで完了issue数よりcarry-overが多い場合、次incrementへ新epicを入れない。
- base estimateを15%以上超えたphaseは残作業を再分解し、program envelopeを自動消費しない。
- contingency reserveを50%消費した時点で、post-MVP項目とP8 scopeを再確認する。
- release日を固定するのはG7 restore成功後とし、それ以前はgate forecastだけを示す。
- schedule回復のためにformat compatibility、fault test、privacy gate、restore drillを削らない。

---

## 15. decision gates

### D1: artifact v0 candidate承認（P1終了）

Go条件:

- cross-language vector 100%。
- realmとsemantic rootが確定。
- bundle readerを独立実装可能。

No-goならlocal repositoryの実装へ進まず、specを修正する。この時点では外部互換性を約束しない。

### D2: DO authority viability（P4終了）

Go条件:

- failure injectionで全不変条件を維持。
- latency/costがtarget userに許容範囲。
- schema size growthの見積りがある。

No-goならD1またはR2 journalを比較するが、portable coreは維持する。

### D3: sync v0 viability（P5終了）

Go条件:

- three-way convergence。
- interruption resume。
- million-artifact baseline。

inventory転送が基準を超えた時だけprefix summary/Merkleを設計する。

### D3b: artifact/bundle v0 compatibility freeze（P6終了）

Go条件:

- local、cloud、sync、public/member Web/export view、promotionの全経路で同じartifactが使われている。
- P1以降に判明したschema変更がtest vectorとmigrationへ反映されている。
- experimental bundleをfinal v0へ変換するmigration toolまたは明示的な破棄方針がある。
- v0 reader/writer compatibility matrixとsupport期間が決まっている。

freeze後は、artifact IDを変える修正を通常のapplication updateとして行わず、new schema/versionとmigration decisionを必要とする。

### D4: privacy release gate（P6終了）

Go条件:

- leakage corpusが全surfaceで非観測。
- promotion/demotionの不可逆性がUI/CLIで明確。
- operator misconfiguration testに合格。

### D5: MVP release（P9終了）

Go条件:

- restore drill、upgrade rehearsal、security review、SLO threshold。
- projectの全canonical stateをCloudflareなしで検証可能。

---

## 16. 最初の backlog

P0/P1を開始するための最初のissue候補を、依存順に並べる。

この20件を一度に`Ready`へ入れない。開始時は1–4だけをready backlogとし、各隔週planningで次の最大4件をDoR確認後に移す。番号は優先順であり、issue sizeが5日を超える場合は着手前に分割する。

1. [完了] monorepo/toolchain/CI scaffold
2. [完了] ADR templateとdecision index
3. [完了] portable/authority/derived state ADR
4. [完了] artifact ID文字列表現ADR
5. [完了] deterministic CBOR profile draft
6. [完了] realm/capability information-flow ADR
7. [完了] path portability specification
8. [完了] semantic root specification
9. [完了] Rust canonical encoder skeleton
10. [完了] TypeScript canonical encoder skeleton
11. [完了] valid golden vector generator/reviewer
12. [完了] invalid corpus runner
13. [完了] Rust↔TypeScript differential test command
14. [完了] bundle manifest/container spike
15. [完了] local SQLite schema v0
16. [完了] process-kill/fault harness skeleton
17. Wrangler `single-do` dev configuration spike
18. RepositoryDO SQLite smoke test
19. public/restricted R2 binding isolation smoke test
20. project genesis end-to-end test

最初のcoding targetはWeb UIではなく、次の一往復にする。

```text
logical project.genesis
  → Rust canonical bytes/hash
  → TypeScript decode/verify/re-encode
  → Rust import
  → same artifact ID and semantic root
```

---

## 17. 実装開始後に更新する文書

| 文書 | 更新時点 |
|---|---|
| artifact/bundle/policy/error spec | format behavior変更ごと |
| ADR index | architecture判断ごと |
| threat model | trust boundary/API/realm追加ごと |
| compatibility matrix | CLI/protocol/format releaseごと |
| schema/reducer migration guide | migration追加ごと |
| cost model | staging benchmarkごと |
| SLO/runbook | P4以降、incident/rehearsalごと |
| implementation plan | 各decision gate後 |

この計画書は固定日程ではなく、gateで更新するliving planとする。ただしportable formatの互換性と公開済みdataの安全性は、日程都合で緩めない。

---

## 18. 最終提案

EdgeFossilの実装は、GitHub相当のfeature listを横に増やす進め方にしない。

最初に完成させるべき一本の縦切りは次である。

```text
raw bytes
  → realm付きcanonical artifact
  → local SQLite history
  → portable public/complete bundle
  → verified R2 blob
  → RepositoryDO acceptance + ref CAS
  → resumable realm-aware sync
  → public/member Web view
  → Cloudflareなしでrestore/verify
```

ここで証明するのは機能数ではなく、次の性質である。

- projectはsource以外も含む一つの複製可能なartifact graphである。
- cloudはauthorityになれるが、projectのportable identityではない。
- notification、cache、indexが壊れてもcanonical stateは壊れない。
- tracking、公開、Web表示、複製を安全に分離できる。
- 単一projectから始めてもMulti Editionや別authorityへformatを変えずに移行できる。

`single-static` は長期保存性を常に検査し、`single-do` は最小のcorrect cloud authorityを提供する。`single-r2` はDOを外すこと自体を目的にせず、実測で価値が証明された時だけ製品profileへ昇格させる。

この順序なら、最も難しい問題である永続format、同期、失敗時整合性、情報漏えいを早い段階で検証できる。一方、Issues、Wiki、Proposal、Realtime、AIなどは、同じartifact modelの上へ安全に追加できる。

---

## 19. Revision 2 review record

### 19.1 review 結果

初版は、architecture boundary、不変条件、fault test、release gateは十分に強かった。一方、そのまま実行すると次の運用上の問題があった。

| finding | severity | 初版の問題 | Revision 2での改善 |
|---|---|---|---|
| format freezeが早い | Critical | P1だけで外部互換性を固定しかねない | P1をcandidate承認、P6後をcompatibility freezeに変更 |
| phaseが大きい | High | 7–12週後まで統合結果が見えない可能性 | I0–I15の1–2週increment、P4/P5/P7/P8のsliceを追加 |
| dogfoodingが遅い | High | release直前まで実利用の摩擦を発見できない | P2からlocal、P3 static、P4 single-writerと段階導入 |
| P8 scope集中 | High | UI、Issue、Wiki、Auth、Searchを同時に抱える | P8a–dを順序付きrelease incrementへ分割 |
| 見積りbuffer不明 | High | 54–79 person-weeksがcommitmentに見える | 25–30% reserveを分離し68–103 person-weeks envelopeを提示 |
| execution rule不足 | Medium | issue粒度、WIP、review cadenceが未定 | DoR、最大issue size、WIP limit、週次demo、隔週planningを追加 |
| risk trigger不足 | High | riskは列挙されるが停止・対応時点が不明 | owner/trigger/response付きrisk registerを追加 |
| quality threshold決定が遅い | Medium | P9まで性能/運用基準が曖昧 | P2/P4/P5/P7で段階的baselineとbudgetを設定 |
| decision責任が曖昧 | Medium | gateが合議待ちになる可能性 | decisionごとに一人のDRIとrequired reviewerを定義 |
| recovery前の公開日固定risk | High | schedule都合でrestoreが後回しになり得る | G7まではrelease日を固定しない停止規則を追加 |

### 19.2 改訂後の評価

Revision 2はP0–P1を開始するには十分具体的である。着実に進めるための条件は次の三つである。

1. milestone完了率ではなく、毎週動くwalking skeletonとgate evidenceを優先する。
2. P1 candidateを実装結果に反して守らず、P6までは互換性を意図的にexperimentalとする。
3. privacy、fault tolerance、restoreを「hardeningで後から行う作業」に戻さず、各incrementのDoDに含める。

### 19.3 まだ実装開始後に確定すべき事項

次は現時点で数字を断定するより、fixtureとstaging計測後に決める方が安全である。

- local command、publish、sync、Web readのP95/P99 target
- artifact/publish batch、small upload、CBOR sizeのapplication limit
- DO SQLite growthとcost budget
- complete export/restoreの最大target project size
- public cache TTLとdistribution-stop operational target
- authentication provider/passkeyの最終選択
- `single-r2`を製品profileへ昇格するか

これらは未決のまま放置せず、`quality-targets.md`とdecision backlogにowner、仮説値、測定phaseを記録する。

---

## 20. Revision 4 USER-ACTION integration record

Revision 3では必要なaccount/resourceを調査メモへ分離し、P4のprovisioning成果物だけを計画へ反映していた。しかし、それだけでは実装中に「いつuserへ何を頼むか」が担当者の記憶に依存する。

Revision 4では次を計画の実行制御へ追加した。

- U0–U6をtrigger、最小作業、非secretな証跡、停止範囲を持つcheckpointとして定義した。
- P0、P3、P4、P7、P9、P10へ該当手順を配置した。
- account ownerに作業を頼む時の説明形式を標準化した。
- management toolがmutation前に`USER_ACTION_REQUIRED`を返すpreflightをdeployment計画へ追加した。
- DoR、DoD、exit gate、decision responsibilityへUSER-ACTIONを接続した。
- 未採用product、Paid plan、custom domain、S3 credentialを早期に促さない規則を明記した。

これにより実装担当者は必要な段階で案内を忘れず、account ownerは計画書全体や調査メモを読み直さなくても、その時点の最小作業と安全な確認方法を受け取れる。

---

## 参考資料

### Cloudflare Workers / testing / configuration

- [Workers testing](https://developers.cloudflare.com/workers/testing/)
- [Testing Durable Objects](https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/)
- [Workers Vitest test APIs](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/)
- [Workers testing integration harness](https://developers.cloudflare.com/workers/testing/test-harness/get-started/)
- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Install/Update Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- [Wrangler general commands and login](https://developers.cloudflare.com/workers/wrangler/commands/general/)
- [Workers compatibility dates](https://developers.cloudflare.com/workers/configuration/compatibility-dates/)
- [GitHub Actions deployment](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
- [Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Durable Object class exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)

### Cloudflare storage / background processing

- [SQLite-backed Durable Object Storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [R2 get started](https://developers.cloudflare.com/r2/get-started/)
- [R2 data location](https://developers.cloudflare.com/r2/reference/data-location/)
- [Durable Objects data location](https://developers.cloudflare.com/durable-objects/reference/data-location/)
- [R2 consistency model](https://developers.cloudflare.com/r2/reference/consistency/)
- [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/)

### Cloudflare publication / security

- [R2 public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/)
- [Workers cache configuration](https://developers.cloudflare.com/workers/cache/configuration/)
- [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)

### Standards / Fossil

- [Node.js releases](https://nodejs.org/en/about/previous-releases)
- [RFC 8949: CBOR](https://www.rfc-editor.org/rfc/rfc8949.html)
- [Fossil File Formats](https://fossil-scm.org/home/doc/trunk/www/fileformat.wiki)
- [The Fossil Sync Protocol](https://fossil-scm.org/home/doc/trunk/www/sync.wiki)
