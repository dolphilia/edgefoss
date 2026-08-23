# Cloudflare Workersネイティブな「Fossilの後継」を設計する  
## ― 統合型SCMをサーバレス／エッジ時代に再構成するための設計レポート

## 1. 問題設定

前回は、

> Fossil SCMそのものをWebAssembly化してCloudflare Workersで実行する

という方向を検討した。

しかし、より興味深いのはその一段先である。

すなわち、

> **Fossilとの互換性にはこだわらず、Fossilの設計思想だけを継承し、Cloudflare Workersエコシステムを前提として新しいSCMを設計する**

という考え方である。

これは単なる「クラウド版Fossil」ではない。

むしろ、

```text
Fossil
  ↓
何が本質だったのかを抽出
  ↓
Cloudflare Workersの性質に合わせ再設計
  ↓
新しい統合型SCM
```

というプロジェクトになる。

結論から言えば、このアプローチはかなり有望である。

特に現在のCloudflareには、

- Workers
- SQLite-backed Durable Objects
- R2
- Queues
- Workflows
- WebSockets
- Workers Builds

など、Fossilが一つの実行ファイルとSQLiteで実現していた役割を、クラウドネイティブに再構成するための部品がほぼ揃っている。Durable Objectsは各オブジェクトごとにprivate・transactional・strongly consistentなSQLite storageを持ち、新規namespaceではSQLite backendが標準になっている。

---

# 2. まず「Fossilらしさ」とは何か

新システムを設計する前に、

> Fossilのどの部分を継承するのか

を明確にする必要がある。

Fossilの本質は「SQLiteを使っていること」ではない。

より重要なのは次の思想である。

### 2.1 プロジェクト全体を一つのものとして扱う

Gitでは、

```text
Git
GitHub Issues
GitHub Wiki
GitHub Discussions
GitHub Actions
```

などが別々のシステムになりやすい。

Fossilでは、

```text
Source
Wiki
Tickets
Forum
Documentation
Users
Timeline
```

が一つのrepositoryに含まれる。

Fossil自身も「small, complete, self-contained」であり、cloneするとソースだけでなく文書やticket historyなどプロジェクトサイトそのものを取得できることを特徴としている。

これは最も重要な思想として継承したい。

---

# 3. 第二の本質：「artifact」

さらにFossil内部には非常に良い抽象化がある。

Fossil repositoryのglobal stateは、

> **順序を持たないartifactの集合**

として定義される。

artifactには、

- source file
- check-in manifest
- wiki page
- ticket change
- forum post
- attachment
- technote
- control artifact

などが含まれる。

つまりFossilにとって、

```text
source code
issue
wiki
discussion
```

は全く別の世界ではない。

上位ではすべて、

```text
Artifact
```

なのである。

この発想はCloudflareネイティブ版でも残す価値が極めて高い。

---

# 4. 第三の本質：「履歴＝イベント」

Fossilのticket systemも興味深い。

ticketの現在状態そのものを直接保存するだけではなく、

```text
Ticket created
       ↓
field changed
       ↓
comment added
       ↓
status changed
```

というticket-change artifactの列から現在状態を復元する。

これは現代用語なら、

> **event sourcing**

にかなり近い。

つまりFossilはかなり昔から、

```text
immutable event
      +
derived current state
```

というモデルを一部採用していたことになる。

これも新システムへ強く継承したい。

---

# 5. 第四の本質：同期可能である

Fossilはcentralized SaaSではない。

各repositoryがglobal artifactsを持ち、

```text
Repository A
     ↕
Repository B
```

で不足artifactを交換する。

Fossilのsync protocolは基本的に、artifactのhash集合を比較して不足しているものを転送する方式である。

したがって、

> サーバが真実そのもの

ではなく、

> **複製可能なproject state**

になっている。

これも非常に重要である。

---

# 6. 逆に、継承しなくてもよいもの

一方、新システムではFossilの実装上の特徴をすべて守る必要はない。

例えば、

```text
single executable
single SQLite file
CGI
SHA-1
Fossil manifest card format
Fossil delta encoding
```

は必須ではない。

特にFossil自身が、SQLiteへのdelta-compressed blob格納はartifact modelとは異なる「implementation detail」であり、別方式で保存してもrepository stateの意味は変わらないとしている。

これは今回非常に重要な示唆である。

つまり、

> Fossilの論理モデルを維持しつつ、物理storageはCloudflareに最適化してよい。

---

# 7. 新しいシステムの基本原則

仮に新しいシステムをここでは便宜上、

**EdgeFossil**

と呼ぶ。

正式名称ではなく、設計を説明するための仮称である。

EdgeFossilでは次の原則を設定する。

```text
1. Project is the unit.
2. Everything important is versioned.
3. History is append-oriented.
4. Content is immutable.
5. Current state is derived.
6. Local use works without the cloud.
7. Server operation requires no server administration.
8. Collaboration is optional, not mandatory workflow.
9. One project should feel like one object.
10. Export must remain possible forever.
```

特に、

> **Cloudflareを使うが、Cloudflareにプロジェクトを閉じ込めない**

ことを重要な原則にする。

---

# 8. 全体アーキテクチャ

最も自然なのは次の構成である。

```text
                         Internet
                            │
                            ▼
                    ┌──────────────┐
                    │ Edge Worker  │
                    │              │
                    │ Web UI       │
                    │ HTTP API     │
                    │ Sync API     │
                    │ Auth         │
                    └──────┬───────┘
                           │
                    project identity
                           │
                           ▼
              ┌───────────────────────┐
              │ Repository DO         │
              │ 1 Project = 1 DO      │
              │                       │
              │ SQLite                │
              │ ├ commits             │
              │ ├ refs                │
              │ ├ issues              │
              │ ├ wiki                │
              │ ├ discussions         │
              │ ├ users               │
              │ ├ permissions         │
              │ └ artifact index      │
              └───────┬───────────────┘
                      │
             ┌────────┴────────┐
             │                 │
             ▼                 ▼
            R2              Queues
     immutable blobs      background events
             │                 │
             │                 ▼
             │             Workers
             │        indexing / hooks /
             │        notifications
             │
             └─────────────┐
                           ▼
                       Workflows
                  export / backup /
                  release / maintenance
```

