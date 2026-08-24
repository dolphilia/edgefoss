# EdgeFossil の追跡・公開・アクセス制御を分離する設計調査メモ

調査日: 2026-08-24  
位置づけ: 以下の設計・調査を前提とした、repository 内の情報公開範囲に関する追加検討

- [`Cloudflare Workersネイティブな「Fossilの後継」を設計する — 統合型SCMの再構成案.md`](./Cloudflare%20Workersネイティブな「Fossilの後継」を設計する%20—%20統合型SCMの再構成案.md)
- [`EdgeFossil実装具体化のための深掘り調査メモ.md`](./EdgeFossil実装具体化のための深掘り調査メモ.md)
- [`EdgeFossil単一プロジェクト版とDOなし構成の調査メモ.md`](./EdgeFossil単一プロジェクト版とDOなし構成の調査メモ.md)

## 1. 問題設定

一般的な SCM では、次の概念が暗黙に重なっている。

- repository が public か private か
- file を version control で追跡するかしないか
- Web UI に file を表示するか
- clone/fetch で file を配布するか
- search、archive、release、build に file を含めるか

しかし実際の project には、単純な二択で表せない情報がある。

- public project だが、運用手順や脆弱性対応メモは team 内だけで履歴管理したい。
- file は public clone に含めてよいが、生成物や vendored file を Web の file browser には出したくない。
- 個人の作業メモを履歴化したいが、project authority へは一切送信したくない。
- maintainer だけが読む release signing 手順を project と一緒に同期したい。
- private input を使った build output を、review 後にだけ public release したい。
- issue、wiki、discussion、attachment にも source file と同じ公開範囲を適用したい。

従って EdgeFossil では、**追跡されるか、誰が読めるか、どこに表示されるか、どの同期・export に含まれるかを別々の軸として扱う**必要がある。

本メモでは、読取可能な情報集合を **realm**、特定の読取権限から構成される repository の見え方を **view** と呼ぶ。

---

## 2. 結論

### 2.1 repository 全体の public/private を廃止するのではなく、default policy にする

project の `public`、`private` は便利な初期値として残す。ただし全 object に固定的に伝播する唯一の属性にはしない。

```text
public project
├ public realm                 通常の source、公開 issue/wiki
├ members realm                team 内文書、未公開調査
├ maintainers realm            release key 運用、embargo 情報
└ device-local                 個人メモ、試行錯誤の local history
```

「public project」は、public view を匿名で提供する project という意味になる。project 内の全情報が public であることまでは意味しない。

### 2.2 最低でも七つの軸へ分ける

| 軸 | 代表値 | 答える問い |
|---|---|---|
| tracking | `none` / `local` / `project` | 履歴を残すか、どこに残すか |
| read realm | `public` / `members` / `maintainers` / custom | 誰が content を取得できるか |
| Web exposure | `full` / `metadata` / `hidden` | Web UI に何を表示するか |
| replication | `public` / realm 限定 / `never` | clone/fetch に含めるか |
| materialization | `eager` / `lazy` / `never` | checkout で working tree に出すか |
| indexing | `content` / `metadata` / `none` | search index に何を入れるか |
| export/publish | public / realm 限定 / authority-only | archive、release、backup に含めるか |

必要に応じて retention、notification、build input/output も独立 policy にする。

### 2.3 「Web 非表示」は機密保持ではない

次の設定は file browser から消すだけで、秘密にはしない。

```text
tracking = project
realm = public
web = hidden
replication = public
```

anonymous clone、downloadable bundle、過去履歴、直接 object URL のいずれかから取得できるなら、その file は public である。この mode は generated file や見通しを悪くする補助資料には使えるが、機密情報には使えない。

機密保持が必要な例では次が必要になる。

```text
tracking = project
realm = maintainers
web = hidden
replication = realm
indexing = none
export = realm
```

UI と CLI では、前者を **Web-hidden（非機密）**、後者を **Restricted（機密）** と明確に呼び分ける。

### 2.4 推奨方式は realm ごとの履歴と view の合成である

一つの完全な tree から request 時に private entry を除去するだけでは不十分である。完全 tree の hash、file 名、artifact ID、diff 統計、commit message が public response に漏れる可能性がある。

推奨する永続モデルは次の通りである。

