# EdgeFossil 単一プロジェクト版と DO なし構成の調査メモ

調査日: 2026-08-24  
位置づけ: 以下の設計・調査を前提とした追加検討

- [`Cloudflare Workersネイティブな「Fossilの後継」を設計する — 統合型SCMの再構成案.md`](./Cloudflare%20Workersネイティブな「Fossilの後継」を設計する%20—%20統合型SCMの再構成案.md)
- [`EdgeFossil実装具体化のための深掘り調査メモ.md`](./EdgeFossil実装具体化のための深掘り調査メモ.md)

## 1. 問題設定

現状案は、Cloudflare account 上で複数 project を管理し、project ID から対応する Repository Durable Object へ route する構成である。

しかし Fossil の利用形態を考えると、次の形にも独立した価値がある。

> 一つの deployment が、最初から最後まで一つの project だけを表す。

これは単に `projects` table の row が一つという意味ではない。

- URL root がそのまま project website になる。
- project selector、tenant routing、project registry がない。
- Cloudflare resources が一つの project 専用になる。
- owner が deployment と data を一体で所有できる。
- public archive、個人 project、小規模 team に最適化できる。
- 必要な整合性が小さければ Durable Object を外せる可能性がある。

本メモではこれを便宜上 **EdgeFossil Single Project Edition**、短く **Single Edition** と呼ぶ。

---

## 2. 結論

### 2.1 単一プロジェクト版は作る価値がある

Single Edition は multi-project 版の機能制限モードではなく、Fossil の self-contained project server に近い deployment model として成立する。

特に次の用途に合う。

- 個人開発
- 小規模 team
- OSS project の公式 site
- 長期保存する read-only archive
- GitHub などから独立した mirror
- Cloudflare account ごと引き渡せる project appliance
- EdgeFossil 自身の dogfooding repository

### 2.2 DO なしでも実現できる

ただし「DO なし」には二つの意味がある。

1. **application code が Durable Object binding/class を直接使わない。**
2. **EdgeFossil deployment が DO namespace を provision/bind せず、correctness の説明を DO semantics に依存させない。**

D1 は 1 を満たすが、Cloudflare の公式 D1 limits は、各 D1 database が一つの Durable Object に支えられていると説明している。従って 2 の意味では DO の性質から独立していない。

Cloudflare 各 product の非公開な内部実装まで「DO を一切使っていない」と証明することは本検討の範囲外とする。ここで厳密な DO なしとは、EdgeFossil が DO resource/APIを選択せず、R2の公開されたconsistency/conditional operationだけに依存するという意味である。

この意味で 2 を目指す場合、現実的な候補は次の二つである。

- read-only/static publish
- Worker + R2 conditional operations による optimistic CAS journal

### 2.3 推奨する三つの Single Edition profile

| profile | 構成 | write model | 想定用途 | EdgeFossilがprovisionするDO |
|---|---|---|---|---|
| `single-static` | Static Assets、必要ならR2 | build/deploy時だけ | archive、公開mirror | なし |
| `single-r2` | Worker + R2 | R2 HEADのCAS | 個人、小規模team | なし |
| `single-do` | Worker + RepositoryDO + R2 | DO SQLite transaction | rich collaboration | 直接利用 |

補助的な第四候補として `single-d1` を用意できる。

| profile | 構成 | 特徴 | 注意 |
|---|---|---|---|
| `single-d1` | Worker + D1 + R2 | SQL、FTS、transaction、read replica | D1内部はDO。WebSocket coordinatorはない |

### 2.4 最も重要な判断

Single Edition を別 format、別 CLI、別 UI として fork しない。

共通にするもの:

- `project.genesis` による project identity
- blob/artifact format
- hash/signature
- local SQLite
- sync protocol の意味
- portable bundle
- UI component

差し替えるもの:

- cloud authority implementation
- route shape
- deployment configuration
- collaboration capability

概念的には次の interface にする。

```text
AuthorityStore
├ DurableObjectAuthority
├ R2JournalAuthority
├ D1Authority
└ StaticSnapshotAuthority (read-only)
```

---

## 3. 単一 project にすると何が消えるか

### 3.1 削除できる責務

- project name → project ID lookup
- project list/search
- tenant/project registry
- project creation/deletion API
- project selector UI
- account 内 project quota allocation
- project ごとの DO ID resolution
- project ごとの R2 prefix routing判断
- custom domain と project の mapping table
- multi-project administrator dashboard
- project 間 invitation/navigation

URL は次のように短くなる。