中核は、

> **1 project = 1 SQLite-backed Durable Object**

である。

---

# 9. なぜDurable Objectなのか

これは単なるデータベースとして使うのではない。

Durable Objectには、

```text
identity
+
compute
+
strongly consistent state
```

がセットになっている。

CloudflareもDurable Objectsを複数clientが同一stateを協調操作するアプリケーション向けのbuilding blockとして位置づけている。

repositoryとはまさに、

> 複数clientが一つの論理stateを変更するもの

である。

したがって、

```text
repository = database rowの集合
```

より、

```text
repository = stateful object
```

と捉える方が自然である。

---

# 10. 「1 repository = 1 Durable Object」

例えばproject IDが、

```text
sqlite
```

なら、

```text
RepositoryDO("sqlite")
```

を一つ作る。

別projectが、

```text
mygame
```

なら、

```text
RepositoryDO("mygame")
```

になる。

すると、

```text
Project A ─── DO A
Project B ─── DO B
Project C ─── DO C
```

となり、それぞれ独立する。

Durable ObjectsのSQLite storageは各object専用で、他のobjectから直接アクセスできないstrongly consistent storageである。

これはrepository isolationとして非常に都合が良い。

---

# 11. Durable Objectには「巨大ファイル」を保存しない

ただし重要な設計判断がある。

SQLite-backed Durable Objectのstorage limitは、2026年現在1 objectあたり10 GBである。

ソース中心なら十分なことも多いが、

```text
image
audio
video
3D asset
release binary
```

まで入れると簡単に大きくなる。

そこで、

> **Durable Objectはmetadata、R2はcontent**

と分ける。

---

# 12. Content-addressed R2

すべてのimmutable contentを、

```text
SHA-256(content)
```

などで識別する。

例えば、

```text
7e83...af
```

というhashなら、

```text
R2:

objects/7e/83/7e83...af
```

として保存する。

R2は大量のunstructured objectを扱うobject storageであり、Workers bindingから直接read/writeできる。strong consistencyも提供される。

これにより、

```text
Source file
Binary
Image
Attachment
Release archive
```

を同じcontent storeへ置ける。

---

# 13. Fossilのartifact思想をさらに一般化する

新システムでは、

```text
Artifact
```

を基本単位とする。

artifactは、

```text
id
kind
author
timestamp
parents[]
payload
metadata
```

を持つ。

例えば、

### source blob

```text
kind = blob
content = R2 hash
```

### commit

```text
kind = commit
parent = ...
tree = ...
message = ...
```

### issue event

```text
kind = issue.change
issue = 42
status = closed
```

### wiki revision

```text
kind = wiki.revision
page = Architecture
content = ...
```

### discussion

```text
kind = discussion.message
thread = ...
reply_to = ...
```

となる。

---

# 14. 重要なのは「全部同じtimelineに乗る」こと

ここがGitHubとの大きな思想差になる。

GitHubでは、

```text
Commits
Pull Requests
Issues
Discussions
Wiki
Actions
```

がUIでもデータモデルでもかなり分かれている。

EdgeFossilでは、

```text
09:20 commit
09:24 issue created
09:31 wiki edited
09:44 commit
10:02 issue closed
10:10 release created
```

という一つのtimelineとして扱う。

これはFossilのtimeline思想をそのまま現代化したものになる。

---

# 15. GitHubの「機能別」から「時間軸」へ

主画面を例えば、

```text
┌──────────────────────────────────┐
│ Project                          │
├──────────────────────────────────┤
│ Timeline                         │
│                                  │
│ ● 14:31 Source updated           │
│ │                                │
│ ● 14:22 Issue #12 commented      │
│ │                                │
│ ● 13:58 Wiki: Architecture       │
│ │                                │
│ ● 13:40 Version 0.4 released     │
│ │                                │
│ ● 12:51 Issue #11 closed         │
└──────────────────────────────────┘
```

とする。

必要なら、

```text
Code
Issues
Docs
Discussions
Releases
```

でfilterするだけでよい。

---

# 16. Commitを必須の儀式にしない

ここではさらにFossilより一歩進めてもよい。

従来VCSでは、

```text
working tree
↓
stage
↓
commit
```

という明示操作が必要だった。

しかし今回想定しているような個人主体の用途では、

> 「保存可能な状態が常に履歴に残る」

方が自然かもしれない。

したがってlocal clientには、

```text
autosnapshot
```

を持たせる。

---

# 17. 二種類の履歴

例えば、

```text
snapshot
```

と、

```text
checkpoint
```

を区別する。

### Snapshot

自動生成。

```text
14:03
14:09
14:24
14:42
```

ユーザーはmessageを書く必要がない。

### Checkpoint

意味のある地点。

```text
Parser rewrite completed
v0.3
Before UI redesign
```

こちらだけ名前を付ける。

すると、

```text
snapshot
snapshot
snapshot
★ checkpoint
snapshot
snapshot
★ release
```

となる。

これは「update commitを大量に作る」という実際の個人開発スタイルを、むしろ第一級概念にした設計である。

---

# 18. branchも必須概念から降ろす

branchも、

> 必ず名前を付ける作業場所

ではなく、

> graph上のlabel

程度にする。

通常は、

```text
main
  │
  ●
  │
  ●
  │
  ●
```

だけ。

実験すると、