- artifact/blob/tree entry は作成時に一つの realm へ所属する。
- realm ごとに独立した tree root と change DAG を持つ。
- client の view は、読める realm の tree を規則的に重ねて構成する。
- public API、static site、public export は public realm だけから生成する。
- restricted artifact の ID、path、件数を public artifact から参照しない。
- realm 間移動は通常の rename ではなく、明示的な公開・制限操作にする。

これにより、public view 自体を独立して hash 検証・clone・export できる。

### 2.5 一度 public にした情報は、実質的には private に戻せない

公開済み object を storage と cache から削除しても、既存 clone、download、mirror、第三者 cache は回収できない。history rewrite も既に取得された情報を失効させない。

従って分類変更には非対称性がある。

- restricted → public: review 付き **declassification/promotion**。新しい public artifact を作る。
- public → restricted: 将来の配布を止める **distribution stop**。過去公開分の秘密化とは呼ばない。

---

## 3. 用語と脅威モデル

### 3.1 realm

realm は「同じ content を読む能力を共有する audience」である。

組み込み realm は次のようにできる。

```text
public ⊆ members ⊆ maintainers
```

ただし custom realm は常に一直線にはならない。

```text
                  ┌ security-team
public ─ members ─┤
                  └ release-team
```

従って実装では単一の `visibility_level` 整数だけに依存せず、principal が持つ capability と realm 間の `can_read` 関係を使う。組み込み realm には便利な包含関係を与え、custom realm 同士は比較不能にできる。

### 3.2 view

view は、ある principal が特定時点に観測できる project state である。

| view | 含む realm の例 |
|---|---|
| anonymous/public | `public` |
| member | `public + members` |
| maintainer | `public + members + maintainers` |
| security team | `public + members + security-team` |
| authority-complete | authority が管理する全 realm。通常利用者へは提供しない |

view は単なる UI filter ではない。inventory、tree root、timeline、search、notification、export の入力集合そのものである。

### 3.3 守る対象

restricted realm では本文だけでなく、次も情報になり得る。

- file/path 名
- content hash と artifact ID
- object の存在と size
- change の件数、時刻、author
- commit/change message
- diff statistics
- private issue/wiki の title、label、link
- build input と output の関係
- presigned URL、R2 object key
- log、trace、Queue message、webhook payload

既定の restricted policy は、これらを public view に出さない **opaque** mode とする。存在だけを placeholder で示す `metadata` mode は、利用者が漏えいを理解して明示した場合だけ許可する。

### 3.4 非目標

realm は次を自動的には保証しない。

- authorized member が閲覧後に content を持ち出さないこと
- 端末 malware からの防御
- 公開済み情報の回収
- path rule だけによる secret の完全検出
- Cloudflare operator からも本文を隠す end-to-end encryption

最後の要件には、後述する sealed realm が別途必要になる。

---

## 4. 追跡状態を三段階にする

### 4.1 `tracking = none`

従来の untracked/ignored file である。

- EdgeFossil artifact を作らない。
- authority へ送らない。
- export、search、backup の対象外。
- `.efignore`、個人 exclude、global exclude で選択する。

secret を `none` に置けば誤 push は避けられるが、履歴・共有・監査も得られない。

### 4.2 `tracking = local`

local repository のみで immutable history を作る。

- local SQLite/blob store に保存する。
- project の synced tree/artifact から参照しない。
- sync inventory に ID や path を出さない。
- portable project export に含めない。
- local backup は利用者が明示した別 profile で行う。

これは個人メモや実験記録に適する。「local だが cloud backup したい」場合は project realm と混同せず、個人専用の encrypted backup channel を別機能として設計する。

### 4.3 `tracking = project`

project authority が履歴を受理する。ここで初めて realm、replication、Web、index、export policy が意味を持つ。

重要な不変条件は次である。

> project-synced artifact は、local-only artifact/blob を参照してはならない。

参照を許すと、別端末で tree を再構成できず、参照先の ID だけが意図せず同期されるためである。

---

## 5. realm ごとの artifact model

### 5.1 realm は immutable な artifact identity の一部にする

artifact body の概念例を示す。

```text
ArtifactBody {
  format_version
  project_id
  realm_id
  kind
  parents[]
  payload
}

artifact_id = SHA-256(canonical_cbor(ArtifactBody))
```