```text
Multi Edition                  Single Edition

/p/{project}/timeline     →    /timeline
/p/{project}/files        →    /files
/p/{project}/issues/42    →    /issues/42
/api/v0/projects/{id}/... →    /api/v0/...
```

### 3.2 消えない責務

project が一つでも、複数 writer が存在すれば次は必要である。

- artifact validation
- content verification
- ref lost-update prevention
- ACL と権限失効
- idempotency
- concurrent issue/wiki update の conflict rule
- upload staging/finalize
- portable export
- GC と retention
- notification の重複耐性
- authority receipt order

従って、**single project だから coordination が不要になるわけではない**。coordination の頻度と機能要求が小さい時に、R2 の一つの CAS point へ縮約できるということである。

### 3.3 残すべき project ID

一 deployment 一 project でも、artifact から project field を削除しない。

`project.genesis` artifact ID を portable project ID として維持する。これにより次が可能になる。

- Single Edition から Multi Edition への移行
- mirror 同士が同じ project か確認
- 誤った repository への artifact push を拒否
- export bundle の identity 検証
- Cloudflare deployment URL が変わっても project identity を維持

Single Edition は「project ID が不要」なのではなく、「routing のたびに project ID を選ばなくてよい」形である。

---

## 4. Profile A: `single-static`

### 4.1 構成

```text
Local EdgeFossil repository
       │
       │ export / build
       ▼
Static project snapshot
├ index.html / UI assets
├ project manifest
├ current tree metadata
├ issue/wiki/thread indexes
└ optional downloadable complete bundle
       │
       ▼
Cloudflare Workers Static Assets
       +
R2 for large blobs/bundles (optional)
```

Cloudflare Workers Static Assets は、static asset request を無料・無制限で配信でき、SPA fallback も設定できる。API Worker を持たない完全 static deployment も可能である。

参考:

- [Workers Static Assets billing and limitations](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)
- [Static Assets SPA routing](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)

### 4.2 write model

browser/API から project state を変更しない。

write は次のいずれかに限定する。

- local CLI で変更 → build → deploy
- CI が signed export を受け取り deploy
- mirror job が upstream bundle を検証して deploy

deploy 単位が一つの immutable project snapshot になる。

### 4.3 長所

- Durable Objects、D1、Queues、Workflows が不要。
- server-side auth/session が不要。
- 最小の attack surface。
- 運用 cost と故障点が最小。
- project site と complete bundle を同じ release として固定できる。
- 長期 archive と public OSS mirror に向く。
- Cloudflare 以外の static host へ同じ output を配置できる。

### 4.4 制約

- Web UI から issue/comment/wiki edit はできない。
- build/deploy 前の変更は公開されない。
- artifact 数だけ static files を作ると asset file count/size limits に達する。
- private project の細かな認可には別の access layer が必要。

従って生成物は、一 artifact 一 static file ではなく、paged index、bundle chunk、必要なら R2 object として配置する。

### 4.5 この profile の位置づけ

`single-static` は collaboration server ではない。しかし次を実証する重要な profile である。

> EdgeFossil project は、常時稼働する stateful service がなくても完全に閲覧・検証できる。

これは portable format と長期保存性の acceptance test にもなる。

---

## 5. Profile B: `single-r2`

### 5.1 成立根拠

R2 は object write/read/delete/list に strong consistency を提供し、Workers binding と S3 API の `PUT` は `If-Match`、`If-None-Match` などの conditional operation を持つ。

この二つを組み合わせると、一つの小さい mutable object を optimistic compare-and-swap point として使える。

これは Cloudflare が R2 を一般 database として推奨しているという意味ではない。以下は strong consistency と conditional PUT から導く **EdgeFossil 固有の設計上の推論**である。

参考:

- [R2 consistency model](https://developers.cloudflare.com/r2/reference/consistency/)
- [R2 Workers API conditional operations](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [R2 S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/)

### 5.2 基本モデル

R2 上の大半を immutable にし、可変 object を `control/HEAD` 一つに限定する。

```text
R2 bucket
├ control/
│  ├ HEAD                         mutable, CAS only
│  ├ transactions/{generation}/{transaction_hash}
│  ├ checkpoints/{checkpoint_hash}
│  └ operations/{operation_id_hash}
├ artifacts/sha256/{prefix}/{artifact_hash}
├ objects/sha256/{prefix}/{blob_hash}
├ staging/{upload_id}
├ exports/{export_id}
└ acceleration/
   ├ inventory/
   └ search/
```

portable artifact/blob と authority transaction を分ける。

### 5.3 `control/HEAD`

`HEAD` は小さい deterministic object とする。

```json
{
  "format": "edgefossil-single-head",
  "version": 0,
  "project": "sha256:project-genesis",
  "generation": 1842,
  "transaction": "sha256:latest-authority-transaction",
  "checkpoint": "sha256:latest-checkpoint",
  "updated_at": "2026-08-24T12:34:56.789Z"
}
```

`HEAD` body の hash ではなく、R2 が返す現在の ETag を CAS token として使う。

重要な規則:

- `HEAD` は R2 binding/S3 endpoint から読み、CDN cache された custom domain response を authority read に使わない。
- update は常に `If-Match: <observed-etag>`。
- project 作成時のみ `If-None-Match: *`。
- unconditional overwrite を行う code path を持たない。
- `HEAD` は bucket lock 対象にしない。immutable prefix だけを retention 対象にする。

R2 の custom domain cache を通すと consistency が緩和されるため、public blob delivery と authority access の endpoint を分ける。

### 5.4 authority transaction

一回の project mutation を immutable transaction record にする。

```json
{
  "format": "edgefossil-authority-transaction",
  "version": 0,
  "project": "sha256:project-genesis",
  "generation": 1842,
  "parent": "sha256:previous-transaction",
  "operation_id": "0198...",
  "principal": "ed25519:...",
  "artifact_additions": ["sha256:..."],
  "ref_changes": [
    {
      "name": "main",
      "expected": "sha256:old",
      "new": "sha256:new"
    }
  ],
  "acl_changes": [],
  "accepted_at": "2026-08-24T12:34:56.789Z"
}
```

transaction record は authority receipt/history であり、artifact ID の一部ではない。別 authority へ移行しても portable artifact ID は変わらない。

### 5.5 write algorithm

```text
1. GET control/HEAD → body + ETag E0
2. HEADが指すcheckpoint/transactionsからcurrent authority stateを読む
3. 現在のACL、schema、blob、ref precondition、operation IDを検証
4. generation+1、parent=current transaction のimmutable transaction T1を生成
5. PUT transactions/.../T1 with If-None-Match: *
6. PUT control/HEAD(new=T1) with If-Match: E0
7a. success → operation receiptを補助indexへ書きresponse
7b. precondition failed → 新しいHEADを読み、再検証してretryまたは409
```

step 5 だけ成功し step 6 が競合で失敗した場合、T1 は orphan transaction になる。canonical state は変わらず、grace period 後に GC できる。

step 6 が成功した後に response が失われた場合、client は同じ `operation_id` で再送する。Worker は次の順で accepted result を探す。

1. `operations/{hash(operation_id)}` の補助 receipt。
2. current HEAD から recent transaction chain。
3. checkpoint 作成中の repair index。

HEAD chain に operation が見つかれば副作用を再実行せず、receipt index を修復して同じ結果を返す。

### 5.6 なぜ CAS で ref/ACL も守れるか

すべての可変 authority state が同じ HEAD generation に基づく。

例えば member write と権限 revoke が同時に起きた場合、両方が同じ ETag で HEAD update を試み、一方だけが成功する。

- member write が先に linearize した場合、revoke は新しい state を読み直してその後に適用される。
- revoke が先なら、member write の retry は新しい ACL で拒否される。

権限失効と完全に同時の request のどちらが先かは authority order で決まる。wall-clock timestamp や Queue order に依存しない。

### 5.7 content upload

blob upload は前調査の staging/finalize model を維持する。

```text
client → random staging key
       → checksum/size verification
       → conditional promote to immutable content-address key
       → authority transactionから参照
```

artifact/blob final key は `If-None-Match: *` で作成し、既存 content-addressed object を上書きしない。

### 5.8 read model と checkpoint

transaction chain を request ごとに genesis まで replay してはならない。定期的に immutable checkpoint を作る。

checkpoint の内容:

- checkpoint generation
- refs
- ACL/public keys
- issue/wiki current heads
- accepted artifact inventory segments
- operation receipt index の complete horizon
- root hashes

HEAD から最新 checkpoint までの短い transaction tail だけを replay する。

checkpoint は acceleration object であり、transaction chain と portable artifacts から再構築できる。checkpoint を作成中に HEAD が進んでも、特定 generation の immutable snapshot として完成させればよい。次の HEAD update が新 checkpoint pointer を採用する。

### 5.9 notification

R2 event notification で `control/HEAD` の更新を Queue へ送ることはできる。しかし Queue は at-least-once かつ順序を保証しないため、event body を canonical transaction として処理しない。

consumer は notification を wake-up signal として使い、最後に処理した transaction から current HEAD までを辿る。

重要な notification は定期 reconciliation でも補完する。Web UI は次のいずれかを使う。

- `If-None-Match` 付き HEAD polling
- visibility 中は短い interval、background では長い interval
- Queue consumer が作る derived static feed

通常 Worker だけでは、世界中の WebSocket connection を一つの project state と結び付ける durable coordinator がない。従って `single-r2` は live WebSocket を必須機能にしない。

### 5.10 throughput limit

R2 は同一 object key への concurrent write を 1 per second に制限し、それ以上では 429 を返す。

すべての canonical mutation が同じ `control/HEAD` を更新するため、`single-r2` の project write throughput は実用上おおむね 1 transaction/s 以下で設計すべきである。

参考:

- [R2 limits](https://developers.cloudflare.com/r2/platform/limits/)
- [R2 error codes](https://developers.cloudflare.com/r2/api/error-codes/)

この制約は次の用途では許容できる。

- single user
- 数人の小規模 team
- commit/issue/wiki update が秒間一回未満
- read-heavy public project

次では不適切である。

- bot が大量 event を生成
- CI status を高頻度で記録
- 大規模 organization
- realtime collaborative editing
- 秒間複数の ref/issue update を常態とする repository

### 5.11 R2-only の長所

- direct Durable Object dependency がない。
- D1 も不要。
- immutable data と authority journal を同じ R2 backup scope に置ける。
- storage capacity が DO/D1 の 10 GB metadata limit に直接縛られない。
- strong consistency と conditional write だけで correctness を説明できる。
- 同等のstrong consistencyとconditional PUTを持つobject storageへmodelを移植しやすい。
- scale-to-zero の stateless Worker にできる。

### 5.12 R2-only の弱点

- single HEAD key が約 1 write/s の bottleneck。
- SQL/FTS query がない。
- projection/checkpoint を自前実装する必要がある。
- transaction chain traversal が R2 Class B operations と latency を増やす。
- cross-object transaction はない。
- WebSocket coordinator と per-project alarm がない。
- GC、operation index repair、checkpoint compaction が複雑。
- R2 は repository database として設計された product ではないため、PoC と fault test が必須。

---

## 6. Profile C: `single-d1`

### 6.1 構成

```text
Worker + Static Assets
        │
        ├ D1 database
        │  ├ artifacts/edges
        │  ├ refs/ACL
        │  ├ projections/FTS
        │  ├ operations
        │  └ outbox
        │
        └ R2 blobs
```

一 project に一 D1 database と一 R2 bucket/prefix を binding する。project routing は不要である。

### 6.2 D1 を使う利点

- SQLite schema と index をそのまま使える。
- `batch()` は atomic transaction として実行される。
- operations/ref/projection/outbox を一 transaction に入れられる。
- FTS/query/pagination が R2 journal より単純。
- Time Travel がある。
- read replication と Sessions API により、read の地域 latency と sequential consistency を改善できる。
- application code に Durable Object class、migration、stub routing が不要。

参考:

- [D1 Workers Binding API](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [D1 SQL statements and FTS5](https://developers.cloudflare.com/d1/sql-api/sql-statements/)
- [D1 global read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)
- [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)

### 6.3 D1 の境界

2026-08-24 時点の主な上限:

| 項目 | Paid | Free |
|---|---:|---:|
| database size | 10 GB | 500 MB |
| Time Travel | 30日 | 7日 |
| SQL query duration | 30秒 | 30秒 |
| row/string/BLOB | 2 MB | 2 MB |

D1 database は single-threaded で、query を一つずつ処理する。公式 documentation は 1 ms/query なら概算 1,000 queries/s、100 ms/query なら 10 queries/s と説明している。read replica は read throughput を増やすが、write は primary へ送られる。

さらに D1 の各 database は内部で一つの Durable Object に支えられている。従って D1 は DO の coding/operations surface を隠すが、single-writer primary、10 GB、overload という根本的な性質を消すものではない。

D1 の通常 export は FTS5 を含む virtual table に対応しないため、D1 dump を portable backup の本体にしない。canonical artifact から FTSを再構築し、EdgeFossil application-level exportを使用する。

参考:

- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [D1 import/export limitations](https://developers.cloudflare.com/d1/best-practices/import-export-data/)

### 6.4 transaction設計

artifact/blob upload と D1 publish は、DO 版と同じ順序にする。

```text
1. R2 staging upload
2. checksum verify + immutable final object
3. D1 atomic batch
   ├ idempotency guard
   ├ artifact/edge insert
   ├ projection update
   ├ ref CAS
   ├ authority sequence
   └ outbox insert
```

D1 `batch()` は、statement が失敗すれば sequence 全体を rollback する。ref precondition を単なる `UPDATE ... WHERE generation=?` にすると zero-row update がSQL errorにならないため、そのままでは batch が継続する。

v0 では次のいずれかで precondition failure を transaction error に変換する。

- guard table + trigger の `RAISE(ABORT, 'REF_CONFLICT')`
- authority generation を検証する trigger
- projection/ref update を trigger から実行
- 一つの SQL statement で条件付き insert/update と outbox生成を結合

この部分はremote D1に対するconcurrency testを必須とする。

### 6.5 outbox dispatch

D1 transaction と Queue send の間にも分散 transaction はない。DO alarm がないため、次を組み合わせる。

- request commit 後に Queue send を試みる。
- 失敗しても outbox row は残る。
- Cron Trigger または scheduled Workflow が未送信 outbox を定期回収する。
- consumer は event ID で dedupe する。

これは notification latency と引き換えに、欠落を防げる。

### 6.6 read replication

read replication を有効にした場合、API は D1 Sessions API を使う。

- mutation/read-after-write は `first-primary` または返却 bookmark を使う。
- browser/session へ bookmark を返す。
- public timeline など多少古くてもよい read は unconstrained session を使える。
- ACL、ref CAS、認証判断を stale replica read だけに依存しない。

Sessions API は session 内と bookmark を引き継いだ request 間で sequential consistency を提供する。read replica は asynchronous であり、bookmark なしの任意 read が最新とは限らない。

### 6.7 D1 を選ぶ条件

次の条件なら `single-d1` は有力である。

- application code から DO を外したい。
- project 内 SQL/FTS/search が重要。
- read-heavyでglobal read replicaを使いたい。
- write throughput は一 primary で足りる。
- WebSocket broadcast は必須でない。
- D1 が内部で DO を使うことは問題ではない。

一方、「Cloudflare の stateful DO architecture そのものへの依存を検証したい」という目的には合わない。

---

## 7. Profile D: `single-do`

これは現状の `1 project = 1 RepositoryDO` を、project registry なしで一 deployment に固定したものになる。

```text
Worker root routes
        │
        ▼
RepositoryDO(fixed project genesis ID)
        ├ SQLite
        ├ R2
        ├ alarm/outbox
        └ Hibernatable WebSockets
```

Multi Edition との違い:

- project ID lookup が固定。
- project creation/deletion/list API がない。
- 一つの custom domain が一つの project。
- location/jurisdiction を deployment 時に固定できる。
- R2 prefix/bucket を専用化できる。
- management UI が小さい。

DO を残す長所:

- SQLite transaction
- authority state と compute の同居
- alarm による outbox repair
- Hibernatable WebSocket
- 約1,000 req/s soft limitまでのcoordination
- 実装具体化メモの設計をほぼそのまま再利用

Single Edition であっても rich collaboration を求めるなら、これが最も単純で堅牢である。

---

## 8. authority として採用しない product

### 8.1 Workers KV

KV は eventually consistent で、別 location では古い value が60秒以上見えることがあり、atomic read-modify-write/CAS transaction 向けではない。公式documentationも、atomic operationやtransactionが必要な用途には不向きとしている。

従って次には使わない。

- HEAD/ref
- ACL
- operation idempotency
- artifact publish state
- GC lease

使える用途:

- public UI cache
- non-authoritative configuration cache
- generated summary
- rate limit の補助情報

参考:

- [How Workers KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/)

### 8.2 Queues

Queues は at-least-once で順序を保証しないため、authority log、ref order、ACL update order には使わない。

使える用途:

- notification
- webhook
- mirror trigger
- derived index build
- checkpoint/GC wake-up

### 8.3 Workflows

Workflow instance を常時の repository authority にしない。

使える用途:

- export
- restore
- R2 journal checkpoint
- GC
- D1 outbox repair
- backend migration

### 8.4 Static Assets

static asset deployment は immutable release/read path に使えるが、runtime mutation store ではない。

---

## 9. profile比較

| 能力 | single-static | single-r2 | single-d1 | single-do |
|---|---:|---:|---:|---:|
| EdgeFossil deploymentにDO namespace/binding不要 | ✅ | ✅ | ✅ | ❌ |
| correctnessがDO-backed primaryの性質に依存しない | ✅ | ✅ | ❌ | ❌ |
| browser/API write | ❌ | ✅ | ✅ | ✅ |
|複数writer | deploy単位 |小規模 | ✅ | ✅ |
| atomic metadata transaction | snapshotのみ | HEAD CAS一回 | SQL batch | SQLite transaction |
| SQL/FTS | build時のみ | ❌ | ✅ | ✅ |
| live WebSocket | ❌ | ❌ | ❌ | ✅ |
| per-project alarm | ❌ | ❌ | ❌ | ✅ |
| global read scale | CDN | R2/read cache | read replica | Worker/R2、DOは単一配置 |
| practical write ceiling | deploy頻度 |約1 tx/s | query時間依存 |数百程度のsimple write/s目安 |
| metadata capacity | build output依存 | R2 object数依存 | Paid 10 GB | Paid 10 GB |
| implementation complexity |小 |中〜大 |中 |中 |
| portable hostへの移植 |最良 |良 |中 |中 |
|推奨用途 | archive/public | personal/small team | SQL-heavy single site | collaboration |

`single-r2` は product 数が少ないが、journal/checkpoint/GC を自作するため、code量が必ずしも `single-do` より小さくなるとは限らない。ここは「依存 product の少なさ」と「application correctness code の少なさ」を分けて評価する。

---

## 10. Single Edition の製品形

### 10.1 CLI

```bash
ef project init
ef cloud init --profile single-r2
ef cloud deploy
ef sync
ef export project.edge
ef verify project.edge
ef cloud migrate --to single-do
```

project root の設定例:

```toml
[project]
genesis = "sha256:..."

[cloud]
edition = "single"
authority = "r2-journal"
base_url = "https://project.example.com"

[capabilities]
issues = true
wiki = true
live_updates = false
server_search = false
```

capability は server の `GET /api/v0/capabilities` でも返し、同じ UI が profile に応じて利用不能な操作を隠す。

### 10.2 route

Single Edition API:

```text
GET  /api/v0/project
GET  /api/v0/capabilities
GET  /api/v0/inventory
POST /api/v0/uploads
POST /api/v0/uploads/{id}/finalize
POST /api/v0/artifacts:publish
GET  /api/v0/refs
POST /api/v0/refs:compare-and-swap
GET  /api/v0/timeline
POST /api/v0/exports
```

wire artifact には project ID を残し、URL だけから省く。

### 10.3 deployment ownership

Single Edition は次を同じ repository の infrastructure configuration として管理できる。

- Worker
- Static Assets
- R2 bucket/binding
- optional D1/DO binding
- custom domain
- secrets
- backup/export policy
- jurisdiction/location

一 project 専用なので、account/project handoff が Multi Edition より説明しやすい。

---

## 11. migration

### 11.1 Single → Multi

```text
1. Single authorityをmaintenance/read-onlyにする
2. complete portable exportを生成・verify
3. Multi Editionに同じproject.genesis IDでprojectを作る
4. artifacts/blobsをdedupe import
5. refs、portable policy、必要なreceiptsをimport
6. new authority epochを記録
7. custom domain/API endpointを切り替える
8. sync clientsへnew remoteを通知
```

artifact ID は変わらない。変わるのは authority receipt、repository sequence、remote endpoint である。

### 11.2 Multi → Single

一 project の complete export から `single-static`、`single-r2`、`single-do` を生成できる。

private operational secret/session は export せず、新 deployment で再発行する。ACL history を移す場合も、現在の authority policy として明示的に再受理する。

### 11.3 R2 → DO

`single-r2` が write頻度、search、WebSocket要求の限界に達した時の推奨手順:

1. HEAD generation を固定して短い maintenance window を開始。
2. transaction chain/checkpoint/artifact graph を verify。
3. RepositoryDO SQLiteへcanonical index、refs、ACL、operationsをimport。
4. R2 blob final keysはそのまま再利用。
5. authority epoch transition artifact/receiptを作る。
6. Worker bindingをDOへ切り替える。
7. read/write smoke test後にunfreeze。

初期段階ではdual-write migrationを避ける。R2 HEADとDOを同時authorityにすると、解こうとしていた分散transaction問題を再導入する。

### 11.4 DO → R2

逆方向も可能だが、project が `single-r2` の capability envelope に収まることを先に確認する。

- write rate
- metadata/index size
- live WebSocket依存
- alarm job
- FTS/search要求
- pending outbox/workflows

移行時にDO stateを一つのR2 checkpoint + authority genesis transactionへ変換し、新しいauthority epochを開始する。

---

## 12. security

### 12.1 Single Edition は secret を public project data と分ける

一 project 専用 bucket でも、次をportable artifactへ入れない。

- bearer token
- OAuth client secret
- R2 credential
- session
- presigned URL
- webhook secret

`single-r2` の最小 write auth は次から始められる。

- Worker secret に一つのowner credential hash
- actor Ed25519 signature
- HEAD journal内のpublic key/role/revocation state

### 12.2 R2 credential をclientへ渡さない

clientにはrandom staging keyへの短期 upload capabilityだけを渡す。`control/HEAD`、transaction、final object prefixへ書けるR2 credentialを配布しない。

すべてのHEAD CASとartifact validationはWorkerが行う。

### 12.3 bucket lock

R2 bucket lockはimmutable artifact/blob/export prefixのaccidental deletion防止に利用できる。ただし次に注意する。

- mutable `control/HEAD` はlockしない。
- GC対象prefixへindefinite lockをかけない。
- retention policyとproject deletion policyを一致させる。
- lock rule自体を変更できるoperator権限は別途保護する。

参考:

- [R2 bucket locks](https://developers.cloudflare.com/changelog/post/2025-03-06-r2-bucket-locks/)

---

## 13. `single-r2` のfault model

| failure point |結果 | recovery |
|---|---|---|
| staging uploadだけ成功 | orphan staging | lifecycle/GC |
| final blob promoteだけ成功 | unreferenced immutable blob | grace period GC |
| transaction PUTだけ成功 | orphan transaction | HEADから未到達ならGC |
| HEAD CAS競合 | canonical state不変 | reread/revalidate/retry |
| HEAD CAS成功、response消失 | operationはaccepted | operation IDでchain確認 |
| HEAD event notification欠落 | canonical stateは正しい | polling/reconciliation |
| Queue重複/順不同 |通知重複 | transaction hashでdedupe |
| checkpoint生成中にHEAD進行 |古いgenerationのvalid checkpoint |後続transactionが採用判断 |
| GC中に新しいwrite |新objectを誤削除する危険 | mark epoch + grace + generation check |
| CDNに古いHEAD |lost updateの危険 | authority readにCDNを使わない |

`single-r2` PoC の価値は、この表を実際の failure injection で証明できるかにある。

---

## 14. 検証計画

### Phase S0: static profile

成果物:

- portable bundle → static site generator
- Static Assets deployment
- large bundle/blob の R2 link
- offline verify

合格条件:

- Cloudflare Worker codeなしでもprojectを閲覧できる。
- complete bundleから同じsemantic rootを再構築できる。
- artifact数を増やしてもStatic Assets file limitsを超えないchunk設計になる。

### Phase S1: R2 CAS primitive

成果物:

- `control/HEAD`
- immutable transaction
- conditional create/update
- operation ID retry
- concurrent writer test harness

合格条件:

- 100 concurrent CASのうち同じgenerationで一つだけ成功する。
- loserが新HEADからretryし、lost updateがない。
- response消失後の同一operation再送で二重適用されない。
- CDN/cacheを経由したauthority readがcode path上存在しない。

### Phase S2: minimal repository

成果物:

- blob staging/finalize
- artifact publish
- ref CAS
- ACL update
- checkpoint
- inventory/sync

合格条件:

- visible artifactがmissing/unverified blobを参照しない。
- ref writeとACL revokeのraceが一つのauthority orderへlinearizeする。
- genesisからtransaction replayしたstateとcheckpoint+tailが一致する。

### Phase S3: background maintenance

成果物:

- R2 event notification
- Queue derived processing
- scheduled reconciliation
- checkpoint compaction
- mark/sweep GC
- complete export

合格条件:

- notificationを任意にdrop/duplicate/reorderしてもcanonical stateは不変。
- GCとwriteを並行させてもreachable objectを削除しない。
- orphan transaction/staging/blobをretention後に回収できる。

### Phase S4: comparative benchmark

同じworkloadを `single-r2`、`single-d1`、`single-do` で比較する。

測定項目:

- publish latency p50/p95/p99
- write contention/429/overload
- R2 operations数
- D1/DO rows read/write
- inventory/sync latency
- checkpoint/rebuild時間
- implementation LOCとstate machine数
- 月額cost
- 故障注入で必要なrepair処理

profile選択は「DOを使わない方が美しい」という印象ではなく、この比較で決める。

---

## 15. 推奨ロードマップ

### 15.1 最初に作るもの

1. 共通artifact/local repository/export
2. `single-static`
3. `single-r2` CAS primitive PoC
4. 既存案の `single-do` vertical slice
5. 実測比較

`single-d1` は、R2 journalが複雑すぎる一方でDO classをproduct surfaceから外したい要求が具体化した時に追加する。

### 15.2 製品default

用途別にdefaultを変える。

| command/use case | default profile |
|---|---|
| `ef publish --archive` | `single-static` |
| `ef cloud init --personal` | `single-r2`、PoC合格後 |
| `ef cloud init --team` | `single-do` |
| Multi Edition/SaaS | RepositoryDO per project |

`single-r2` PoC がcorrectness/latency/maintenance基準を満たさない場合、personal defaultも `single-do` とし、`single-r2` はexperimentalに留める。

### 15.3 capability escalation

```text
single-static
     │ browser writeが必要
     ▼
single-r2
     │ SQL search / >1 write/s / realtimeが必要
     ▼
single-do
     │複数projectを一serviceで管理
     ▼
Multi Edition
```

これはdata format migrationではなくauthority/deployment migrationとして扱う。

---

## 16. 推奨ADR

1. ADR-S001: Single Editionはdeployment modelでありartifact forkではない
2. ADR-S002: project.genesis IDをSingle Editionでも保持
3. ADR-S003: Single profile capability negotiation
4. ADR-S004: `single-static` read-only snapshot semantics
5. ADR-S005: R2 HEADを唯一のmutable CAS objectに限定
6. ADR-S006: R2 authority accessはCDN/cacheを経由しない
7. ADR-S007: R2 authority transactionとportable artifactを分離
8. ADR-S008: `single-r2` write envelopeは約1 transaction/s
9. ADR-S009: R2 notificationはwake-up signalのみ
10. ADR-S010: checkpointは再構築可能なacceleration object
11. ADR-S011: D1はapplication-level DO-freeだがstrict DO-freeではない
12. ADR-S012: profile migrationはauthority epochを切り替える

---

## 17. 最終提案

EdgeFossil は次の二つの製品形を持てる。

```text
Multi Edition
  one service → many projects → one RepositoryDO per project

Single Edition
  one deployment → one project → selectable authority profile
```

Single Edition の本質は resource 削減だけではない。

> project website、sync endpoint、storage、backup policy、custom domain を一つの project appliance として所有できること

である。

DO を使わない構成も可能である。

- `single-static` は完全に可能で、archive/public mirrorとして堅牢である。
- `single-r2` はR2 strong consistency + conditional PUTから、DO namespace/bindingなしでCAS journalを構成できる。ただし約1 HEAD update/s、SQL不在、checkpoint/GC自作という明確なtrade-offがある。
- `single-d1` はapplication codeとdeploymentから直接のDO bindingを外せるが、D1 databaseはDOに支えられるため、DO-backed single primaryの性質から独立する案ではない。
- rich collaborationでは、single projectでもRepositoryDOが最も素直である。

従って推奨は、DOを一律に外すことではない。

1. 共通portable artifact modelをbackendより上位に置く。
2. `single-static` を長期保存性の基準実装にする。
3. `single-r2` をstrict DO-freeの実験・personal profileとしてPoCする。
4. `single-do` をrich team profileとする。
5. すべてをexport/import可能なauthority profileとして接続する。

この構成なら、「Cloudflare native」でありながら「Durable Objectがなければprojectを扱えない」設計にはならない。同時に、coordinationが本当に必要な場面ではDOの強みを捨てずに済む。

---

## 参考資料

### R2

- [R2 consistency model](https://developers.cloudflare.com/r2/reference/consistency/)
- [R2 limits](https://developers.cloudflare.com/r2/platform/limits/)
- [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [R2 S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/)
- [R2 error codes](https://developers.cloudflare.com/r2/api/error-codes/)
- [R2 event notifications](https://developers.cloudflare.com/r2/buckets/event-notifications/)
- [R2 bucket locks](https://developers.cloudflare.com/changelog/post/2025-03-06-r2-bucket-locks/)

### D1

- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [D1 Workers Binding API](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [D1 SQL statements and FTS5](https://developers.cloudflare.com/d1/sql-api/sql-statements/)
- [D1 global read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)
- [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [D1 import/export limitations](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)

### Workers / KV / background processing

- [Workers Static Assets billing and limitations](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)
- [Static Assets SPA routing](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)
- [How Workers KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/)
- [Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/)