```text
        ●
       /
●─●─●
```

となる。

必要になった時だけ、

```text
experiment-ui
```

という名前を付ける。

つまり、

> branchは先に作るのではなく、必要になったら後から名付ける。

---

# 19. Pull Requestも中心概念にしない

同様に、

```text
branch
→ PR
→ review
→ merge
```

を共同開発の唯一の方式にはしない。

新しい基本単位を、

> **Proposal**

とする。

Proposalは、

```text
change set
+
discussion
+
optional approval
```

である。

例えばContributorが変更を送ると、

```text
Proposal #18

Changes
├ src/parser.ts
├ src/token.ts
└ tests/parser.ts

Discussion
...

Actions
[Accept]
[Request change]
[Close]
```

となる。

内部的にはbranchすら必要ない。

---

# 20. Proposalは「変更artifactの集合」

例えば、

```text
Proposal
   │
   ├ change A
   ├ change B
   └ change C
```

として表現できる。

mergeするとは、

```text
proposal accepted
```

というartifactを追加して、

```text
main history
```

へ変更を統合することになる。

こうするとGitHubのPRより概念を単純化できる。

---

# 21. 自分自身にはProposalを要求しない

これは重要である。

repository ownerなら、

```text
edit
↓
sync
```

だけでよい。

外部Contributorなら、

```text
edit
↓
proposal
↓
owner accepts
```

となる。

つまり、

```text
             Project
                │
      ┌─────────┴─────────┐
      │                   │
    Owner            Contributor
      │                   │
   direct             Proposal
      │                   │
      └─────────┬─────────┘
                ▼
              history
```

という非対称workflowにする。

---

# 22. Issueも独立したサブシステムにしない

Issueもartifact streamとして表す。

```text
issue.created
issue.comment
issue.label.add
issue.status.change
issue.assign
```

などである。

Current stateはSQLiteにmaterializeする。

```text
Artifact log
     │
     ▼
materializer
     │
     ▼
issues_current
```

これはFossilのticket-change方式をさらに一般化したものになる。Fossil自身もticketの現在状態をticket-change artifactsを時系列に適用して導出する。

---

# 23. Wikiも同じ

Wikiも、

```text
wiki.created
wiki.revised
wiki.renamed
wiki.deleted
```

で表す。

本文はR2 blob。

Durable Objectには、

```text
wiki_pages

id
title
current_revision
updated_at
```

だけ持つ。

履歴はartifact graphから復元可能にする。

---

# 24. Discussionも同じ

Discussionも、

```text
thread.created
message.created
message.edited
message.deleted
```

をartifactとして扱う。

ここまで来ると、

```text
SCM
Issue Tracker
Wiki
Forum
```

は実は別機能ではない。

全部、

> **artifact type + view**

になる。

---

# 25. これがFossilから受け継ぐ最大の設計思想

つまり内部では、

```text
              Artifact Store
                    │
       ┌────────────┼────────────┐
       │            │            │
      Code         Issue        Wiki
       │            │            │
       └────────────┼────────────┘
                    │
                Timeline
```

である。

新機能を増やす場合も、

```text
kind = ...
```

を追加すればよい。

例えば将来、

```text
design.note
benchmark
build
deployment
decision
```

なども同じtimelineへ入れられる。

---

# 26. Durable Object SQLiteの役割

Durable ObjectのSQLiteには「真実そのもの」をすべて入れない。

むしろ、

```text
canonical metadata
+
indexes
+
derived views
+
coordination
```

を入れる。

例えば、

```sql
artifacts
artifact_edges
refs
checkpoints

files_current
issues_current
wiki_current
threads_current

users
permissions

sync_peers
```

などである。

CloudflareのSQLite-backed Durable ObjectsはSQL、indexes、transactions、FTS5、JSON functionsなどを利用できる。

そのためこの種のmaterialized stateには非常に向いている。

---

# 27. R2の役割

一方R2は、

> immutable content-addressed store

とする。

```text
R2
├ blobs/
├ attachments/
├ release/
└ export/
```

ただし論理的には全部artifact contentでよい。

例えば同一fileが100 commitsに現れても、

```text
SHA256(content)
```

が同じなら一度しか保存しない。

---

# 28. 大きなbinaryにも自然に対応できる

Gitでは巨大binaryが問題になり、

```text
Git LFS
```

という別レイヤーが必要になる。

この設計では最初から、

```text
Source file
     ↓
R2 object

PSD
     ↓
R2 object

Video
     ↓
R2 object
```

なので基本モデルが変わらない。

R2は大量のunstructured data向けobject storageとして設計され、インターネットへのegress料金を課さないことも特徴としている。

したがってゲームやデザイン資産まで含めたproject repositoryにも適している。

---

# 29. ローカルrepositoryはどうするか

ここは重要である。

Cloud-only systemにしてしまうとFossilらしさが失われる。

したがってlocal clientも持つ。

ただしserverと同じ構造である必要はない。

例えば、

```text
.project/
└ repository.db
```

というSQLite databaseをlocalに置く。

そしてworking directoryは普通に、

```text
src/
assets/
docs/
```

として存在する。

つまり、

```text
Local

Working Tree
     │
     ▼
SQLite repository
     │
     ⇅ sync
     │
Cloud repository
```

とする。

---

# 30. 「クラウド側とローカル側で物理storageが違ってよい」

これは非常に重要である。

ローカルでは、

```text
SQLite file
```

にblobまで格納してもよい。

Cloudflareでは、

```text
DO SQLite + R2
```

に分離する。

しかし両者が共有するのは、

```text
Artifact Protocol
```

である。

つまり、

```text
        Logical repository format
                  │
         Artifact protocol
             /          \
            /            \
 Local SQLite        DO + R2
```

となる。

---

# 31. 永続的なのはstorage formatではなくartifact format