同じ byte content でも public artifact と restricted artifact は別の security context にある。realm binding を署名対象に含めることで、artifact ID を変えずに metadata だけ public へ書き換える攻撃を防ぐ。

blob の論理 hash は artifact payload に含めてもよいが、restricted realm の hash はその realm の外へ配布しない。

### 5.2 下位 realm への参照を禁止する

情報 flow rule を次のようにする。

- restricted artifact → public artifact/blob の参照: 許可できる。
- public artifact → restricted artifact/blob の参照: 拒否する。
- 比較不能な custom realm 間の参照: 両方を読める合成 realm を作るか拒否する。

特に public tree、public change、public issue は restricted ID を保持してはならない。`[private file changed]` のような placeholder も、存在を見せる deliberate metadata policy がない限り生成しない。

### 5.3 realm ごとに tree と history root を持つ

```text
Project authority
├ public_head      → public change DAG      → public tree
├ members_head     → members change DAG     → members overlay tree
├ maintainers_head → maintainers change DAG → maintainers overlay tree
└ custom heads ...
```

member checkout は public tree に members overlay を重ねる。path collision が起きた場合に暗黙の上書きを許すと、公開版と内部版で異なる source が同じ path に見える危険があるため、次のどちらかを project policy で固定する。

1. realm をまたぐ同一 path を禁止する。MVP の推奨。
2. restricted overlay を優先するが、CLI/UI で明示し、build view も固定する。将来候補。

### 5.4 一回の作業を realm ごとの change に分割する

一つの working tree commit が public file と private file を変更した場合、canonical history は realm ごとの subchange に分ける。

```text
Local logical operation L42
├ public change P18       message: public-safe summary
└ maintainers change M7   message: full internal summary
```

authority 内部の operation receipt は両者を関連付けられるが、public receipt/timeline は `M7` の ID、存在、件数を含めない。public change の parent は前の public change であり、private envelope を親にしない。

DO/D1 profile では一つの authority transaction で複数 realm head を更新できる。`single-r2` では private な `control/HEAD` の CAS transaction に全 realm 更新を含め、public `HEAD` は public data だけから作る derived object とする。public client が protected `control/HEAD` を読む構成にしてはならない。

### 5.5 message、author、時刻も realm 別にする

本文を分離しても、`Fix parser after incident in customer-X private fixture` のような message は漏えいする。

- change message は realm ごとに入力できる。
- public summary は private message から自動切り出ししない。
- author identity の公開 alias を設定できる。
- public timeline の件数・sequence は public change だけで採番する。
- logical operation の wall-clock timing を過度に相関できる点は残余 risk として扱う。

---

## 6. 分類変更と履歴

### 6.1 restricted から public への promotion

promotion は label 書き換えではなく、新しい public content の作成である。

```text
restricted blob/artifact
        │ review, secret scan, approval
        ▼
new public blob/artifact ──► public tree/change
        │
        └ internal audit record: source → target
```

public artifact は restricted source ID を参照しない。対応表は restricted audit realm にだけ置く。

推奨 gate:

- public になる正確な diff を表示
- path、content、metadata、history message を検査
- secret scanner/DLP hook
- optional two-person approval
- signed declassification receipt
- `--yes` だけでは bypass できない protected branch/policy

### 6.2 public から restricted への変更

新しい public tree から path を削除し、以後の version を restricted realm に作ることはできる。しかし過去の public artifact は取得済みと仮定する。

処理としては次を行う。

- public head から削除 change を作る。
- public object route と index から外す。
- CDN/cache を purge する。
- public archive/download bundle を再生成する。
- mirror operator へ security notice を送れるようにする。
- credential の場合は必ず rotate/revoke する。

UI はこれを「非公開化」ではなく「今後の配布を停止」と説明する。

Cloudflare R2 自体の delete は strong consistency だが、custom domain の cache に残る object は purge/TTL expiry まで提供され得る。さらに Cloudflare cache を purge しても第三者が保存した copy は消せない。

### 6.3 policy 変更は過去 artifact を自動再分類しない

現在の path rule を過去全履歴へ遡及適用すると、artifact identity と署名が変わり、既に配布済みの view と矛盾する。

