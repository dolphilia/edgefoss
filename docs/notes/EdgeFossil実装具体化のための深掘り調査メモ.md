# EdgeFossil 実装具体化のための深掘り調査メモ

調査日: 2026-08-24  
位置づけ: [`Cloudflare Workersネイティブな「Fossilの後継」を設計する — 統合型SCMの再構成案.md`](./Cloudflare%20Workersネイティブな「Fossilの後継」を設計する%20—%20統合型SCMの再構成案.md) を初期案とした、実装判断のための追加調査

## 1. このメモの目的

初期案は、Fossil から継承する思想と Cloudflare 上の全体像を十分に提示している。

次に必要なのは、次の問いへ答えることである。

1. 何を永続的な仕様とし、何を Cloudflare 固有の実装詳細とするか。
2. Durable Objects、R2、Queues の間に分散トランザクションがない状況で、何を不変条件にするか。
3. オフラインで生成された履歴を、複数端末から安全に同期するには何が必要か。
4. 「1 project = 1 Durable Object」は、どこまで成立するか。
5. 最初の実装で Merkle tree、Workflows、WebSocket、AI 検索まで作るべきか。
6. どの順序で PoC を行えば、構想上の最大リスクを早く潰せるか。

本メモの結論は、製品機能を増やすことではなく、**永続仕様を小さく固定し、Cloudflare 上の公開処理を失敗しても再実行できる state machine として設計すること**である。

---

## 2. 結論

### 2.1 初期案から維持する判断

- プロジェクトを source、issue、wiki、discussion を含む一つの複製可能な単位とする。
- immutable、content-addressed artifact を永続モデルの中心にする。
- ローカルは SQLite、クラウドは Durable Object SQLite + R2 とし、物理形式を一致させない。
- MVP では `1 project = 1 Repository Durable Object` とする。
- 大きな byte content は R2、整合性が必要な metadata と projection は DO SQLite に置く。
- 完全 export を第一級機能とし、Cloudflare の内部形式を portable bundle に含めない。

### 2.2 修正すべき判断

1. **「1 project = 1 DO」は製品の永久的不変条件ではなく、MVP の整合性境界とする。**
   SQLite-backed DO は 1 object あたり Paid で 10 GB、Free で 1 GB、単一 object は single-threaded で、単純処理でも約 500–1,000 req/s が目安である。巨大 repository を無制限に収容する構成ではない。

2. **artifact の集合と、ref や権限の可変状態を同一視しない。**
   artifact は複製可能だが、ref 更新、ACL、upload session、idempotency record は authority が管理する operational state である。

3. **R2 ETag を content ID として使わない。**
   特に multipart upload の ETag は object 全体の SHA-256 ではない。artifact/blob ID はアプリケーションが計算する SHA-256 とし、R2 の checksum/metadata は検証用に使う。

4. **Queue へ timeline の正しい順序を期待しない。**
   Cloudflare Queues は at-least-once で、publish 順の delivery を保証しない。canonical write、ref 更新、timeline sequence の採番は DO transaction 内で完了させる。

5. **DO commit 後の Queue send を直接の一回勝負にしない。**
   SQLite transaction 内に `outbox` 行を追加し、DO alarm が Queue 送信を再試行する transactional outbox を採用する。

6. **最初から Merkle tree を実装しない。**
   v0 は cursor 付き inventory paging と `HAVE/WANT` batch で正しさを先に確立する。artifact 数と転送量を測定した後、prefix summary、cluster、Merkle trie の順に最適化を検討する。

7. **PITR を backup と呼ばない。**
   DO SQLite の PITR は直近 30 日の復旧手段であり、R2 content と portable history を一体で保存する長期 backup ではない。

### 2.3 MVP で延期するもの

- 自動 Merkle reconciliation
- delta compression
- repository 内 metadata の自動 sharding
- peer-to-peer 無権限 multi-master
- CI runner
- semantic/vector search
- branch/PR 互換 UI
- binary diff
- Git protocol server 互換

これらを外しても、構想の本質である「複製可能な project state」は検証できる。

---

## 3. 調査で確認した Cloudflare の現実的な境界

数値は 2026-08-24 時点で確認したものであり、実装開始時と release 前に再確認する。

### 3.1 SQLite-backed Durable Objects

Cloudflare の現行仕様では、SQLite-backed DO は次の性質を持つ。

| 項目 | 確認した仕様 | EdgeFossil への意味 |
|---|---:|---|
| storage/object | Paid 10 GB、Free 1 GB | metadata を無制限には置けない |
| row、string、BLOB | 最大 2 MB | artifact body に独自の小さい上限が必要 |
| columns/table | 100 | payload を列へ過剰展開しない |
| bound parameters/query | 100 | bulk insert は適切に chunk 化する |
| CPU/request | 標準 30 秒、最大 5 分に設定可能 | 大規模 export/GC を通常 request で行わない |
| soft throughput/object | 約 1,000 req/s | hot repository は単一 object が bottleneck になる |
| PITR | 過去 30 日 | operator recovery に使えるが長期 backup ではない |
| SQL extensions | FTS5、JSON、math | v1 の repository 内検索に外部 DB は不要 |

DO は single-threaded だが、`await` をまたぐ外部 I/O は request 間で interleave し得る。SQLite storage 操作には input/output gate による保護がある一方、R2 や外部 `fetch()` を `blockConcurrencyWhile()` で囲むのは throughput を落とす anti-pattern とされている。

したがって RepositoryDO は次のように使う。

- constructor の schema migration だけを `blockConcurrencyWhile()` で保護する。
- read-modify-write は SQLite transaction または await を挟まない同期 SQL で行う。
- R2 upload 完了を待ちながら repository 全体を lock しない。
- 外部 I/O は upload/finalize の state machine と idempotency で整合させる。

参考:

- [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [SQLite-backed Durable Object Storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

### 3.2 Durable Object の配置

DO は一つの location に存在し、作成後は現在のところ移動しない。最初の access が代表的でない場所から行われると、repository の恒久的な latency が悪化し得る。

必要な設計は次の通りである。

- project 作成時に owner の主要地域から初期化する。
- API に optional な region preference を持たせ、適切な `locationHint` を使う。
- data residency が必要な deployment では、通常 namespace と `eu`、`us` など jurisdiction 付き namespace を分ける。
- repository metadata の jurisdiction と R2 bucket の jurisdiction を一致させる。
- jurisdiction は後から簡単に変更できないため、project 作成時の immutable deployment property とする。

参考:

- [Durable Objects data location](https://developers.cloudflare.com/durable-objects/reference/data-location/)
- [R2 data location](https://developers.cloudflare.com/r2/reference/data-location/)

### 3.3 R2

R2 は object の read-after-write、delete、list を strong consistency で提供する。これは upload 完了後に `HEAD` して finalize する方式と相性がよい。

主要な上限は次の通りである。

| 項目 | 上限 |
|---|---:|
| object size | 約 5 TiB |
| single-part upload | 約 5 GiB |
| multipart parts | 10,000 |
| part size | 5 MiB–5 GiB、last part を除き同サイズ |
| object key | 1,024 bytes |
| custom metadata | 8,192 bytes |
| concurrent write/same key | 1 write/s |

Cloudflare account plan による Worker inbound body 上限は Free/Pro 100 MB、Business 200 MB、Enterprise は既定 500 MB である。大きな blob を Worker request body として中継すると、この制約と 128 MB memory の両方が問題になる。

したがって blob upload は二系統にする。

- 小さい object: Worker から R2 binding へ stream する簡易経路。
- 大きい object: 短時間の presigned URL または認証付き multipart endpoint で R2 へ直接 upload する経路。

R2 は SHA-256 checksum を保持できる。ただし checksum が提供されなかった object や multipart ETag を暗黙に信用せず、EdgeFossil が `expected_hash` と `expected_size` を管理する。

参考:

- [R2 consistency model](https://developers.cloudflare.com/r2/reference/consistency/)
- [R2 limits](https://developers.cloudflare.com/r2/platform/limits/)
- [Upload objects](https://developers.cloudflare.com/r2/objects/upload-objects/)
- [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

### 3.4 Queues と alarms

Queues の重要な性質は次の通りである。

- delivery は at-least-once。
- publish 順と delivery 順が同じである保証はない。
- message は最大 128 KB。
- 1 queue あたり最大 5,000 messages/s。
- retention は最大 14 日。Free plan は 24 時間。
- consumer は最大 250 concurrent invocations。
- dead-letter queue を設定できる。

Queues は `artifact_id`、`operation_id` を payload とする通知に使い、artifact 本文や大きな diff は載せない。consumer は必ず idempotent にする。

DO alarm も at-least-once であり、一つの DO につき同時に一つだけ設定できる。outbox では「次に未送信の行がある時だけ alarm を設定し、batch を送った後、残件があれば次の alarm を設定する」方式にする。alarm が例外を投げた場合の自動 retry は最大 6 回なので、長い downstream 障害でも outbox が止まらないよう、handler 内で失敗を記録して次回 alarm を明示的に再設定する。

参考:

- [Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [How Queues works](https://developers.cloudflare.com/queues/reference/how-queues-works/)
- [Queues limits](https://developers.cloudflare.com/queues/platform/limits/)
- [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)

### 3.5 Workflows

Workflows は export、長い GC、migration の orchestration に適しているが、永久保存場所ではない。

- 1 step の non-stream result は最大 1 MiB。
- event payload は最大 1 MiB。
- instance state は Paid で最大 1 GB。
- completed state retention は Paid で 30 日、Free で 3 日。
- step 数と state storage に課金がある。

したがって export の各 step は blob 本文を result に返さず、R2 key、cursor、hash のような小さい参照だけを返す。生成済み bundle の retention は R2 lifecycle rule で管理する。

参考:

- [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/)
- [Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/)

---

## 4. 永続モデルを三層に分ける

初期案の「everything is an artifact」は製品思想として強い。ただし、実装上すべてを同じ複製規則にすると、ACL や upload session まで全 peer に伝播してしまう。

そこで state を三層に分ける。

### 4.1 Portable canonical state

clone/export/sync の対象であり、将来 Cloudflare がなくても意味を復元できるもの。

- blob
- tree/snapshot
- change/checkpoint
- issue event
- wiki revision
- discussion post
- attachment relation
- release manifest
- proposal
- project policy のうち履歴として公開すべき部分
- artifact signature/attestation

これは immutable artifact graph である。

### 4.2 Authority operational state

特定 server deployment が安全に運用するための可変 state。通常の project clone では同期しない。

- OAuth/OIDC session
- API token hash
- current ACL と membership
- rate-limit counter
- upload session
- idempotency key
- ref の current compare-and-swap state
- repository sequence
- outbox delivery state
- GC lease
- audit receipt

ACL 変更を履歴 artifact として記録することはできるが、**現在の認可判断は server-local authority state で行う**。過去の artifact を持つだけで現在の write 権限を得られてはならない。

### 4.3 Derived state

canonical artifact から再構築可能な projection。

- `files_current`
- `issues_current`
- `wiki_current`
- `threads_current`
- FTS5 index
- timeline rows
- blob reference count cache
- sync summary

derived table が壊れた場合、canonical artifact と reducer version から再構築できなければならない。

この三分割により、「project は完全に export できる」と「server secret を export しない」を両立できる。

---

## 5. Artifact Format v0 の提案

### 5.1 二つの content-addressed object

v0 では object を二種類に限定する。

1. `blob`: 任意の raw bytes。R2 または local SQLite に格納する。
2. `artifact`: blob や他 artifact の関係を記述する、小さい構造化 object。

`source file` 自体を巨大な構造化 artifact にせず、raw blob と、それを参照する snapshot/tree artifact に分ける。

### 5.2 hash algorithm

v0 は SHA-256 のみを必須とする。

理由:

- Cloudflare Workers の Web Crypto と `DigestStream` が native に対応する。
- R2 が SHA-256 checksum を保持できる。
- Rust、browser、OS 標準 library の実装が広く存在する。
- portable format の独立実装が容易である。

BLAKE3 は高速だが、Web Crypto の標準 digest ではない。将来 algorithm agility を追加する場合も、文字列 ID は `sha256:<base32-or-hex>` のように algorithm を明示する。

Fossil 自体も SHA-1 固定から SHA3-256 を追加した。従って algorithm agility の field は最初から設けるが、v0 encoder が生成する algorithm は一つに絞る。

参考:

- [Cloudflare Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)
- [Fossil artifact identification](https://fossil-scm.org/home/doc/trunk/www/hashes.md)

### 5.3 v0 で固定する artifact kind

拡張可能性を保ちつつ、最初の reducer を小さくするため、v0 encoder が生成する kind を次に限定する。

| kind | 意味 | 主な参照 |
|---|---|---|
| `project.genesis` | project ID、format policy、最初の owner key | なし |
| `tree` | path、mode、blob ID の sorted entries | blob |
| `change` | source tree と説明を持つ変更単位 | parent change、tree |
| `checkpoint` | release/taggable な明示的 snapshot | change、tree |
| `issue.create` | issue identity と初期値 | body blob |
| `issue.patch` | field update | issue、prior issue event |
| `issue.comment` | append-only comment | issue、body blob |
| `wiki.revision` | page の一 revision | prior revision、body blob |
| `thread.post` | thread root/reply | root、reply target、body blob |
| `tombstone` | 対象を論理的に削除/非表示にする event | target artifact |

`project.genesis` の artifact ID を portable project ID として使えば、local clone、cloud、export の間で project identity が変わらない。

`tree` entry は path 順の配列とし、同じ path を一つの tree に二度含めない。`change` は「作業中の変更 identity」、`checkpoint` は共有可能な明示的 snapshot とする。branch/ref は artifact kind ではなく authority の可変 pointer として v0 を開始する。

### 5.4 serialization

artifact body は RFC 8949 の deterministic CBOR を基礎にする。ただし「CBOR を使う」とだけ定義しては不十分である。v0 profile を次のように狭める。

- definite-length item のみ。
- map key は UTF-8 text string のみ。
- map key は deterministic encoding の bytewise order。
- integer は最短表現。
- floating point、NaN、Infinity、CBOR tag を禁止。
- timestamp は UTC の RFC 3339 text と、因果順序用の整数を分離する。
- duplicate map key を拒否する。
- text metadata は valid UTF-8。project path には別途 path rule を適用する。
- decoder は decode 後の再 encode bytes が入力と一致しない場合を reject する。

RFC 8949 は application protocol が deterministic profile の選択を明示すべきだとしている。この制約を specification と test vector にする。

代替案は RFC 8785 JCS だが、raw bytes の表現と JavaScript number の制約を考えると、SCM の永続 object には CBOR の方が自然である。debug 表示用 JSON は canonical bytes ではないことを明記する。

参考:

- [RFC 8949: CBOR](https://www.rfc-editor.org/rfc/rfc8949.html#section-4.2)
- [RFC 8785: JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785.html)

### 5.5 最小 envelope

概念表現は次の通りとする。実際の hash 対象は deterministic CBOR bytes である。

```json
{
  "format": "edgefossil-artifact",
  "version": 0,
  "project": "project-id",
  "kind": "issue.comment",
  "schema": 1,
  "parents": ["sha256:..."],
  "actor_key": "ed25519:...",
  "logical_clock": 42,
  "created_at": "2026-08-24T12:34:56.789Z",
  "payload": {
    "issue": "sha256:...",
    "body_blob": "sha256:..."
  }
}
```

不変条件:

- `artifact_id = SHA-256(canonical artifact body)`。
- `logical_clock = 1 + max(parent.logical_clock)`。親がなければ 0。
- `created_at` は表示情報であり、因果順序や ACL 判定に使わない。
- 親が未取得なら phantom として保留できるが、projection へは適用しない。
- `project` が異なる artifact への edge は原則禁止する。
- 未知の `kind` は保存・同期できるが、projection は作らない。
- 未知の required semantic field を黙って無視しない。

### 5.6 signature と receipt を artifact body から分ける

同じ artifact に複数の署名や server receipt を追加できるよう、署名を hash 対象 body に埋め込まない。

```text
Artifact body ──SHA-256──> artifact_id
                               │
                               ├── actor signature
                               ├── reviewer attestation
                               └── server acceptance receipt
```

actor signature は `project_id + artifact_id + signature_context` に対する Ed25519 signature とする。Workers Web Crypto は Ed25519 の sign/verify に対応している。

server は次を別の receipt として保存する。

- authenticated principal
- accepted repository sequence
- accepted time
- policy version
- operation ID

これにより、artifact の同一性、作成者の主張、特定 server が受理した事実を混同しない。

MVP で端末鍵管理が重ければ、最初は server-authenticated receipt を必須、offline actor signature を optional にしてよい。ただし format 上の場所は先に確保する。

### 5.7 path portability

Git と同様に raw path をほぼ無制限にすると、Windows/macOS/Linux 間の checkout で問題が起きる。v0 は保守的にする。

- path separator は `/`。
- absolute path、空 segment、`.`、`..`、NUL を禁止。
- metadata path は valid UTF-8 NFC。
- repository policy で case-sensitive を標準とする。
- Windows reserved names、末尾 dot/space、case-fold collision を portable checkout warning または reject 対象にする。
- symlink は blob 内容とは別の file mode として明示し、checkout 時に repository root 外への escape を防ぐ。

---

## 6. Cloud data model v0

RepositoryDO の SQLite には、canonical index、authority state、projection を置く。artifact body は小さいので SQLite に保持してよいが、大きい payload は blob hash 参照にする。

```sql
CREATE TABLE artifacts (
  artifact_id       TEXT PRIMARY KEY,
  kind              TEXT NOT NULL,
  schema_version    INTEGER NOT NULL,
  actor_key         TEXT,
  logical_clock     INTEGER NOT NULL,
  created_at        TEXT NOT NULL,
  body_cbor         BLOB NOT NULL,
  repo_seq          INTEGER NOT NULL UNIQUE,
  received_at       TEXT NOT NULL
);

CREATE TABLE artifact_edges (
  source_id         TEXT NOT NULL,
  target_id         TEXT NOT NULL,
  edge_kind         TEXT NOT NULL,
  position          INTEGER,
  PRIMARY KEY (source_id, edge_kind, target_id)
);

CREATE TABLE attestations (
  artifact_id       TEXT NOT NULL,
  signer_key        TEXT NOT NULL,
  context           TEXT NOT NULL,
  signature         BLOB NOT NULL,
  PRIMARY KEY (artifact_id, signer_key, context)
);

CREATE TABLE receipts (
  artifact_id       TEXT NOT NULL,
  authority_id      TEXT NOT NULL,
  principal_id      TEXT NOT NULL,
  repo_seq          INTEGER NOT NULL,
  accepted_at       TEXT NOT NULL,
  policy_version    INTEGER NOT NULL,
  operation_id      TEXT NOT NULL,
  PRIMARY KEY (artifact_id, authority_id)
);

CREATE TABLE blobs (
  blob_id           TEXT PRIMARY KEY,
  byte_size         INTEGER NOT NULL,
  r2_key            TEXT NOT NULL UNIQUE,
  state             TEXT NOT NULL,
  verified_at       TEXT,
  first_seen_seq    INTEGER NOT NULL
);

CREATE TABLE refs (
  ref_name          TEXT PRIMARY KEY,
  artifact_id       TEXT NOT NULL,
  generation        INTEGER NOT NULL,
  updated_seq       INTEGER NOT NULL
);

CREATE TABLE operations (
  operation_id      TEXT PRIMARY KEY,
  principal_id      TEXT NOT NULL,
  request_hash      TEXT NOT NULL,
  result_cbor       BLOB NOT NULL,
  created_at        TEXT NOT NULL
);

CREATE TABLE outbox (
  outbox_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_kind        TEXT NOT NULL,
  aggregate_id      TEXT NOT NULL,
  payload_cbor      BLOB NOT NULL,
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  delivered_at      TEXT
);

CREATE TABLE upload_sessions (
  upload_id         TEXT PRIMARY KEY,
  principal_id      TEXT NOT NULL,
  blob_id           TEXT NOT NULL,
  byte_size         INTEGER NOT NULL,
  r2_key            TEXT NOT NULL,
  state             TEXT NOT NULL,
  expires_at        TEXT NOT NULL
);
```

追加する projection table は feature ごとに migration できる。

```text
timeline
files_current
issues_current
wiki_current
threads_current
search_fts
```

重要なのは、`repo_seq` は cloud authority が付ける receipt order であり、artifact ID の一部ではないことである。別 clone が異なる順番で同じ artifact を受け取っても、portable state は同じである。

---

## 7. Write path を state machine にする

### 7.1 blob upload

```text
Client                  Edge Worker / DO                         R2
  │ create-upload(hash,size) │                                    │
  ├─────────────────────────>│ auth, quota, ACL                   │
  │<─────────────────────────┤ upload_id + staging capability    │
  │                          │                                    │
  ├────────────────────────── PUT/multipart to random staging ──>│
  │                          │                                    │
  │ finalize(upload_id)      │                                    │
  ├─────────────────────────>│ HEAD + size/checksum verify       │
  │                          │ conditional promote to final key ─>│
  │                          │ transaction: blob=verified         │
  │<─────────────────────────┤                                    │
```

presigned PUT URL は期限内なら再利用できるため、client に最終 content-address key への書き込み capability を直接渡さない。client は upload ID を含むランダムな staging key にだけ書き、server が checksum 検証後、最終 key が存在しない場合だけ conditional copy/put で promote する。staging object は publish の source of truth にせず、期限後に lifecycle/GC で削除する。

R2 key は最低でも tenant/repository boundary を含める。

```text
staging/{tenant_id}/{project_id}/{upload_id}
objects/{tenant_id}/{project_id}/sha256/{first2}/{full_hash}
```

global hash 一つだけを key にして全 private repository 間で deduplicate すると、次の問題が生じる。

- object existence oracle
- repository 削除と shared object retention の競合
- tenant ごとの quota accounting の困難
- legal deletion scope の曖昧化

従って v0 は project 内 deduplication に限定する。cross-project deduplication は public repository など明確な trust domain 内でのみ将来検討する。

同一 final key への concurrent promotion は R2 の rate limit 対象になるため、`HEAD` で既存 verified object を確認し、存在する場合は upload を省略する。競合時は `If-None-Match: *` 相当の conditional operation と retry/backoff を使い、既存 final object を上書きしない。

### 7.2 artifact publish

blob が verified になった後、artifact を publish する。

DO transaction 内で次を一度に行う。

1. `operation_id` の重複を確認する。
2. canonical bytes、hash、schema、signature、parents を検証する。
3. 参照 blob がすべて `verified` であることを確認する。
4. artifact と edges を insert する。
5. projection を更新する。
6. 必要なら ref を compare-and-swap で更新する。
7. `repo_seq` を採番する。
8. outbox event を insert する。
9. operation result を保存する。

同じ `operation_id` と同じ `request_hash` が再送された場合、前回 result を返す。ID は同じでも request body が違えば conflict とする。

### 7.3 ref compare-and-swap

ref 更新 API は必ず期待値を持つ。

```json
{
  "ref": "main",
  "expected_artifact": "sha256:old",
  "expected_generation": 17,
  "new_artifact": "sha256:new",
  "operation_id": "uuid"
}
```

期待値が異なれば lost update を起こさず、`409 RefConflict` と現在値を返す。client は merge、proposal、別 ref のいずれかを選ぶ。

artifact の upload と ref publish を分離することで、artifact は受理済みだが ref 競合した状態を安全に表現できる。これは dangling data ではなく、回収または proposal 化可能な unpublished change である。

### 7.4 transactional outbox

次の素朴な処理には穴がある。

```text
DO commit succeeds
Queue send fails
→ canonical state は更新されたが通知が永久に欠落
```

逆順でも、Queue だけ送られて DB commit が失敗する可能性がある。

従って canonical transaction は outbox row までで完了とする。DO alarm が未送信行を Queue に送り、成功後に delivered を記録する。alarm 自体と Queue consumer は重複実行され得るため、event ID を idempotency key にする。

notification、webhook、external mirror、重い indexing は eventual でよい。canonical timeline と FTS の最低限の projection は DO transaction 内で更新し、ユーザーが write 直後に自分の変更を見失わないようにする。

---

## 8. 同期 protocol v0

### 8.1 目標

v0 の目標は帯域最小化ではなく、次の正しさである。

- interruption 後に再開できる。
- request の再送が安全である。
- 同じ artifact set から同じ portable state を導ける。
- 未知の artifact kind を失わず relay できる。
- partial clone の対象範囲を明示できる。
- authorization failure と missing content を区別できる。

### 8.2 protocol phases

```text
HELLO
  protocol versions, hash algorithms, compression, project ID

AUTH
  bearer/session/device proof, requested capabilities

INVENTORY
  paged artifact IDs or prefix summaries, opaque resume cursor

WANT
  missing artifact IDs and blob IDs in bounded batches

TRANSFER
  artifact bodies; blob upload/download capabilities

PUBLISH
  validate artifacts; optional ref CAS operations

ACK
  accepted/rejected IDs, repo receipt sequence, next cursor

DONE
  summary and stable resume token
```

HTTP/2 または HTTP/3 上の通常 HTTPS API から始める。custom binary session を最初から作らず、bounded request/response と streaming blob endpoint を分ける。

### 8.3 inventory v0

v0 は `artifact_id ASC` の cursor paging を使う。

```http
GET /v0/projects/{id}/inventory?after=sha256:...&limit=1000
```

response は ID、kind、logical clock、必要なら小さい blob reference summary を返す。client と server が各 page を比較し、missing IDs を batch WANT する。

これは million-artifact repository に最適ではないが、次の利点がある。

- implementation と correctness test が小さい。
- resume cursor が単純である。
- SQL index scan で実装できる。
- 実測値から次の optimization を選べる。

最適化の導入順は次を推奨する。

1. gzip/br compression と ID binary encoding
2. first-byte/first-two-byte prefix ごとの count + digest
3. Fossil cluster に近い immutable inventory artifact
4. persistent Merkle trie
5. 必要なら IBLT など specialized set reconciliation

Merkle tree を先に導入すると、artifact insert ごとの summary 更新、crash consistency、schema migration、partial clone との関係まで同時に設計する必要がある。v0 のリスク削減には寄与しにくい。

Fossil の sync も、根本は unordered artifact set と `igot`/`gimme` であり、cluster は network traffic を減らす optimization と明記されている。この段階的な考え方を継承する。

参考:

- [The Fossil Sync Protocol](https://fossil-scm.org/home/doc/trunk/www/sync.wiki)
- [Fossil File Formats: clusters](https://fossil-scm.org/home/doc/trunk/www/fileformat.wiki)

### 8.4 partial clone

source blob が巨大な project では、全 blob download を clone の必須条件にしない。

clone profile を明示する。

- `metadata`: artifact graph と projection 再構築に必要な小さい body のみ。
- `source`: current checkpoint の source blob を追加。
- `history`: 全 source history を追加。
- `complete`: attachment、release を含む全 blob。

「clone は完全 backup」という思想は `complete` で守りつつ、通常利用には lazy blob fetch を許す。partial clone は欠落をエラーではなく `promised blob` として local DB に記録する。

### 8.5 conflict semantics

artifact set の union は衝突しない。しかし derived current state は衝突し得る。

| 対象 | v0 の規則 |
|---|---|
| comment/post | append-only。重複 ID は dedupe |
| file snapshot | parent DAG。複数 head は conflict として保持 |
| ref | authority で CAS。自動 last-write-wins にしない |
| issue title/status | causal parent を持つ event。concurrent update は両方保持し、projection に conflict を出す |
| labels | add/remove event。remove は対象 add/event を明示 |
| wiki | revision parent。concurrent revision は複数 head |
| deletion | tombstone artifact。物理削除とは分離 |

`created_at` が新しい方を勝者にすると、clock skew と悪意ある timestamp で state が変わる。表示上の stable order が必要なら `(logical_clock, artifact_id)` を tie-break に使うが、concurrent update を消したことにはしない。

MVP では高度な CRDT を一般化せず、kind ごとに reducer と conflict rule を仕様化する。

---

## 9. Fossil からさらに明示的に継承すべきこと

Fossil の file format は、global state を unordered artifact set とし、物理的な SQLite blob/delta storage は implementation detail と区別している。また cluster artifact は削除しても project code を損なわない optimization である。

EdgeFossil も object を次の二群へ分けるべきである。

### 9.1 semantic object

失うと project の意味が変わる。

- blob
- snapshot/change
- issue/wiki/discussion event
- relation/tombstone
- signature/attestation

### 9.2 acceleration object

削除・再構築しても意味が変わらない。

- FTS index
- prefix summary
- Merkle node
- delta cache
- generated archive
- thumbnail
- notification delivery record

この分類を schema と export format に記載すれば、100 年後の reader はどこまで読めば意味を復元できるか判断できる。

参考:

- [Fossil File Formats](https://fossil-scm.org/home/doc/trunk/www/fileformat.wiki)
- [Fossil Delta Format](https://fossil-scm.org/home/doc/trunk/www/delta_format.wiki)

---

## 10. GC、削除、復旧

### 10.1 R2 GC の安全条件

R2 list を唯一の source of truth にせず、DO の blob index と canonical graph から mark set を作る。

```text
roots
├ current refs
├ retained checkpoints/releases
├ open proposals
├ tombstone retention window
├ active upload sessions
└ export/backup leases
        ↓
transitive mark
        ↓
unmarked + older than grace period
        ↓
delete candidates
```

必要な防護:

- 最短 grace period を設ける。例えば 7–30 日。
- upload 中 object を lease で保護する。
- GC run ごとに `mark_epoch` を持つ。
- sweep 前に repository generation が変わっていないか確認する。
- delete は batch ごとに audit log を残す。
- dry-run と candidate export を用意する。
- cross-project dedupe をしないことで project 削除を局所化する。

R2 delete 後は即時に存在しなくなるため、GC bug を R2 consistency が救うことはない。PITR も R2 object を復元しない。

### 10.2 user-visible deletion

次を区別する。

1. hide: projection から非表示。
2. tombstone: project history 上の削除を記録。
3. retention expiry: policy により回収可能になる。
4. physical erase: R2/DO から bytes を削除。
5. cryptographic erase: 将来 per-project key を使う場合の key destruction。

通常の undo は新しい compensating artifact で行う。PITR は operator が事故復旧に使う最後の手段で、日常 UI の undo には使わない。

### 10.3 backup/export

完全 backup の条件は次である。

- canonical artifact bodies
- artifact relations
- referenced blob bytes
- actor public keys と signatures
- project-level portable policy
- format version と hash test vector
- integrity manifest

DO SQLite の raw database export に依存せず、application API で artifact を page scan して bundle を構築する。Workflows は cursor を保持し、R2 上へ streaming archive/chunk を生成する。

export 完了時に全 entry の hash と bundle root digest を記録し、別実装の `verify` command で Cloudflare なしに検証できるようにする。

---

## 11. Security model

### 11.1 threat model

最低限、次を想定する。

- 認証済み client が不正な parent、巨大 graph、偽 hash を送る。
- presigned URL が漏洩する。
- 同じ operation が timeout 後に再送される。
- decompression bomb、深い CBOR nesting、path traversal が送られる。
- private project の blob hash 存在有無を推測される。
- Queue/alarm が重複実行される。
- compromised member が権限失効前に offline artifact を作り、失効後に送る。
- webhook recipient が遅い、失敗する、同じ event を複数回受ける。

### 11.2 validation boundary

hash が正しいことと、その artifact を受理してよいことは別である。publish 時に次を検証する。

- authenticated principal と actor key の binding
- 現在の project ACL
- artifact kind ごとの capability
- schema version と byte-size/depth/count limit
- canonical encoding
- hash と signature
- parents の存在または明示的 phantom policy
- logical clock
- referenced blob の verified state
- path policy
- per-operation quota
- expected ref generation

offline artifact の作成時刻ではなく、**server が受理する時点の ACL** を適用する。必要なら管理者が historical exception として署名付き import を行う。

### 11.3 presigned upload

- expiry を短くする。
- exact staging bucket/key/method を署名する。
- 可能なら content type、size、checksum に関する header を署名条件へ含める。
- upload capability の発行前に quota を reserve する。
- finalize 前に R2 HEAD/checksum と session owner を確認する。
- verified staging object だけを write-once final key へ server-side promote する。
- capability を bearer token として log や referrer に出さない。
- incomplete multipart upload に lifecycle policy を設定する。

### 11.4 resource limits

protocol 自体に Cloudflare 上限より小さい application limit を設ける。

初期値の候補:

| 対象 | v0 application limit 候補 |
|---|---:|
| artifact body | 256 KiB |
| parents/artifact | 64 |
| edges/artifact | 10,000 |
| CBOR nesting | 32 |
| path bytes | 1,024 |
| artifacts/publish batch | 100 |
| WANT IDs/request | 1,000 |
| small upload | 16 MiB |
| Queue payload | 16 KiB を目標 |

値は benchmark で調整するが、unbounded input は許さない。

---

## 12. 「1 project = 1 DO」の適用範囲

### 12.1 MVP では正しい

repository は ref、issue state、wiki head、permission を協調更新する atom である。Cloudflare 自身も DO を「coordination atom」ごとに作ることを推奨している。

単一 DO にする利点:

- ref、artifact index、projection、outbox を一 transaction で更新できる。
- timeline sequence を簡単に採番できる。
- race condition の説明が小さい。
- local SQLite model と比較しやすい。
- project ごとの fault/isolation boundary になる。

### 12.2 適用限界

- metadata が 10 GB に近づく。
- sustained write が single object throughput を超える。
- geographically distributed team で authority location への RTT が問題になる。
- FTS/indexing が canonical write latency を圧迫する。
-巨大 monorepo の inventory scan が DO CPU/row read cost を圧迫する。

### 12.3 先に telemetry を入れる

sharding 実装より前に、project ごとに次を測る。

- request rate、write rate、p50/p95/p99 latency
- DO overloaded/retryable errors
- SQLite bytes、rows/table、rows read/write
- artifact count、blob count、average body size
- inventory bytes/sync と missing ratio
- outbox lag、Queue retry/DLQ
- R2 Class A/B operations と stored bytes
- export duration と chunk count

### 12.4 将来の sharding 案

必要になった場合の候補は、project control plane と immutable data plane の分離である。

```text
ProjectControlDO
├ ACL / refs / repository generation
├ shard directory
└ operation coordinator
       │
       ├ ArtifactShardDO[hash prefix]
       ├ ProjectionDO[issue/wiki/search]
       └ R2 blobs
```

ただし cross-DO transaction はないため、これは単純な scale-up ではなく protocol 変更である。project generation、prepared operation、idempotent commit、recovery workflow が必要になる。

従って v0 format に物理 shard ID を入れない。portable artifact ID が変わらなければ、cloud implementation は後から分割できる。

---

## 13. Search と timeline

### 13.1 timeline

二つの order を明示する。

- causal order: artifact parents と logical clock。
- repository receipt order: DO が付ける `repo_seq`。

Web UI の既定 timeline は `repo_seq DESC` でよい。offline で数日前に作られた artifact が今日同期された場合、`created_at` と `received_at` の両方を表示する。

portable export の reader は `repo_seq` なしでも causal graph を表示できる。server receipt も export する場合は、authority 固有の補助情報として扱う。

### 13.2 FTS5

DO SQLite が FTS5 を support するため、MVP の project 内全文検索は次で十分である。

- issue title/body/comment
- wiki title/body
- discussion title/body
- commit/checkpoint message
- path

source code 全文を最初から FTS に入れると row write、storage、migration cost が増える。v1 では current tree の text file のみ、size/MIME allowlist 付きで opt-in にする。

Queue consumer が検索 index を更新する場合、write 直後の検索に lag が出る。MVP は小さい metadata projection を canonical transaction 内で更新し、重い source indexing だけ Queue に分離する。

### 13.3 WebSocket

live timeline は canonical write の結果ではなく通知経路である。

- client は notification を受けたら `after_repo_seq` で authoritative delta を再取得する。
- WebSocket message 自体を state と見なさない。
- reconnect 時も同じ API で catch up する。
- Hibernation API を使い、idle connection の duration charge を抑える。

---

## 14. Cost model で見るべきもの

初期段階では正確な月額予測より、操作ごとの cost unit を計測する。

### 14.1 主要 cost driver

- Worker/DO request と CPU/duration
- DO SQLite rows written。index 一つの更新も追加 row write として数えられる。
- R2 stored GB-month
- R2 Class A: PUT、multipart part、LIST など
- R2 Class B: GET、HEAD など
- Queue は 64 KB chunk ごとの write/read/delete。通常一 message が最低 3 operations。
- Workflow request、CPU、steps、persisted state

2026-08-24 時点で R2 Standard は storage $0.015/GB-month、Class A $4.50/million、Class B $0.36/million で egress は無料である。価格は変わるため、製品仕様には固定値を埋め込まない。

参考:

- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/)

### 14.2 cost を抑える設計

- blob existence の HEAD を無制限に繰り返さず、DO blob index を先に見る。
- Queue payload は ID のみとし、64 KB を超えない。
- FTS index 数を増やしすぎない。
- multipart part を小さくしすぎない。
- inactive repository を polling せず、必要な時だけ alarm を設定する。
- WebSocket Hibernation を使う。
- export intermediate は R2 に置き、Workflow state に埋め込まない。

---

## 15. 実装ロードマップ

初期案の機能別 Phase よりも、リスク別に順序を変更する。

### Phase 0: executable specification

成果物:

- artifact format v0 draft
- deterministic CBOR profile
- 50 個以上の golden test vectors
- valid/invalid corpus
- SHA-256 と Ed25519 の cross-language test
- bundle manifest v0
- error code registry

合格条件:

- Rust と TypeScript が同じ logical object から同じ bytes と artifact ID を生成する。
- non-canonical CBOR、duplicate key、wrong hash、wrong signature を両実装が同じように reject する。

### Phase 1: local repository only

成果物:

- Rust CLI + local SQLite
- raw blob insert
- snapshot/checkpoint
- timeline
- issue event の最小 reducer
- export/import/verify

合格条件:

- export → empty DB import → export で semantic root が一致する。
- process kill を各 write point で注入しても DB が破損しない。
- concurrent issue update を loss なく保持する。

Cloudflare を触る前に portable model を固定する。これは vendor-independent design という構想の検証でもある。

### Phase 2: cloud single-repository PoC

成果物:

- Edge Worker
- RepositoryDO + SQLite schema
- R2 small blob upload
- artifact publish transaction
- ref CAS
- outbox + alarm + Queue consumer
- API token auth

合格条件:

- R2 PUT、DO transaction、Queue send の各境界で failure injection し、visible artifact が missing blob を参照しない。
- 同じ operation を 100 回再送して結果と side effect が一つになる。
- Queue duplicate/out-of-order delivery で projection/notification が壊れない。

### Phase 3: sync v0

成果物:

- HELLO/AUTH/INVENTORY/WANT/TRANSFER/PUBLISH/ACK
- cursor resume
- partial clone profile
- phantom/promised blob
- conflict reporting

合格条件:

- random disconnect の後、再開して artifact set が一致する。
- local A、local B、cloud の三者で順番を変えて同期しても canonical set が収束する。
- ref conflict が last-write-wins で消えない。

### Phase 4: large blob と complete export

成果物:

- presigned/multipart upload
- quota reservation
- orphan cleanup
- Workflow export
- bundle verify
- restore drill

合格条件:

- 100 MB、1 GB、multipart test object を memory buffer 化せず処理できる。
- complete export を別実装または local CLI で復元できる。
- DO PITR だけに依存せず、cloud を空にした環境へ restore できる。

### Phase 5: Web UI and collaboration

成果物:

- timeline/files/history
- issue/wiki
- live notification
- proposal
- role-based permissions

合格条件:

- WebSocket disconnect/reconnect で timeline event を欠落しない。
- permission revocation 後の offline publish を reject する。
- public read と collaborator write を別 capability として運用できる。

### Phase 6: measured optimization

telemetry に基づき、必要なものだけを追加する。

- prefix inventory summary または Merkle trie
- delta transfer/cache
- source FTS
- metadata sharding
- Git import/export bridge

---

## 16. 最初に作る API surface

v0 で必要な endpoint を次に限定する。

```text
POST /v0/projects
GET  /v0/projects/{project}

POST /v0/projects/{project}/uploads
POST /v0/projects/{project}/uploads/{upload}/finalize

POST /v0/projects/{project}/artifacts:publish
GET  /v0/projects/{project}/artifacts/{artifact}
GET  /v0/projects/{project}/inventory

GET  /v0/projects/{project}/blobs/{blob}

GET  /v0/projects/{project}/refs
POST /v0/projects/{project}/refs:compare-and-swap

GET  /v0/projects/{project}/timeline?after_seq=...

POST /v0/projects/{project}/exports
GET  /v0/projects/{project}/exports/{export}
```

API 原則:

- mutation は `operation_id` を必須にする。
- opaque cursor を使う。
- batch size と body size に server-side 上限を持つ。
- error は machine-readable code、retryable、current state を返す。
- overload error は無条件 retry しない。retryable error のみ jitter 付き exponential backoff を使う。
- protocol/version/capability negotiation を `HELLO` 相当 endpoint で行う。

DO infrastructure error には retryable/overloaded の区別がある。overload に即時 retry を重ねると悪化するため、client SDK が policy を共通実装する。

参考:

- [Durable Objects error handling](https://developers.cloudflare.com/durable-objects/best-practices/error-handling/)

---

## 17. 検証戦略

### 17.1 property tests

- encode/decode round trip
- canonical bytes uniqueness
- artifact ID stability
- reducer determinism under valid topological permutations
- set union idempotence、commutativity、associativity
- ref CAS linearizability model
- export/import semantic root preservation

### 17.2 fault injection

各処理で次の位置に failure を入れる。

- R2 PUT 前/後
- upload finalize の HEAD 前/後
- DO transaction 前/中/後
- response 送信前
- outbox insert 後
- Queue send 前/後
- consumer side effect 前/後
- Workflow step 前/後
- GC mark/sweep 間

client からは「成功 response を受ける前に server で commit 済み」が普通に起こる。従って retry safety は optional enhancement ではなく core requirement である。

### 17.3 differential tests

Rust local implementation と TypeScript Worker implementation に同じ corpus を与え、次を比較する。

- canonical bytes
- hashes
- signatures
- schema validation result
- reducer output
- export manifest

### 17.4 scale tests

最低でも次の synthetic repository を作る。

1. 100 万の小 artifact、blob 少数。
2. 100 万 file の single snapshot。
3. 10 万 issue comments。
4. 1–10 GB の large blobs を含む project。
5. 100 clients の concurrent ref CAS。
6. outbox/Queue を意図的に停止した backlog。

測るのは throughput だけではない。

- DO storage size
- row reads/writes と cost
- inventory transfer bytes
- cold start/hibernation 復帰 latency
- sync resume の重複転送量
- GC false-positive がゼロであること

---

## 18. 未解決の設計課題

実装開始前にすべて決める必要はないが、decision record が必要である。

### 必ず Phase 0 で決める

- deterministic CBOR の厳密な profile
- artifact kind versioning と unknown field rule
- path policy
- actor key rotation/revocation の表現
- semantic root の計算法
- bundle container と manifest
- logical clock の検証規則

### Phase 2 までに決める

- single shared R2 bucket と bucket-per-jurisdiction の構成
- upload checksum の強制方法
- quota reservation と orphan retention
- ACL model
- server receipt の export 可否
- outbox batch/retry/DLQ policy

### Phase 3 までに決める

- shallow/partial clone の promised object semantics
- issue/wiki の concurrent update UI
- force ref update capability
- sync cursor の snapshot isolation
- server が phantom を受け入れる範囲

### 実測まで決めない

- Merkle tree の形
- delta algorithm
- artifact shard 数
- external search database
- cross-project deduplication

---

## 19. 推奨する最初の ADR

次の Architecture Decision Record を最初に作ると、実装中の議論がぶれにくい。

1. ADR-001: Portable state / authority state / derived state の分離
2. ADR-002: SHA-256 と deterministic CBOR v0 profile
3. ADR-003: Artifact signature と server receipt の分離
4. ADR-004: MVP は 1 project = 1 RepositoryDO
5. ADR-005: R2 key は project scope、cross-project dedupe なし
6. ADR-006: Upload-then-finalize protocol
7. ADR-007: Ref は compare-and-swap
8. ADR-008: Transactional outbox + DO alarm + at-least-once Queue
9. ADR-009: Sync v0 は paged inventory、Merkle は延期
10. ADR-010: PITR と portable backup の役割分離
11. ADR-011: `created_at` は因果順序に使わない
12. ADR-012: Conflict は kind-specific reducer で保持する

---

## 20. 最終提案

EdgeFossil の最初の製品定義は、GitHub の機能を広く再実装することではない。

次の一本の縦切りを完成させることである。

```text
local raw bytes
  ↓ SHA-256
blob + canonical artifact
  ↓ local SQLite transaction
offline project history
  ↓ resumable HTTPS sync
R2 verified blob
  ↓ RepositoryDO publish transaction + ref CAS
authoritative project state
  ↓ transactional outbox
Queue/WebSocket notification
  ↓ portable export
Cloudflare なしで verify/import 可能な bundle
```

この縦切りが、次の不変条件を満たせば構想の核心は成立する。

1. visible artifact は verified blob だけを参照する。
2. mutation の再送は副作用を増やさない。
3. concurrent ref update を黙って失わない。
4. Queue/WebSocket の欠落や重複で canonical state は変わらない。
5. local、cloud、export の物理形式が違っても artifact ID は一致する。
6. clone/import 後に project の semantic root が一致する。
7. Cloudflare account を失っても complete bundle から復元できる。

初期案の最大の強みは、Fossil の「一つの project」と「unordered artifact set」を Cloudflare の stateful serverless primitive に対応づけた点にある。

追加調査から得られた最も重要な修正は、Cloudflare の各 product を単純に機能へ割り当てるのではなく、次のように**整合性の役割**を割り当てることである。

```text
RepositoryDO SQLite
  = authorization, serialization, CAS, receipt order, projection, outbox

R2
  = verified immutable bytes; publish 前に存在を確定

Queues / WebSocket
  = canonical state から再生成できる通知

Workflows
  = cursor と retry を持つ長期 orchestration

Portable artifact format
  = どの Cloudflare product よりも長く残す本体
```

この境界を守れば、MVP は小さく作れる。同時に、後から search、proposal、release、CI、AI、sharding を追加しても、永続 project history の意味を変更せずに済む。

---

## 参考資料

### Fossil

- [Fossil File Formats](https://fossil-scm.org/home/doc/trunk/www/fileformat.wiki)
- [The Fossil Sync Protocol](https://fossil-scm.org/home/doc/trunk/www/sync.wiki)
- [Fossil Delta Format](https://fossil-scm.org/home/doc/trunk/www/delta_format.wiki)
- [Fossil Artifact Identification](https://fossil-scm.org/home/doc/trunk/www/hashes.md)

### Cloudflare Durable Objects

- [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [SQLite-backed Durable Object Storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [Durable Objects data location](https://developers.cloudflare.com/durable-objects/reference/data-location/)
- [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [Durable Objects error handling](https://developers.cloudflare.com/durable-objects/best-practices/error-handling/)

### Cloudflare R2

- [R2 consistency model](https://developers.cloudflare.com/r2/reference/consistency/)
- [R2 limits](https://developers.cloudflare.com/r2/platform/limits/)
- [R2 data location](https://developers.cloudflare.com/r2/reference/data-location/)
- [R2 upload methods](https://developers.cloudflare.com/r2/objects/upload-objects/)
- [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)

### Cloudflare Queues / Workflows / Workers

- [Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [How Queues works](https://developers.cloudflare.com/queues/reference/how-queues-works/)
- [Queues limits](https://developers.cloudflare.com/queues/platform/limits/)
- [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)
- [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/)
- [Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)

### 標準仕様

- [RFC 8949: Concise Binary Object Representation](https://www.rfc-editor.org/rfc/rfc8949.html)
- [RFC 8785: JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785.html)