これはFossilの思想を非常によく継承している。

Fossil自身も、長期的に永続させたいのはSQLite内部表現ではなくartifact formatだとしている。

新システムでも、

> 100年後に読めるべきなのはCloudflare Durable Objectではない。

読めるべきなのは、

```text
artifact specification
```

である。

---

# 32. Export Bundleを第一級機能にする

そこで、

```text
project.edge
```

のようなportable repository bundleを定義する。

例えば、

```text
project.edge

manifest.json
artifacts/
objects/
metadata/
```

をZIPやtarベースでまとめる。

あるいはSQLite一ファイルにexportしてもよい。

重要なのは、

> **いつでもCloudflareから完全なprojectを抜き出せる**

こと。

---

# 33. 「Clone」は完全バックアップでもある

cloneすると、

```text
source
issues
wiki
discussion
attachments
releases
history
```

を全部取得する。

つまり、

> Git repositoryのclone

ではなく、

> **project clone**

である。

これはFossilの優れた特徴をそのまま継承する。

---

# 34. 同期protocol

Fossil同様、

```text
unordered content-addressed artifact set
```

を基本にする。

ただしSHA-1ではなく例えばSHA-256やBLAKE3を使う。

概念的には、

```text
Client artifacts
A B C D

Server artifacts
A B C E F

↓

Client ← E F
Server ← D
```

である。

---

# 35. artifact数が増えたらMerkle構造を使う

百万artifactについてhash listを毎回交換するのは非効率である。

そこで、

```text
Artifact Set
     │
 Merkle Tree
     │
 root hash
```

を構築する。

最初にrootだけ比較する。

一致すれば、

```text
sync complete
```

不一致なら、

```text
root
├─ A equal
└─ B different
      ├─ B1 equal
      └─ B2 different
```

と差異を絞る。

これにより通信量を抑えられる。

Fossilのcluster artifactが担っていた大量artifact synchronization問題を、より現代的なset reconciliation構造へ置き換える発想である。

---

# 36. push/pullという言葉すら簡略化できる

通常利用では、

```text
sync
```

だけでもよい。

Local変更があれば送る。

Remote変更があれば取る。

```text
local
  ⇅
cloud
```

である。

必要なら、

```text
sync --pull
sync --push
```

も用意する。

しかし通常ユーザーには区別を要求しない。

---

# 37. Workerの役割

front Workerは極力statelessにする。

担当するのは、

```text
HTTP routing
authentication
repository lookup
static assets
API validation
rate limiting
```

程度。

repository操作は、

```text
RepositoryDO
```

へ渡す。

つまり、

```text
HTTP request
    ↓
Edge Worker
    ↓
repo name → DO ID
    ↓
RepositoryDO
```

である。

---

# 38. Web UIも同じWorkerから提供

Fossilと同じように、

```text
Code
Timeline
Issues
Wiki
Discussions
Files
Releases
```

を一つのWeb applicationにする。

ただしWorkersなのでHTML server renderingもAPI型SPAも選べる。

静的assetはWorkers Static Assetsなどへ置いてもよい。

---

# 39. リアルタイムTimeline

ここではCloudflareならではの機能も追加できる。

Durable ObjectsはWebSocket serverになれ、Hibernation APIならidle時にはobjectをmemoryから退避しながら接続を維持できる。

そのため、

```text
Developer A pushes
          │
          ▼
    Repository DO
       /      \
      /        \
Browser A    Browser B
 timeline    timeline
```

として即時更新できる。

---

# 40. Queuesの役割

repositoryへのwrite pathには余計な処理を入れない。

例えばcommitを受け取ったら、

```text
commit
  ↓
DO transaction
  ↓
success response
```

までを最短にする。

その後、

```text
index update
notification
webhook
analytics
mirror
```

はQueueへ送る。

Cloudflare Queuesはdelivery保証、batching、retry、delay、dead-letter queueなどを提供するため、この非同期処理に適している。

---

# 41. 例えばcommit処理

```text
Client
  │
  │ sync
  ▼
Repository DO
  │
  ├ SQLite transaction
  │   ├ register artifact
  │   └ update refs
  │
  ├ R2 put blobs
  │
  └ Queue
      ├ indexing
      ├ notification
      └ webhook
```

となる。

---

# 42. Workflowsの役割

Queuesは単純な非同期job向きだが、

```text
release
backup
repository export
large migration
garbage collection
mirror
```

などは多段階になる。

ここにはCloudflare Workflowsが合う。

Workflowsはstepごとにstateを永続化し、失敗したstepだけretryでき、数時間・数日単位の処理も扱える。

例えばReleaseなら、

```text
release requested
      ↓
freeze checkpoint
      ↓
build artifacts
      ↓
generate archive
      ↓
store R2
      ↓
publish release
      ↓
notify subscribers
```

をWorkflowにする。

---

# 43. Repository exportもWorkflowにする

「プロジェクト全体を一ファイルにしてdownload」という操作は、

```text
Collect metadata
       ↓
Collect artifacts
       ↓
Collect blobs
       ↓
Build archive
       ↓
Store R2
       ↓
Return signed download URL
```

となる。

大量repositoryならHTTP request内で実行すべきではない。

Workflowsはこうしたdurable multi-step処理にちょうど良い。

---

# 44. Cloudflare上でも「single project」という感覚を守る

物理的には、

```text
Worker
Durable Object
R2
Queue
Workflow
```

に分散している。

しかしユーザーにはそれを見せない。

UIでは、

```text
myproject
```

ただ一つ。

CLIでも、

```bash
ef clone example.com/me/project
```

だけ。

Cloudflare Dashboardを操作させてはならない。

これがFossilのself-contained思想をcloudで再現するポイントである。

---

# 45. 「single executable」の現代版