- policy は新しい write の既定値と上限を決める。
- artifact の realm は作成時に固定する。
- 既存 path の移行は明示的な promotion/restriction operation にする。
- history 全体の scrub は緊急手順として別扱いにし、完全な回収を約束しない。

---

## 7. policy 記述

### 7.1 三種類の policy source

| source | 用途 | authority へ同期 |
|---|---|---|
| `.efignore` | project 共通の非追跡 default | public でよい範囲を同期 |
| `.edgefossil/attributes` | realm/Web/index/export の project rule | 適切な管理 realm で同期 |
| local config/exclude | 端末固有の untracked/local-history rule | 同期しない |

機密 path pattern 自体が情報になる場合があるため、security rule 全体を public file に置かない。public default と restricted policy を分け、authorized client は authority から policy decision と説明を取得する。

### 7.2 rule の例

公開されるが Web browser には出さない例:

```toml
[[rule]]
pattern = "generated/**"
tracking = "project"
realm = "public"
web = "hidden"          # 非機密。public cloneには含まれる
replication = "public"
materialization = "lazy"
indexing = "none"
export = "public"
```

maintainer だけで共有する例:

```toml
[[rule]]
pattern = "ops/release/**"
tracking = "project"
realm = "maintainers"
web = "hidden"
replication = "realm"
materialization = "lazy"
indexing = "none"
export = "realm"
```

端末だけで履歴化する例:

```toml
[[rule]]
pattern = "notes/private/**"
tracking = "local"
replication = "never"
materialization = "eager"
indexing = "local"
export = "local-backup-only"
```

### 7.3 path rule は default であり、classification の唯一の根拠ではない

利用者は特定 file/change をより restricted に指定できる。一方、client が勝手に project policy より公開側へ緩和してはならない。

```text
effective classification
  = project policy が許す最も公開側の上限
    と author が選んだ classification のうち、より restrictive なもの
```

custom realm が比較不能なら、必要 audience の積集合/新 realm を選ぶか write を拒否する。曖昧な場合に public へ fallback してはならない。

authority は受信した path、tree entry、artifact realm、caller capability を再検証する。security rule を client-side hook だけにしない。

### 7.4 rule precedence と説明可能性

推奨 precedence:

1. authority の mandatory policy
2. path に最も近い project attributes
3. repository root default
4. explicit author choice。ただし restrictive 方向だけ
5. local-only tracking/exclude

`ef status --explain <path>` は、matching rule、source、effective result、public clone/Web/export への包含可否を表示する。

```text
$ ef status --explain ops/release/runbook.md
tracking:       project
read realm:     maintainers
public clone:   excluded
web:            hidden
search:         excluded
public export:  excluded
reason:         authority policy rule ops/release/**
```

---

## 8. clone、sync、checkout、export

### 8.1 inventory は view ごとに生成する

sync client は認証後、取得できる realm capability を negotiation する。

```text
HELLO project_id, protocol_version, requested_view
AUTH  principal proof
VIEW  granted realms, policy_epoch, view_heads
HAVE/WANT per granted realm
```

- anonymous client に public artifact inventory だけを返す。
- inaccessible artifact の hash、size、count を返さない。
- authorization 後に server-side で view を確定する。
- cursor/token は principal、view、policy epoch に bind する。
- ACL revoke 後に古い inventory token で取得できないよう、短命 token と authority check を使う。

### 8.2 partial clone と restricted realm は区別する

`materialization = lazy` は content を後から取得する性能機能であり、access control ではない。public lazy blob の hash/metadata が配布され、誰でも fetch できるなら public である。

restricted blob は、client が realm capability を持つ場合だけ inventory と fetch route が存在する。

### 8.3 checkout view を記録する

同じ project でも view によって tree が異なるため、working copy metadata に次を記録する。

- selected view/realms
- realm heads
- policy epoch
- materialization profile

member view で build/test した結果と public view の結果が違う可能性がある。CI job は必ず input view を宣言し、receipt に記録する。

### 8.4 export profile を別々に署名する

```text
ef export --view public
ef export --view members
ef export --view maintainers
ef export --view authority-complete
ef local backup --include-local-history
```

各 export は独自の view root、realm list、policy epoch、署名を持つ。public export は restricted root や完全 artifact count を含まない。`authority-complete` は disaster recovery 用であり、通常の member download と分ける。

local-history は project export に暗黙追加しない。