Fossilでは、

```text
fossil.exe
```

一個だった。

Cloudflare版では物理的にはそうならない。

しかしdeploy体験を、

```bash
ef deploy
```

一発にする。

内部では、

```text
Worker
DO namespace
R2 bucket
Queue
Workflow
```

をprovisionする。

つまり、

> **single executableではなくsingle deployment unit**

とする。

これがクラウド時代の「self-contained」の再定義になる。

---

# 46. セルフホスト思想も捨てない

Cloudflare専用にしすぎるとFossilの思想に反する。

そこでarchitectureを二層に分ける。

```text
Core
├ Artifact model
├ Repository logic
├ Sync protocol
├ Local SQLite backend
└ CLI

Cloud adapter
├ Workers HTTP
├ Durable Object
├ R2
├ Queue
└ Workflow
```

Cloudflare固有部分をadapterに閉じ込める。

すると将来、

```text
Cloudflare
Local standalone server
AWS
Fly.io
Bare Linux
```

など別backendを実装できる。

---

# 47. しかしCloudflare版は第一級実装

「portableだから最小公倍数にする」のではない。

むしろ、

```text
Reference server = Cloudflare
```

としてWorkers ecosystemを最大限使う。

一方でprotocolとarchive formatだけ公開・固定する。

このバランスがよい。

---

# 48. CIについて

CloudflareにはWorkers Buildsもあり、2026年現在build environmentは最大20分、8 GB memory、freeで月3,000 build minutesなどの枠がある。

ただし新SCMでは、

> CIをrepository管理の必須部分

にはしない方がよい。

Fossilらしく、

```text
SCM core
```

と、

```text
automation
```

は疎結合にする。

---

# 49. Buildもartifactとして記録する

例えば、

```text
build.started
build.finished
build.failed
```

をartifactとしてtimelineへ入れる。

すると、

```text
commit
↓
build
↓
issue
↓
fix
↓
build
↓
release
```

が一続きに見える。

これはGitHub Actionsを別タブに隔離するよりFossil的である。

---

# 50. 全履歴検索

Durable ObjectのSQLiteにはFTS5が利用できる。

したがって検索を、

```text
Source filename
Commit message
Issue
Wiki
Discussion
Release note
```

横断で行える。

例えば、

```text
"parser timeout"
```

と検索すると、

```text
Issue #14
Wiki "Parser design"
Commit a32...
Discussion #7
```

がまとめて出る。

これも統合型repositoryの大きな利点になる。

---

# 51. 「Project memory」として考える

ここまで来ると、単なるSource Controlではなく、

> **Project Memory System**

と見る方が近い。

Projectには、

```text
Code
History
Why
Discussion
Decisions
Problems
Documentation
Releases
```

が全部残る。

つまり、

```text
What changed?
Why?
Who discussed it?
Which issue?
Which release?
```

を一つのtimelineとgraphから辿れる。

---

# 52. AI時代との相性

ここはFossilにはなかったが、新設計なら考慮したい。

AI Agent A、B、Cが並列作業する場合、

```text
Agent A → change
Agent B → tests
Agent C → docs
```

をそれぞれartifact streamとして送る。

いちいち、

```text
agent-a-branch
agent-b-branch
agent-c-branch
```

を作る必要はない。

---

# 53. Changeを第一級にする

例えば、

```text
Change
 id
 author
 base
 dependencies[]
 artifacts[]
 state
```

というobjectを持つ。

```text
Change A
├ code
└ tests

Change B
├ depends: A
└ docs

Change C
└ independent
```

とする。

すると、

```text
       A
      / \
     B   D
      \
       C
```

というdependency graphを扱える。

これはGit branchよりAI並列開発に向く。

---

# 54. ProposalとChangeの関係

```text
Change
```

は技術的変更。

```text
Proposal
```

は共同開発上の提案。

したがって、

```text
Proposal #23
├ Change A
├ Change B
└ Discussion
```

となる。

1 ChangeだけProposalにしてもよいし、複数Changeをまとめてもよい。

---

# 55. Undoも第一級機能にする

Gitのように、

```text
reset
revert
reflog
```

を使い分けさせない。

Repository操作そのものについて、

```text
Operation Log
```

を持つ。

例えば、

```text
14:02 sync
14:04 accept proposal #5
14:10 rename wiki page
14:14 close issue #12
```

を記録する。

ユーザーからは、

```text
Undo
```

だけを提供する。

内部的にはimmutable artifactなので、原則として逆変更artifactを追加する。

---

# 56. Cloudflare PITRは最後の安全網

さらにSQLite-backed Durable Objectsには、storageを過去30日以内の任意時点へ戻せるPoint-in-Time Recoveryがある。

ただしこれは通常のVCS操作として使うべきではない。

構造としては、

```text
Level 1
Project undo

Level 2
Artifact history

Level 3
Local clone

Level 4
Repository export

Level 5
Cloudflare PITR
```

という多層防御にする。

PITRは災害復旧手段である。

---

# 57. Repositoryの削除も即時物理削除しない

例えばrepository delete時には、

```text
repository.deleted
```

というstateにして、

R2 objectsは一定期間保持する。

その後Workflowでgarbage collectionする。

```text
delete requested
      ↓
30-day tombstone
      ↓
Workflow
      ↓
GC
```

とする。

誤削除に強くなる。

---

# 58. R2のGC

content-addressed storeでは同じblobを複数repositoryで共有する設計も可能だが、最初は複雑になる。

第一版では、

```text
repo/{repo-id}/objects/{hash}
```

としてrepository単位にnamespaceを分ける方がよい。

そうすればrepository削除やexportが簡単になる。

将来必要ならglobal deduplicationを追加する。

---

# 59. Security model

permissionも簡素にしたい。

Fossil同様、