---

## 9. file 以外の統合 project data

EdgeFossil が Fossil のような統合型 SCM を目指すなら、realm は source file だけの属性にしてはならない。

### 9.1 issue、wiki、discussion

- object 作成時に realm を持つ。
- comment は target と同じか、より restricted な realm にする。
- public issue から restricted issue/artifact への link は既定で拒否する。
- restricted issue から public source/change への link は許可できる。
- title、label、participant、未読件数も restricted metadata として扱う。
- public sequence number と restricted sequence number を分け、欠番から存在を推定させない。

### 9.2 attachment

attachment は target object の realm を継承するか、より restricted にする。本文だけ private で attachment が public bucket に置かれる事故を schema/authority validation で禁止する。

### 9.3 branch、tag、release

- ref 自体に realm を持たせる。
- public ref は public change だけを指す。
- restricted branch は authorized view にだけ現れる。
- public release manifest は restricted artifact を参照しない。
- release asset は release realm と同じか、より public 側には explicit promotion が必要。

### 9.4 notification、webhook、feed

event envelope に realm を持たせる。consumer は subscriber capability を確認して projection を作る。

- public Atom/RSS に restricted event を出さない。
- generic webhook に完全 payload を入れて受信側で filter しない。
- Queue message は可能なら opaque event ID と realm ID にし、consumer が authority から authorized projection を読む。
- email subject、push notification、badge count からの漏えいも確認する。

---

## 10. build と情報 flow

### 10.1 output は input の最も restrictive な realm を継承する

生成物の既定 rule:

> 複数 input から作る output は、全 input を読める audience にだけ読取を許可する。

組み込み realm が直線なら `max(input classifications)`、一般の realm DAG なら capability 集合の交差として求める。

```text
public source + maintainers config
             │ build
             ▼
maintainers output by default
```

output を public にするには declassification gate を通す。これにより private config、source map、embedded credential、internal path が build artifact へ混入する事故を減らす。

### 10.2 build log と cache も分類する

- CI log は input realm 以上に restricted にする。
- cache key に restricted content hash を public endpoint で使わない。
- public source map に restricted path/source を埋め込まない。
- test failure snapshot、coverage、artifact provenance も output として分類する。
- public preview URL を restricted build に発行しない。

### 10.3 publish は export と別 capability にする

read permission があっても public publish permission があるとは限らない。`read`, `write`, `classify`, `declassify`, `publish`, `admin` を分ける。

maintainer が restricted file を編集できても、単独で public release へ昇格できない policy を設定可能にする。

---

## 11. Cloudflare 上の実装

### 11.1 public と restricted の物理経路を分離する

推奨構成:

```text
Anonymous request
    │
    ▼
Public Worker/static site ──► public R2 bucket ──► custom domain/CDN

Authenticated request
    │ auth + capability check
    ▼
Authority Worker/DO/D1 ─────► restricted R2 bucket via binding
                              (public URL/custom domainなし)
```

R2 bucket は既定で private だが、`r2.dev` または custom domain を有効にすると Internet から object を取得できる。restricted bucket では両方を無効にし、Worker binding 経由だけにする。Cloudflare Access/WAF で custom domain を保護する構成も可能だが、`r2.dev` が有効なままだと迂回経路になるため、機密 repository の基準構成にはしない。

public/restricted を prefix だけで分けるより bucket/binding を分ける方が、cache rule、public access の誤設定、object listing、運用権限の blast radius を小さくできる。

### 11.2 cache policy

| response | policy |
|---|---|
| content-addressed public blob | `Cache-Control: public, max-age=31536000, immutable` |
| public mutable manifest/head | 短い TTL または revalidate、更新時 purge |
| authenticated metadata/content | `Cache-Control: private, no-store` |
| authorization failure | shared cache に保存しない |

Cloudflare Workers は `Cache-Control` を省略した response に heuristic freshness を適用し得るため、restricted response は明示的に `private, no-store` とする。cache key に user/realm を足すだけで restricted response の shared cache 保存を正当化せず、MVP は cache 自体を bypass する。

public custom-domain R2 を cache すると、R2 origin の strong consistency は cache access にはそのまま適用されない。delete/overwrite 後も古い object が TTL expiry または purge まで返り得る。authority head、ACL、policy decision は CDN を経由させない。