```text
anonymous
reader
contributor
maintainer
owner
```

程度から始める。

細かなRBACを最初から作らない。

例えば、

| Role | Read | Issue | Proposal | Direct change | Admin |
|---|---:|---:|---:|---:|---:|
| anonymous | ○ | △ | × | × | × |
| reader | ○ | ○ | × | × | × |
| contributor | ○ | ○ | ○ | × | × |
| maintainer | ○ | ○ | ○ | ○ | △ |
| owner | ○ | ○ | ○ | ○ | ○ |

とする。

---

# 60. Public repositoryの体験

public化は、

```text
Visibility:
Private → Public
```

の一操作だけ。

その瞬間、

```text
source
timeline
issues
wiki
discussions
releases
```

が公開される。

ただしprivate artifactなどを作りたければ別scopeにする。

---

# 61. 「公開」と「共同編集」を分離する

非常に重要なのは、

```text
Readable
```

と、

```text
Writable
```

を分けること。

Publicにしても、

```text
Anyone:
read
issue submit

Contributor:
proposal submit

Maintainer:
direct change
```

程度でよい。

GitHubのorganization permissionほど複雑にしない。

---

# 62. CLIの思想

CLIもGitのように数十conceptを要求しない。

基本commandは例えば、

```text
init
clone
status
sync
diff
history
undo
checkpoint
switch
propose
```

程度。

日常なら、

```bash
ef status
ef sync
```

だけでも使える。

---

# 63. 個人利用ではさらに簡単にする

例えば、

```bash
ef watch
```

を実行すると、

```text
filesystem change
       ↓
local snapshot
       ↓
debounce
       ↓
cloud sync
```

を自動化する。

すると体験としては、

> Dropboxのようなバックアップ + VCS

になる。

---

# 64. 「保存」と「公開履歴」を分離する

内部snapshotsを全部public timelineへ出す必要はない。

```text
Internal snapshots
      ↓
checkpoint
      ↓
published history
```

とする。

例えば100 autosnapshotがあっても、

publicには、

```text
Implement parser
Fix Windows path handling
Add tests
```

だけ見せられる。

---

# 65. これはGitの「commitを最初から綺麗に作る」問題を解消する

従来は、

```text
作業履歴
=
公開履歴
```

になりやすかった。

新システムでは、

```text
working history
        │
        ▼
publish / checkpoint
        │
        ▼
project history
```

と二段階にする。

Jujutsu的な履歴編集の利点とFossilの統合型repositoryを組み合わせた形とも言える。

---

# 66. 制約：Workersで何でも同期実行しない

Cloudflare Workersには明確なresource limitがある。

2026年現在、Worker isolate memoryは128 MB、Free planのHTTP CPUは10 ms、Paidでは設定により最大5分である。

したがって、

```text
巨大repository pack
full history reconstruction
large diff
repository archive
```

などをHTTP Worker内で一気に計算する設計は避ける。

---

# 67. 「短いrequest」と「durable background work」を分ける

原則として、

```text
Interactive path
< 1 request
```

には、

```text
small transaction
metadata lookup
blob fetch
```

だけを置く。

重い処理は、

```text
Queue
Workflow
```

へ移す。

Cloudflare自身もlong-running・retryable・non-urgent処理についてQueuesやWorkflowsへ移すことを推奨している。

---

# 68. Scalabilityモデル

このarchitectureの面白いところは、

```text
1 giant database
```

ではない点である。

```text
Repo 1 → DO 1
Repo 2 → DO 2
Repo 3 → DO 3
...
```

なのでproject単位に自然にshardされる。

Durable Objectsのobject数自体はaccount内でunlimitedとされている。

したがってSaaS化する場合にも都合がよい。

---

# 69. 一方、巨大monorepoには限界がある

一repositoryを一Durable Objectへ集約するので、

> **repository内write throughputには上限がある**

と考えるべきである。

数万人が一つのmonorepoへ同時commitするようなGoogle/Meta型ユースケースには向かない。

これはむしろFossilらしい。

ターゲットを、

```text
1～数十人程度
small / medium project
indie development
OSS
research
personal software
```

に絞った方が良い。

---

# 70. つまりGitHubを置き換える必要はない

狙う市場は、

```text
GitHub Enterprise
```

ではない。

むしろ、

> 「個人～小規模チーム向けの統合Project SCM」

である。

Fossil自身もGitとの比較で、小規模な密接なチーム向け設計であることを強調している。

---

# 71. 想定ユーザー

特に合うのは、

```text
Individual developer
Indie game developer
Small OSS
Research software
Small design/dev team
Long-lived personal project
```

などである。

逆に、

```text
100,000 developers
massive monorepo
complex enterprise policy
```

は狙わない。

---

# 72. Fossilと新システムの対応

| Fossil | Workers-native successor |
|---|---|
| single executable | single deployment |
| SQLite repository | logical Repository Object |
| SQLite | Durable Object SQLite |
| artifact blobs | R2 content-addressed objects |
| CGI/server | Worker |
| ticket | artifact event stream |
| wiki | artifact event stream |
| forum | artifact event stream |
| timeline | unified timeline |
| sync protocol | artifact/Merkle sync |
| clone | complete project clone |
| repository file copy | portable export bundle |
| cron/maintenance | Workflows |
| background actions | Queues |
| web server | Workers |
| local SQLite | local repository backend |

これはかなり綺麗に対応する。

---

# 73. GitHub型との根本的な違い

GitHub型：

```text
Git
├ repository
│
GitHub
├ Issues
├ PR
├ Wiki
├ Discussions
└ Actions
```

EdgeFossil型：

```text
Project
└ Artifact Graph
   ├ code
   ├ issues
   ├ wiki
   ├ discussions
   ├ changes
   ├ builds
   └ releases
```

つまり、