### 11.3 restricted download

小さい object は Worker が realm capability を確認し、R2 binding から stream する。

大きい object に presigned URL を使う場合:

- URL は bearer token として扱う。
- exact bucket/key/method に限定する。
- expiry を短くする。
- URL を log、analytics、Referer、issue本文へ残さない。
- 発行前に毎回 current capability を確認する。
- 即時 revoke が必要な content には使わない。

R2 presigned URL は発行後、期限まで URL を知る誰でも操作でき、custom domain ではなく S3 API domain でだけ使える。高機密 realm は Worker streaming を優先する。

### 11.4 R2 object key と deduplication

restricted object の physical key に global plaintext SHA-256 をそのまま使うと、hash を知る者が object の存在を推測したり、誤った endpoint で probing したりする余地が生まれる。

推奨:

- logical plaintext hash は restricted metadata 内で整合性検証に使う。
- physical key は random ID、または `HMAC(realm_key, plaintext_hash)` にする。
- deduplication は同じ realm 内に限定する。
- public と restricted の cross-realm dedup をしない。
- error response、timing、quota statistics から存在を区別しにくくする。

### 11.5 metadata/index の分離

MVP は realm を全 row に持たせ、全 query の先頭で authorization predicate を適用する。public static/index projection は public row だけから別途生成する。

高い保証が必要な realm は、次も検討する。

- realm 別 FTS table/index
- realm 別 R2 prefix/bucket
- public search Worker と restricted search Worker の分離
- cache、Queue、analytics dataset の分離

全文検索後に application code で private result を除く方式は、ranking、result count、snippet、timing に漏えいし得るため採用しない。

### 11.6 authority profile ごとの更新

| profile | realm head/ACL の更新方法 |
|---|---|
| RepositoryDO | 一つの SQLite transaction で ACL epoch、artifact acceptance、realm heads、outbox を更新 |
| D1 | 一つの primary transaction/batch 内で同じ不変条件を維持 |
| `single-r2` | private `control/HEAD` を ETag CAS。transaction object に realm 更新と ACL epoch を含める |
| `single-static` | build 時に view 別 snapshot を生成。browser write は不可 |

`single-r2` の public `HEAD`、inventory、site は protected control journal から生成する derived projection である。public projection の遅延は許せるが、restricted hash を含めてはならない。

### 11.7 encryption

R2 は全 object と metadata を AES-256 で at-rest encryption し、転送時は TLS を使う。これは storage media や通信路に対する保護であり、EdgeFossil の reader authorization の代わりではない。

追加選択肢:

- R2 SSE-C: customer-provided key による server-side encryption。key 管理責任は増えるが、application server は復号 key を扱うため end-to-end secrecy ではない。
- sealed realm: client-side encryption し、realm member ごとに data key を wrap する。Cloudflare 上には ciphertext だけを置く。

sealed realm は将来機能とする。導入すると server-side diff、FTS、preview、secret scan、dedup、key rotation、member revoke 後の再暗号化が難しくなる。MVP の access control と混ぜず、capability negotiation で別機能として扱う。

### 11.8 observability を公開面として扱う

Workers Logs には invocation、custom log、error、request/response metadata が入り得て、Logpush/OpenTelemetry で外部にも出せる。

- path、artifact ID、presigned URL、change message、content を原則 log しない。
- realm-aware structured log schema と field allowlist を使う。
- error object をそのまま `console.log` しない。
- restricted endpoint の URL path に秘密の file 名を入れない、または route log で redact/tokenize する。
- third-party telemetry destination を realm data processor として threat model に含める。
- audit log と diagnostic log を分ける。audit log も閲覧 realm を持つ。

---

## 12. CLI と Web UI

### 12.1 CLI

```text
ef status --visibility
ef status --explain <path>
ef track --realm members <path>
ef track --local <path>
ef hide-web <path>                  # 非機密である警告を表示
ef restrict --realm maintainers <path>
ef promote --to public <path>       # review/declassification flow
ef distribution-stop <path>        # 過去公開分は回収不能と表示
ef untrack --keep <path>
ef clone --view public|members|maintainers
ef export --view public|members|maintainers|authority-complete
```

`ef commit` 前の summary 例:

```text
PUBLIC (anonymous clone/Web)
  M src/parser.ts

PUBLIC, WEB-HIDDEN (not confidential)
  M generated/schema.json

MAINTAINERS (excluded from public clone/export/index)
  M ops/release/runbook.md

LOCAL HISTORY (never synced)
  M notes/private/hypothesis.md
```

複数 realm を含む operation では、realm ごとの message と public diff を確認させる。

### 12.2 Web UI

badge を色だけに依存させず text で表示する。

- Public
- Web-hidden — still public in clone
- Members
- Maintainers
- Custom: Security team
- Local-only
- Untracked

promotion dialog では「誰が読めるようになるか」「どの export/index/cache に入るか」「公開後は回収できない」を一画面で示す。

### 12.3 dangerous combinations を拒否する

- `realm=maintainers, replication=public`: 拒否。
- `tracking=local` なのに project artifact から参照: 拒否。
- public artifact が restricted parent/blob を参照: 拒否。
- restricted attachment を public issue の本文へ embed: 拒否。
- restricted input 由来 output の暗黙 public publish: 拒否。
- anonymous export が restricted root/count を含む: 検証失敗。

「設定として表現できる」ことより、安全でない組合せを schema で表現不能にすることを優先する。

---

## 13. 主な failure mode と対策

| failure mode | 何が漏れるか | 対策 |
|---|---|---|
| Web filter だけで隠す | clone、archive、direct URL から本文 | `web-hidden` を非機密と明記。機密は realm 分離 |
| 完全 tree から request 時に除外 | private path/hash/count | realm 別 tree/view root |
| public change が private parent を持つ | private artifact の存在/ID | realm 別 DAG、public-safe parent |
| commit message を共有 | project/customer/incident 名 | realm 別 message |
| global content hash key | object existence、cross-realm correlation | random/HMAC physical key、realm内dedup |
| search 後 filter | count、snippet、ranking | realm-aware query/index 分離 |
| public bucket の prefix ACL | 誤設定時に全 restricted object | bucket/binding/route 分離 |
| presigned URL 長期発行 | URL 流出後の継続 access | 短命、no-log、高機密は Worker stream |
| public→private を可逆と説明 | clone/cache から回収できない | distribution stop と説明、credential rotate |
| policy change の遡及適用 | history/署名/view root が不整合 | artifact realm immutable、明示 migration |
| private input から public build | embedded secret/path | output は input の security join を継承 |
| Queue/webhook/log に完全 payload | side channel から漏えい | realm-aware envelope、redaction、別 projection |
| ACL revoke と write が race | revoked user の change 受理 | ACL epoch と realm head update を同じ authority orderへ |

---

## 14. 検証計画

### Phase V0: policy model の executable specification

純粋関数として次を実装し property test する。

- principal capability → readable realms
- artifact reference flow validation
- path rule → effective policy
- input realms → output realm
- view merge と path collision
- promotion/restriction state transition

重要 property:

- principal の capability を減らしても、見える object が増えない。
- public projection は restricted artifact の追加/削除だけでは byte-for-byte 変化しない。
- public artifact graph から restricted artifact ID へ到達できない。
- project artifact から local-only object へ到達できない。

### Phase V1: two-realm vertical slice

最初は `public` と `members` だけを実装する。

1. 同じ working operation から realm 別 change を生成
2. anonymous/member clone
3. realm 別 tree/timeline/search
4. public/member export
5. restricted R2 Worker streaming
6. promotion flow

合格条件:

- anonymous API response、static output、export、log、Queue capture を走査して private path/hash/content がない。
- public export の root が private-only change で変化しない。
- expired/revoked credential で private blob/inventoryを取得できない。

### Phase V2: adversarial leakage tests

- guessed artifact/hash/object key
- stale inventory cursor
- ACL revoke と concurrent finalize
- malformed artifact claiming public realm
- rename/copy across realms
- public issue への private attachment/link
- cache poisoning/deception と missing `Cache-Control`
- 404/size/timing existence oracle
- log/error/trace inspection
- public→restricted 後の CDN cache

### Phase V3: custom realm と build provenance

- 比較不能な `security-team` / `release-team`
- realm join を必要とする output
- CI view pinning
- declassification approval
- view-specific signed release/export

sealed realm はこの段階以降の別 PoC とする。

---

## 15. 推奨ロードマップ