> **機能を統合するのではなく、データモデルそのものを統一する**

のである。

ここが非常に重要である。

---

# 74. Cloudflareを単なるhostingとして使わない

よくある設計なら、

```text
Git implementation
       ↓
Cloudflare Worker hosting
```

となる。

しかし今回の設計は逆である。

```text
Cloudflare primitives

Worker
DO
R2
Queue
Workflow
WebSocket
       ↓
これらからVCSそのものを再構成
```

する。

したがって真にWorkers-nativeである。

---

# 75. 最小実装なら意外に小さくできる

最初から全部作る必要はない。

### Phase 1

```text
CLI
Artifact model
Local SQLite
Worker API
Repository DO
R2
sync
```

だけ。

つまり、

```text
source control
+
backup
```

を実現する。

---

# 76. Phase 2

```text
Timeline
Web UI
Checkpoint
Undo
```

を追加。

これで個人開発環境としてかなり完成する。

---

# 77. Phase 3

```text
Issues
Wiki
Discussion
```

をartifact typeとして追加。

ここでFossil的な「project system」になる。

---

# 78. Phase 4

```text
Proposal
External contributor
Permissions
Public repository
```

を追加。

OSS hostingとして利用できる。

---

# 79. Phase 5

```text
Queues
Workflows
CI integrations
Webhooks
Releases
Search
```

を追加。

共同開発基盤として完成度を上げる。

---

# 80. Phase 6

最後に、

```text
AI agents
change dependencies
automation
real-time collaboration
```

などを追加する。

この順番なら本質を壊さない。

---

# 81. 最初から作らない方がよい機能

逆に、

```text
Projects/Kanban
complex organizations
dozens of permission levels
marketplace
package registry
container registry
advanced CI DSL
enterprise SSO
```

などは最初は作らない。

これを始めるとGitHubの再実装になってしまう。

---

# 82. 「小さいこと」を設計原則にする

Fossilの良さは、

> 機能が少ない

というより、

> **一つのconceptual systemとして理解できる**

ことである。

新システムも、

```text
Repository
Artifact
Change
Checkpoint
Timeline
Sync
```

程度を理解すれば全体が把握できるようにする。

---

# 83. この構想で最も重要なのはArtifact Model

Cloudflareを使うことより、実はここが核心である。

もし内部を、

```text
commits table
issues table
wiki table
forum table
```

として独立実装してしまうと、

> Cloudflareで作ったGitHub mini clone

になってしまう。

そうではなく、

```text
Artifact
  +
Relationships
  +
Materialized Views
```

にする。

これこそFossilを受け継ぐ部分である。

---

# 84. 理想的な内部構造

最終的には、

```text
                       PROJECT
                          │
                          ▼
                   Artifact Graph
                          │
       ┌──────────┬───────┼─────────┐
       │          │       │         │
      Blob      Change   Event    Document
       │          │       │         │
       │          │       │         │
     Source     Commit   Issue      Wiki
     Binary     Proposal Discussion Docs
       │          │       │         │
       └──────────┴───────┼─────────┘
                          │
                          ▼
                       Timeline
                          │
                          ▼
                  Materialized Views
```

となる。

---

# 85. さらにCloudflare側では

```text
                  Artifact Graph
                        │
        ┌───────────────┼──────────────┐
        │               │              │
        ▼               ▼              ▼
 Durable Object        R2             Queue
 metadata/state      content          events
        │                              │
        │                              ▼
        │                          Background
        │                              │
        └─────────────┬────────────────┘
                      ▼
                   Worker
                      │
             Web UI / Sync API
```

となる。

非常に綺麗な役割分担である。

---

# 86. Fossilよりさらに一歩進めるなら

Fossilには、

```text
repository
```

と、

```text
project website
```

が統合されている。

新システムではさらに、

> **project stateそのものとcollaboration stateを区別しない**

ところまで進められる。

つまり、

```text
code change
issue comment
design decision
wiki edit
release
```

を全部、

> 「プロジェクトに起こった変更」

として扱う。

---

# 87. Source ControlからProject Controlへ

そのため名称としては、

```text
Source Control Management
```

より、

```text
Project State Management
```

の方が実態に近くなる。

概念の進化を並べると、

```text
RCS
 file versions
      ↓
CVS/SVN
 repository
      ↓
Git
 distributed source history
      ↓
Fossil
 integrated project repository
      ↓
Workers-native successor
 project state graph
```

となる。

---

# 88. このシステムが今回の開発スタイルに合う理由

日常操作を極端に簡単にできる。

個人開発では、

```text
edit
 ↓
autosnapshot
 ↓
sync
```

だけ。

必要になったら、

```text
checkpoint "v0.4"
```

を作る。

Publicにした後も、

```text
自分
  ↓
direct change

Contributor
  ↓
proposal
```

でよい。

branchやPRを「開発するための必須儀式」にしなくて済む。

---

# 89. 最も大きなリスク

もちろん課題もある。

最大のものは、

### ① 新しいVCS ecosystem

Git interoperabilityが弱いと採用障壁が高い。

### ② local client

filesystem monitoring、diff、merge、conflict resolutionなどは簡単ではない。

### ③ artifact reconciliation

大量repositoryで効率的にsyncするprotocol設計が必要。

### ④ R2とDO間transaction

metadataだけcommitしてblob uploadが失敗するなど、分散transaction問題がある。

### ⑤ Cloudflare依存

reference serverがCloudflare固有になる。

---

# 90. R2とDOのtransaction問題は特に重要

例えば、

```text
R2 put blob
        ↓
DO insert artifact
```

の途中で失敗する可能性がある。

完全なdistributed transactionはない。

そこでcontent-addressed storageの性質を利用する。

```text
① R2 blob put
② hash verify
③ DO transactionでartifact publish
```

とする。