### 15.1 MVP

1. `tracking = none/local/project`
2. `public` と `members` の二 realm
3. `web = full/hidden`。`metadata` は延期
4. realm 別 tree/change DAG/inventory/export
5. public/restricted R2 bucket と Worker route の分離
6. authority-side policy validation
7. `status --explain` と promotion warning
8. public search と member search の分離
9. leakage/property test suite

### 15.2 v1

- `maintainers` と custom realm
- issue/wiki/discussion/attachment の realm
- protected declassification approval
- build input/output classification
- realm-aware notification/webhook
- authority-complete disaster recovery export

### 15.3 延期

- placeholder を伴う metadata-visible private object
- 同一 path の realm overlay
- arbitrary per-file ACL
- end-to-end encrypted sealed realm
- automatic DLP による classification 決定
- 公開済み情報の完全 revoke をうたう機能

特に per-file ACL を最初から自由化すると、artifact ごとの audience 集合が爆発し、dedup、tree root、sync、cache、index、key rotation が複雑になる。MVP は少数の project-level realm に file を所属させる。

---

## 16. 推奨 ADR

1. ADR-V001: project public/private は default view であり全 object の固定属性ではない
2. ADR-V002: tracking、realm、Web exposure、replication、index、export を分離する
3. ADR-V003: Web-hidden は非機密である
4. ADR-V004: realm は artifact の署名対象・identity の一部である
5. ADR-V005: public artifact から restricted artifact への参照を禁止する
6. ADR-V006: realm ごとに tree root と change DAG を持つ
7. ADR-V007: public projection は restricted data だけの変更で変化しない
8. ADR-V008: promotion は新しい artifact を作る declassification operation である
9. ADR-V009: public→restricted は過去公開分を revoke しない
10. ADR-V010: policy は過去 artifact を暗黙に再分類しない
11. ADR-V011: public/restricted R2 bucket、route、cache を分離する
12. ADR-V012: restricted object の physical key と dedup scope を realm に閉じる
13. ADR-V013: generated output は input の最も restrictive な realm を継承する
14. ADR-V014: issue/wiki/discussion/attachment にも同じ realm model を使う
15. ADR-V015: local-history は project graph から参照不能にする

---

## 17. 最終提案

EdgeFossil では、repository を一つの public/private flag で表すのではなく、次のように捉える。

> 一つの project identity の下に、複数の複製可能な realm history があり、利用者の capability に応じて検証可能な view を合成する。

この model なら、質問にある「public repository で追跡は必要だが、一部 file は Web で公開したくない」に二通りで正確に答えられる。

1. **見通しのためだけに Web から隠す**  
   `realm=public, web=hidden`。public clone/export には含まれるため機密ではない。

2. **共同開発者には同期するが匿名利用者には渡さない**  
   `realm=members` または `maintainers`。public tree、history、inventory、search、export、R2 route から完全に分離する。

さらに `tracking=local` を設ければ、authority に送らず個人端末だけで履歴化できる。

設計上の要点は、private row を最後に filter することではない。**public view を最初から public data だけで構築し、restricted data の存在・hash・pathを public graphに入れないこと**である。Cloudflare 上でも public bucket/CDN と private binding route を分け、authority、cache、index、log、Queue、export の全経路で同じ realm boundary を維持する。

この方針は実装量を増やすが、「Webで見えないから安全」という危険な誤解を避け、Fossil 型の統合 project 全体に一貫した情報 flow rule を与えられる。

---

## 参考資料

### Cloudflare R2

- [R2 public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/)
- [R2 consistency model](https://developers.cloudflare.com/r2/reference/consistency/)
- [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [R2 data security](https://developers.cloudflare.com/r2/reference/data-security/)
- [R2 SSE-C example](https://developers.cloudflare.com/r2/examples/ssec/)
- [R2 S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/)

### Cloudflare Cache / Workers

- [Origin Cache Control](https://developers.cloudflare.com/cache/concepts/cache-control/)
- [Workers cache configuration](https://developers.cloudflare.com/workers/cache/configuration/)
- [R2 and Cloudflare Cache](https://developers.cloudflare.com/cache/interaction-cloudflare-products/r2/)
- [Purge cache](https://developers.cloudflare.com/cache/how-to/purge-cache/)
- [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