①だけ成功した場合、

```text
orphan blob
```

になるだけでproject stateは壊れない。

後からGCできる。

---

# 91. Immutable contentがこの問題を簡単にする

R2 objectをcontent hashでaddressするので、

```text
PUT same hash
```

を何度行っても意味的に同じである。

つまり操作をidempotentにしやすい。

これはserverless distributed systemでは非常に重要な性質である。

---

# 92. Queuesもat-least-onceを前提にする

Queuesからeventが重複deliveryされても、

```text
artifact-id
```

をidempotency keyとして処理すればよい。

Fossil型content-addressingとCloudflare型distributed infrastructureがここでも相性がよい。

---

# 93. 長期保存性

もう一つ強く重視したい。

プロジェクトを、

```bash
ef export project.edge
```

すれば、

```text
Cloudflare account消滅
サービス終了
開発停止
```

しても復元可能にする。

仕様書には、

```text
artifact format
bundle format
hash algorithm
relationships
```

を完全公開する。

---

# 94. 100年後にも読める設計

Fossilのfile format documentは、repository global stateを「decades or centuries」にわたって有用な形で維持することを明示的な目的としている。

新システムでもこれは重要な思想として継承すべきである。

したがってportable formatには、

```text
JSON / CBOR
UTF-8
SHA-256
raw blobs
```

など広く実装可能な技術を選ぶ。

Cloudflare独自formatは絶対にportable archiveへ入れない。

---

# 95. 最終的な製品像

最終形を一言で表すなら、

> **「Fossilのproject-in-a-repository思想」と「Jujutsu的な低摩擦変更管理」を、Cloudflare Workersのstateful serverless architectureで再構成したSCM」**

になる。

ユーザーから見ると、

```text
CLI
+
Project Website
```

だけ。

裏側では、

```text
Workers
Durable Objects
R2
Queues
Workflows
WebSockets
```

が動く。

---

# 96. 推奨する技術構成

第一版を実際に作るなら、私は次のようにする。

| 層 | 技術 |
|---|---|
| Local repository | SQLite |
| CLI | Rust |
| Artifact hash | SHA-256 または BLAKE3 |
| Sync transport | HTTPS |
| Serialization | CBOR + canonical encoding |
| Frontend | Worker |
| Repository authority | SQLite-backed Durable Object |
| Immutable blobs | R2 |
| Background events | Queues |
| Long-running processing | Workflows |
| Live updates | DO WebSocket Hibernation |
| Search | DO SQLite FTS5 |
| Portable backup | self-contained archive |

Rust CLIなら、

```text
Windows
macOS
Linux
```

へのsingle-binary distributionもしやすい。

これはFossilの「一つ置けば動く」というlocal-side philosophyにも合う。

---

# 97. 最小データモデル

最初なら本当に、

```text
artifact
---------
id
kind
author
created
payload_hash

edge
----
source
target
kind

ref
---
name
artifact

operation
---------
id
actor
created
kind
payload
```

程度から始められる。

Current stateはこれからmaterializeする。

---

# 98. 最小プロトコル

同期protocolも、

```text
HELLO
HAVE
WANT
ARTIFACT
BLOB
DONE
```

程度から始める。

後から、

```text
Merkle summary
compression
delta encoding
resume
```

を追加する。

Fossilのdelta compressionも、repositoryの意味そのものではなくstorage/transfer optimizationであるという発想を踏襲する。

---

# 99. 最小UI

最初のWeb UIも、

```text
Timeline
Files
History
```

だけでよい。

次に、

```text
Issues
Wiki
```

を追加。

そして、

```text
Proposal
Discussion
```

を追加する。

Fossilと同じく、システム全体を一度に理解できる大きさを保つことを優先する。

---

# 100. 結論

Fossil SCMをそのままWorkersへ移植するより、

> **Fossilが20年前に見抜いていた良い抽象化だけを取り出し、Cloudflareのprimitiveで再構成する**

方が、技術的にはさらに興味深い。

特に残すべきなのは、

```text
Project is one thing
Everything is versionable
Artifacts are immutable
History is append-oriented
Everything can synchronize
Everything can be cloned
Everything can be exported
```

という思想である。

一方、

```text
single SQLite file
CGI
SHA-1
native executable server
```

などは捨ててよい。

Cloudflare上では、

```text
                 PROJECT
                    │
                    ▼
             Repository DO
          authoritative state
              /           \
             /             \
          SQLite            R2
         metadata          blobs
             │               │
             └───────┬───────┘
                     │
                 Artifacts
                     │
        ┌────────────┼────────────┐
        │            │            │
       Code         Issue        Wiki
        │            │            │
        ├──────── Discussion ─────┤
        │            │            │
        └──────── Timeline ───────┘
                     │
                  Worker
                     │
              Web / Sync API
```

とする。

これならCloudflareのSQLite-backed Durable Objectsが提供するstrong consistencyとproject単位のstateful compute、R2の大容量object storage、Queuesの非同期delivery、Workflowsのdurable multi-step execution、WebSocket Hibernationによるリアルタイム通信という性質を、それぞれ最も得意な場所で使える。

そして最も面白いのは、これを単なる「Git代替」と考えなくてよいことである。

目指すべきものはむしろ、

```text
Version Control
        ↓
Source Control
        ↓
Project Repository
        ↓
Project State / Project Memory
```

という次の段階だと思う。

Fossilが「ソースコード以外もrepositoryに含める」という方向へ進めた考えをさらに徹底し、

> **プロジェクトに起きた出来事すべてを、一つの永続的・複製可能なartifact graphとして管理する。**

これを中核に据える。

その上でCloudflare Workersは「Fossilを無理矢理動かす場所」ではなく、**Fossilの思想を現代的に作り直すためのかなり適した実行基盤**になり得る。