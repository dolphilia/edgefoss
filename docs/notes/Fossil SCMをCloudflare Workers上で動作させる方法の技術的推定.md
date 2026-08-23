# Fossil SCMをCloudflare Workers上で動作させる方法の技術的推定

## 1. はじめに

「Cloudflare Workers上でFossil SCMを動作させることができた」という話を技術的に考えると、一見かなり意外である。

FossilはCで書かれたネイティブアプリケーションであり、通常は、

```text
fossil server
fossil http
fossil cgi
```

などとしてOS上で実行する。

一方Cloudflare Workersは通常のLinuxコンテナではない。

任意のネイティブバイナリを起動することはできず、JavaScript/TypeScriptなどに加えてWebAssemblyを実行するサーバレス環境である。Cloudflare自身も、Workersではネイティブコードを直接アップロードして実行することはできず、Wasmなどを通す必要があると説明している。

したがって、

```text
fossil Linux binary
        ↓
Cloudflare Worker
```

をそのまま置いたわけではないはずである。

しかしFossilの内部構造を調べると、

> **意外なほどCloudflare Workersへ移植しやすい条件が揃っている**

ことが分かる。

結論を先に示すと、最もありそうな構成は、

```text
                Internet
                    │
                    ▼
          Cloudflare Worker
          JavaScript/TypeScript
                    │
           HTTP → CGI変換
                    │
                    ▼
          fossil.wasm
      Fossil本体をC→Wasm化
                    │
                    ▼
               SQLite
                    │
            custom VFS
                    │
                    ▼
           Durable Object
          persistent storage
```

である。

特に核心になるのは、

> **Fossilそのものを移植するより、SQLite VFSをCloudflare向けに作る**

ことである可能性が高い。

以下、その理由を段階的に考察する。

---

# 2. Fossilは実はCloudflare Worker向きの構造をしている

FossilにはGitと大きく違う特徴がある。

Git repositoryは概念的には、

```text
.git/
├── objects/
├── refs/
├── HEAD
├── config
├── index
└── ...
```

という多数のファイルから構成される。

対してFossil repositoryは、

> **単一のSQLiteデータベースファイル**

である。Fossil公式もrepositoryを「single SQLite database file」と説明している。

例えば、

```text
project.fossil
```

という1ファイルだけで、

```text
source history
branches
users
tickets
wiki
forum
configuration
```

などが管理される。

これはサーバレス環境へ持っていく上で非常に有利である。

---

# 3. サーバ側ではworking treeすら必要ない

さらに重要なのがここである。

Fossilサーバは、

```text
repository.fossil
```

さえあればよい。

ソースコードを展開した、

```text
src/
include/
README.md
...
```

というcheckout directoryはサーバには必要ない。

例えばFossil公式のCGI設定は、

```text
#!/usr/bin/fossil
repository: /home/fossil/repo.fossil
```

程度で成立する。

つまりCloudflare側で必要なのは本質的には、

```text
① Fossilのプログラム
② .fossil SQLite database
③ HTTP request / response
```

だけである。

これならWasm環境へかなり落とし込みやすい。

---

# 4. FossilのWebサーバ機能をそのまま移植する必要もない

ここも重要である。

最初に考えると、

```text
fossil server
```

をWorkers内で動かして、

```text
listen()
accept()
socket()
```

などを実装しなければならないように思える。

しかし必要ない。

Fossilにはもともと**CGIモード**がある。

Fossil CGIでは、

```text
HTTP server
    │
    ├ CGI environment variables
    ├ stdin = request body
    │
    ▼
 Fossil
    │
 stdout = HTTP response
```

という方式で1リクエストを処理する。

Fossil公式の説明でも、CGIは環境変数と標準入力からHTTPリクエストを受け、標準出力へreplyを書き、その1リクエストで終了する仕組みになっている。

これは、

```javascript
export default {
  async fetch(request) {
    ...
    return response;
  }
}
```

というCloudflare Workerの実行モデルと驚くほどよく似ている。

---

# 5. WorkersとCGIは構造的にかなり近い

比較すると、

| CGI | Cloudflare Worker |
|---|---|
| 1 requestごとに起動 | `fetch()`をrequestごとに呼ぶ |
| 環境変数 | `Request` properties |
| stdin | `request.body` |
| stdout | `Response` |
| Web serverが外側に存在 | Cloudflare runtimeが外側に存在 |

したがって、

```text
Worker Request
      │
      ▼
CGI adapter
      │
      ├ REQUEST_METHOD
      ├ REQUEST_URI
      ├ PATH_INFO
      ├ QUERY_STRING
      ├ CONTENT_TYPE
      └ stdin
      │
      ▼
 fossil.wasm
      │
      ▼
 CGI response
      │
      ▼
Worker Response
```

というadapterを作ればよい。

これはかなり現実的である。

---

# 6. Fossil本体はCなのでWebAssembly化できる

Cloudflare WorkersはWebAssembly moduleを直接読み込める。

Cloudflare自身も、C/C++などをWasmへコンパイルしてWorkersで利用できるとしている。

したがって、

```text
Fossil C source
      │
 clang / wasi-sdk / emscripten
      ▼
 fossil.wasm
```

というビルドそのものは原理的には可能である。

Fossilは、

- C
- SQLite
- zlib系処理
- hashing
- HTTP/CGI processing

を中心とする比較的自己完結したプログラムなので、

> 巨大なOS依存GUIアプリをWasm化する

よりずっと条件が良い。

Cloudflare側でもWASIを実験的にサポートしている。

---

# 7. ただし「普通にWASI compileしただけ」ではおそらく動かない

ここからが本題である。

Fossilを、

```bash
clang --target=wasm32-wasi ...
```

としてコンパイルできたとしても、それだけではFossil SCM serverにはならない。

最大の問題が、

> **永続ファイルシステム**

だからである。

通常のFossilでは、

```text
/project/repo.fossil
```

というSQLite fileを開く。

そしてSQLiteは、

```text
open
read
write
truncate
fsync
lock
unlock
temporary file
journal/WAL
```

などのfilesystem operationを必要とする。

Fossil CGI公式ドキュメントにも、repository fileとそのdirectoryに書き込み権限が必要で、SQLiteがjournal fileを書けなければならず、Fossil自身もtemporary filesを作成できなければならないと明記されている。

ここがCloudflare Workers移植の最大の壁になる。

---

# 8. Workersには現在ファイルシステムが存在する

ただし2025年以降、この状況はかなり変わった。

Cloudflare Workersには現在、

```text
node:fs
Web File System API
```

による仮想filesystemがある。

そのためWasm側にPOSIX-likeなfile APIを提供して、

```text
open()
read()
write()
seek()
stat()
```

などをエミュレートすること自体は以前より容易になっている。

しかし重大な制約がある。

Workersのvirtual filesystemは、

> **requestごとにephemeral**

である。

Cloudflare公式にも、そこで書かれたfileはrequestを超えてpersistせず、別requestや別Workerとも共有されないと明記されている。

したがって、

```text
Request A
  repo.fossil
      ↓
 request終了
      ↓
消滅
```

となる。

これではVCS serverにはならない。

---

# 9. したがって問題は一つに集約される

Fossil on Workersの核心は、

> **repo.fossilをどう永続化するか**

である。

実現方法として大きく三つ考えられる。

---

# 10. 方法A：repository全体を毎回ロード・保存する

最も単純な実装はこれである。

```text
         Durable storage / R2
                │
        repo.fossil blob
                │
                ▼
             Worker
                │
       temporary filesystem
                │
                ▼
           fossil.wasm
                │
              update
                │
                ▼
       repo.fossil blob
                │
                ▼
        persistent storage
```

1 requestごとに、

1. `.fossil`ファイルをstorageから取得
2. ephemeral filesystemへ置く
3. Fossil Wasmを実行
4. 更新された`.fossil`を読み出す
5. storageへ書き戻す

という方式である。

---

# 11. これは試作品なら十分あり得る

もしSNS投稿が、

> 「Cloudflare WorkerでFossil SCMできることは確認できた」

程度の実験報告だったのであれば、実はこの方式がかなり有力である。

なぜなら実装が圧倒的に簡単だからである。

SQLiteもFossilもほぼ変更しなくてよい。

```text
Fossil
   ↓
普通のSQLite
   ↓
普通のfilesystemに見せる
   ↓
Worker memory / virtual filesystem
```

で済む。

persistent storageとの同期だけJavaScript側で行う。

---

# 12. ただしrepositoryが大きくなると破綻する

例えばrepositoryが100 MBなら、

```text
request
 ↓
100 MB load
 ↓
SQLite処理
 ↓
100 MB upload
```

を毎回行う可能性がある。

非常に非効率である。

さらに、

```text
Request A
    repo v10をload

Request B
    repo v10をload

A → v11保存
B → v12保存
```

となれば、

```text
BがAの変更を消す
```

可能性もある。

したがって本格運用にはconcurrency controlが必要になる。

---

# 13. ここでDurable Objectsが非常に重要になる

Cloudflareには**Durable Objects**がある。

Durable Objectは、

> 特定のlogical objectについてstateと処理を一か所に集約する

仕組みである。

Cloudflareは、Durable Objectsをcoordinationとstrongly consistent stateを必要とするapplication向けの仕組みとして提供している。

そこで、

```text
Fossil repository A
        ↓
Durable Object A

Fossil repository B
        ↓
Durable Object B
```

と対応させればよい。

これはFossilと非常に相性が良い。

---

# 14. 「1 repository = 1 Durable Object」

これが設計上かなり美しい。

```text
                  Cloudflare
                      │
              ┌───────┴───────┐
              ▼               ▼
      repo "project-a"   repo "project-b"
              │               │
              ▼               ▼
       DurableObject A  DurableObject B
              │               │
              ▼               ▼
        Fossil DB A      Fossil DB B
```

1つのFossil repositoryへのwriteを同じDurable Objectへrouteすれば、

```text
push A ─┐
push B ─┼→ same Durable Object
wiki  C ─┘
```

となる。

Durable Objectsはsingle-threadedなexecution modelとstorage coordination機構を持つので、同じrepositoryに対する変更をserializeしやすい。Cloudflareはinput/output gateによる競合防止についても説明している。

FossilのSQLite DBが期待する、

> 一貫したwrite serialization

とかなり自然に対応する。

---

# 15. 方法B：SQLite VFSをCloudflare用に実装する

本格的に実装するなら、これが最も興味深い方法である。

SQLiteには元々、

> **VFS — Virtual File System**

という抽象化層がある。

概念的には、

```text
          Fossil
             │
        SQLite SQL
             │
        SQLite core
             │
          VFS API
             │
      ┌──────┴──────┐
      │             │
    POSIX         Win32
```

のような構成である。

SQLite自体は直接Linuxの`open()`を呼ぶのではなく、VFSを介してstorageへアクセスできる。

そこで、

```text
          Fossil
             │
          SQLite
             │
        CF Worker VFS
             │
             ▼
       Durable Object KV
```

を作る。

---

# 16. `.fossil`ファイルをblockに分割する

例えばSQLite fileを、

```text
repo.fossil

0x000000 ─────────── block 0
0x010000 ─────────── block 1
0x020000 ─────────── block 2
...
```

のように64 KiBや256 KiB単位に分ける。

Durable Object storageでは、

```text
repo:block:000000
repo:block:000001
repo:block:000002
...
repo:size
```

のように保存する。

そしてSQLiteから、

```c
xRead(offset, amount)
```

が呼ばれたら、

```text
offset
 ↓
必要なblockを特定
 ↓
Durable Object storageから取得
 ↓
Wasm memoryへcopy
```

する。

writeも同様である。

---

# 17. これは2026年のWorkersでは特に実現しやすくなっている

SQLite-backed Durable Objectsには現在、

> **synchronous KV API**

が存在する。

例えば、

```text
ctx.storage.kv.get()
ctx.storage.kv.put()
ctx.storage.kv.delete()
```

が同期的に呼べる。

これは非常に重要である。

普通のJavaScript storage APIが、

```javascript
await storage.get(...)
```

しかなければ、

```c
sqlite3OsRead()
```

という同期C関数から呼ぶことが難しい。

しかし、

```text
C/Wasm
 ↓ synchronous import
JavaScript
 ↓ synchronous KV
Durable Object storage
```

とできれば、

```c
sqlite VFS xRead()
```

を同期関数のまま維持できる。

つまり、

```text
SQLite
 │
 │ xRead
 ▼
Wasm import
 │
 ▼
JS function
 │
 ▼
ctx.storage.kv.get()
```

というbridgeが成立する。

これはかなり強力である。

---

# 18. この方式ならrepository全体を読み込まなくてよい

例えば100 MBのrepositoryでも、

```text
HTTP request
       ↓
Fossil
       ↓
SQLite query
       ↓
page 231
page 232
page 981
...
```

と必要なpageだけ読み込める。

つまり、

```text
100 MB repository
```

に対して、

```text
request I/O
数十KB～数MB
```

程度で済む可能性がある。

これは方法Aとは本質的に異なる。

---

# 19. SQLite page単位に対応させればさらに自然

SQLiteはpage-oriented databaseなので、

```text
SQLite page
       ↕
Durable Object record
```

としてしまう方法も考えられる。

例えば4096-byte pageなら、

```text
page:00000001
page:00000002
page:00000003
...
```

として保存する。

概念的には、

```text
Fossil
  │
SQLite
  │
SQLite pager
  │
Custom VFS
  │
  ├─ page 1
  ├─ page 2
  ├─ page 3
  └─ ...
        │
        ▼
Durable Object KV
```

となる。

この場合Cloudflare KVの一record sizeに合わせたchunk sizeを選択する必要がある。

---

# 20. journalやlockingはどうするのか

ここがcustom VFS最大の難所である。

SQLiteは単純なrandom-access fileではない。

transactionのため、

```text
database
journal
WAL
shared memory
lock
fsync
```

などを扱う。

しかし「1 repository = 1 Durable Object」とするとかなり簡略化できる。

同じrepositoryへの処理を、

```text
Durable Object
      │
 request 1
      ↓
 complete
      │
 request 2
      ↓
 complete
```

とserial化できる。

すると通常のmulti-process SQLiteほど複雑なlockingは必要なくなる。

さらにDurable Object storageにはtransaction mechanismもある。

SQLite-backed Durable Objectではstorage operationをtransactionとしてまとめることもでき、同期的な`transactionSync()`も存在する。

したがって理論上は、

```text
SQLite transaction
      ↓
VFS writes
      ↓
Durable Object transaction
```

へ対応させることも考えられる。

---

# 21. ただしこれは簡単なSQLite VFSではない

注意すべきなのは、

> Durable ObjectがSQLiteだから、Fossil DBをそのままそこへ入れられる

わけではないことである。

CloudflareのSQLite-backed Durable Objectが提供するのは、

```javascript
ctx.storage.sql.exec(...)
```

というSQL APIであって、

```text
/path/repository.fossil
```

というraw SQLite fileではない。

Fossil内部のSQLiteから、

```text
Cloudflare's SQLite
```

を直接openすることはできない。

ここは非常に重要である。

---

# 22. 「SQLiteの中にSQLite」が発生する

custom VFS方式では実際、

```text
Cloudflare Durable Object
└── Cloudflare SQLite
      └── KV table
            └── Fossil SQLite pages
```

となる可能性がある。

つまり、

> SQLite databaseのpageを別のSQLite databaseのblobとして保存する

構造である。

一見奇妙だが、技術的にはそれほどおかしくない。

下側のSQLiteは、

```text
durability
transactions
distributed platform integration
```

を担当し、

上側のSQLiteは、

```text
Fossil schema
queries
indexes
artifact storage
```

を担当する。

---

# 23. 方法C：FossilからSQLiteを取り除いてCloudflare SQLへ直接接続

もっと大胆には、

```text
Fossil
  │
sqlite3_prepare
sqlite3_step
...
```

という部分を、

```text
Cloudflare DO SQL API
```

へ直接mappingする方法も考えられる。

つまり、

```text
Fossil C
   │
SQLite-compatible shim
   │
Wasm→JS
   │
ctx.storage.sql.exec()
```

である。

しかしこれはかなり大変だと思われる。

FossilはSQLiteを単なる簡単なSQL datastoreとして使っているわけではなく、SQLite C APIに深く依存している。

そのため、

```text
sqlite3_prepare_v2
sqlite3_bind_*
sqlite3_step
sqlite3_column_*
transactions
functions
collations
...
```

などを再現する必要が生じる。

実装量を考えると、

> custom SQLite VFSを作る方がはるかに現実的

である。

---

# 24. したがって有力度はこうなる

| 方法 | 実装難度 | 性能 | 本格運用 | 推定有力度 |
|---|---:|---:|---:|---:|
| repository丸ごとload/save | 低 | 低 | △ | ★★★★★ 実験 |
| ephemeral FS + R2等 | 低～中 | 低～中 | △ | ★★★★☆ |
| custom SQLite VFS + Durable Object | 高 | 高 | ◎ | ★★★★★ 本格版 |
| SQLite APIをDO SQLへ置換 | 非常に高 | 高 | ○ | ★★☆☆☆ |
| FossilをJSへ全面書換え | 極端に高 | 不明 | ○ | ★☆☆☆☆ |

SNSで「動作確認できた」という段階なら、

> **repository全体load/save方式**

または、

> **簡易custom VFS**

だった可能性が高いと考えられる。

---

# 25. HTTP側の移植は比較的簡単

Fossilのsync protocolはHTTPベースである。

Fossil clientはserver URLに、

```text
/xfer
```

を付加してPOSTする。

例えば、

```text
https://example.workers.dev/project/xfer
```

へ、

```http
POST /project/xfer
Content-Type: application/x-fossil
```

を送る。

serverは同じcontent typeで返す。

したがってCloudflare Workerから見ると、

```javascript
async fetch(request) {
    if (url.pathname.endsWith("/xfer")) {
        return fossil(request);
    }
}
```

程度のroutingで済む。

特別なGit Smart HTTPのような外部daemonも必要ない。

---

# 26. Fossil syncはserver-side sessionにもあまり依存しない

これもサーバレスと相性が良い。

Fossil公式sync protocolでは、

> serverはrequest間でclientに関するstateを保持しない

と説明されている。

cloneは複数HTTP requestになることがあるが、client側がsequence informationなどを保持する。

したがって、

```text
request #1
↓
Worker終了

request #2
↓
別instance
```

でも、

repositoryそのものが一貫していれば基本的に成立する。

これはserverless deploymentに非常に適している性質である。

---

# 27. Web UIも同じCGI adapterで動く

FossilはSCMだけではなく、

```text
/timeline
/info/...
/wiki
/ticket
/forum
/login
```

などWeb applicationを内蔵している。

CGI modeではこれらも全部同じFossil executableが処理する。

したがって、

```text
GET /timeline
      │
      ▼
Worker
      │
CGI adapter
      │
      ▼
fossil.wasm
      │
      ▼
HTML
```

とできる。

つまりCloudflare側で、

```text
repository browser
Issue tracker
Wiki
Forum
```

を別々に実装する必要はない。

**Fossilの大部分をそのままWasmとして持ち込める。**

これこそ、このアイデアの面白いところである。

---

# 28. CGI adapterは具体的に何をするか

Workers側で、

```javascript
Request
```

から例えば、

```text
REQUEST_METHOD
REQUEST_URI
SCRIPT_NAME
PATH_INFO
QUERY_STRING
CONTENT_TYPE
CONTENT_LENGTH
HTTP_HOST
HTTPS
REMOTE_ADDR
```

などを構築する。

Fossil自身がCGI環境変数を読む設計なのは公式documentationから確認できる。

そしてPOST bodyを、

```text
stdin
```

相当のbufferへ渡す。

Fossilがstdoutへ、

```text
Status:
Content-Type:
Set-Cookie:
...

<body>
```

を出力したら、それを解析して、

```javascript
new Response(body, {
    status,
    headers
})
```

へ変換する。

---

# 29. Wasm側は「CLI application」として残してもよい

理想的にはFossilをlibrary化して、

```c
fossil_handle_request(...)
```

のようなAPIを作りたくなる。

しかし最初のproof-of-conceptなら、

```text
main()
```

をそのままWASIで実行する方が容易である。

つまり、

```text
Worker
 │
 ├ argv
 ├ environ
 ├ stdin
 ├ stdout
 └ filesystem
       │
       ▼
 fossil main()
```

とする。

CloudflareはWASIをまだexperimentalかつ一部syscallのみの対応としているため、不足するものについてはcustom importsやshimが必要になる可能性が高い。

---

# 30. Fossilを少し改造した方が実際には楽かもしれない

本格実装なら、

```text
main()
CGI
POSIX
```

を完全にエミュレートするより、

FossilのCGI processing内部へ薄い入口を追加して、

```c
fossil_worker_request(
    method,
    uri,
    headers,
    body
)
```

のような関数としてexportする方が合理的かもしれない。

すると、

```text
JavaScript Request
        ↓
direct Wasm call
        ↓
Fossil CGI engine
        ↓
response buffer
```

となる。

これなら、

```text
stdin/stdout
environment variables
process exit
```

などのWASI compatibility問題をかなり減らせる。

---

# 31. 実際の最小proof-of-conceptを推定する

最も簡単に「動いた」と言えるところまで持っていくなら、私は次の実装だった可能性が高いと考える。

```text
① FossilをWasmへcompile

② Worker requestをCGI形式へ変換

③ repository.fossilをstorageから取得

④ Workers ephemeral filesystemへ
   /tmp/repo.fossil
   として書く

⑤ fossil cgi をWasm内で実行

⑥ stdoutをResponseへ変換

⑦ repo.fossilが変更された場合
   persistent storageへ書き戻す
```

図にすると、

```text
                 Browser / fossil client
                         │
                      HTTPS
                         │
                         ▼
                  Cloudflare Worker
                         │
             ┌───────────┴───────────┐
             │                       │
        Request parser          repository load
             │                       │
             │                       ▼
             │                 Durable storage
             │                       │
             ▼                       ▼
               ephemeral filesystem
                         │
                  repo.fossil
                         │
                         ▼
                    fossil.wasm
                         │
               ┌─────────┴─────────┐
               │                   │
           SQLite read         SQLite write
               │                   │
               └─────────┬─────────┘
                         │
                  repo.fossil
                         │
                         ▼
                 persistent save
                         │
                         ▼
                     Response
```

これはかなり現実的である。

---

# 32. そして第二段階でVFS化する

proof-of-conceptが成功したら、

```text
load entire DB
save entire DB
```

を、

```text
random-access persistent VFS
```

へ置換する。

```text
Phase 1

storage
 ↓ 50MB
memory filesystem
 ↓
Fossil
 ↓
memory filesystem
 ↓ 50MB
storage
```

から、

```text
Phase 2

Fossil
 ↓
SQLite
 ↓
VFS
 ↓
page reads / writes only
 ↓
Durable Object
```

へ移行する。

これは典型的な開発順序でもある。

---

# 33. Cloudflare Durable Objectsを使う理由は永続化だけではない

Durable Objectにはもう一つ重要な意味がある。

repositoryというものは本質的に、

> **強く一貫した共有state**

だからである。

例えば、

```text
Developer A push
Developer B push
User C wiki edit
User D ticket update
```

が同時に発生する。

Cloudflare KVやR2に単純保存すると、

```text
read
modify
write
```

競合を自前で解決しなければならない。

一方Durable Objectなら、

```text
repository ID
      │
      ▼
single logical owner
```

を作ることができる。

この構造はFossil repositoryとの1対1対応が非常に自然である。

---

# 34. 実はCloudflare側のSQLiteは二重の意味で有利

2026年現在、新しいDurable ObjectはSQLite-backed storageを使うことが推奨され、Free planでも利用できる。SQL API、同期KV API、point-in-time recoveryなどが提供されている。

特にPITRは面白い。

Fossil自体が履歴管理システムなのに、

```text
Fossil repository
        │
        ▼
Durable Object SQLite
        │
        ▼
Cloudflare PITR
```

となる。

つまり、

> **履歴管理システムそのもののストレージをさらに時点復元できる**

という二重の安全性が得られる。

CloudflareのSQLite-backed Durable Objectsは過去30日以内へのpoint-in-time recoveryを提供している。

---

# 35. R2はどこで使えるか

大規模化する場合には、

```text
Durable Object
      +
R2
```

という構成も考えられる。

例えば、

```text
Durable Object
├ metadata
├ locks
├ SQLite hot pages
└ transaction state

R2
└ repository page/blob archive
```

のようにする。

ただしR2へのアクセスは基本的にasync object storageなので、

```text
SQLite xRead()
```

から直接使うstorageとしては扱いにくい。

したがってSQLite VFSのprimary backendには、

> **synchronous Durable Object storage**

の方が自然である。

R2は、

```text
backup
snapshot
large artifact
cold storage
```

向きと考えた方がよい。

---

# 36. Cloudflare D1を使う案はどうか

真っ先に思いつきそうなのが、

```text
Fossil uses SQLite
Cloudflare D1 is SQLite
↓
Fossil + D1
```

である。

しかし実際にはそれほど簡単ではない。

Fossilが期待しているのは、

```c
sqlite3_open("repo.fossil")
```

できるSQLite databaseである。

D1はremote SQL serviceのinterfaceなので、

```text
SQLite file API
```

を提供するわけではない。

そのため、

```text
Fossil SQLite
    ↓
D1
```

を直接つなぐことはできない。

SQLite C API compatibility layerを大量に書かなければならなくなる。

したがってD1よりDurable Object + custom VFSの方が設計として自然である。

---

# 37. 認証も基本的にはFossilに任せられる

Fossilはrepository内部に、

```text
users
password/auth data
permissions
sessions
```

を保持する。

したがってCloudflare Worker側で新しいauthentication systemを作らなくても、

```text
Request
 ↓
Fossil login
 ↓
cookie
 ↓
repository permissions
```

をそのまま使える。

Worker側では、

```text
Cookie
Authorization
Remote IP
HTTPS status
```

などをCGI environmentとして正しく渡せばよい。

---

# 38. Cloudflare Accessを前段に置くこともできる

private Fossilなら、

```text
Internet
   │
Cloudflare Access
   │
Worker
   │
Fossil
```

という構成も考えられる。

この場合、

```text
Cloudflare = perimeter authentication
Fossil = SCM authorization
```

という二層構造になる。

ただし通常の`fossil sync` clientとのcompatibilityを考えると、Access認証を介在させる場合は工夫が必要になる可能性がある。

---

# 39. Fossilのsync protocol自体はWorkersに非常に向いている

Git serverをWorkers化する場合、

```text
smart HTTP
pack generation
upload-pack
receive-pack
large streaming
```

などを考える必要がある。

Fossilの場合は、

```text
POST /xfer
```

という単純なHTTP transactionでsyncできる。

さらにartifact transferはzlib圧縮される。

したがって、

```text
HTTP request
↓
stateless Fossil transfer handler
↓
SQLite repository
```

という構造はedge/serverless environmentにかなり適している。

---

# 40. 面白いことにFossil側も「server implementationを気にしない」

Fossilのsync specificationでは、

```text
standalone server
inetd
CGI
SCGI
```

のどれでserverを動かしても、clientから見れば同じHTTP protocolだとしている。

つまり、

```text
Cloudflare Worker
```

を、

> 新しいFossil server transport adapter

と考えればよい。

Fossil clientからすると、

```bash
fossil sync https://my-project.example.com
```

が成功すれば、server内部が、

```text
Linux CGI
```

なのか、

```text
WebAssembly + Cloudflare Worker
```

なのか知る必要はない。

---

# 41. 最も美しい最終アーキテクチャ

本格的に設計するなら、私は次の形が理想だと考える。

```text
             fossil client
             Web browser
                  │
                HTTPS
                  │
                  ▼
       ┌────────────────────┐
       │ Cloudflare Worker  │
       │                    │
       │ routing            │
       │ Request → CGI      │
       │ response adapter   │
       └─────────┬──────────┘
                 │
                 │ repository ID
                 ▼
       ┌────────────────────┐
       │ Durable Object     │
       │ one per repository │
       │                    │
       │ ┌────────────────┐ │
       │ │ fossil.wasm    │ │
       │ │                │ │
       │ │ CGI engine     │ │
       │ │ Fossil core    │ │
       │ │ SQLite         │ │
       │ └───────┬────────┘ │
       │         │          │
       │   custom SQLite VFS│
       │         │          │
       │ ┌───────▼────────┐ │
       │ │ synchronous KV │ │
       │ │ SQLite-backed  │ │
       │ │ DO storage     │ │
       │ └────────────────┘ │
       └────────────────────┘
```

この構成なら、

```text
Fossil本体
Fossil Web UI
Fossil sync protocol
Fossil database schema
```

をほぼそのまま維持できる。

Cloudflare固有になるのは、

```text
HTTP adapter
Wasm runtime bridge
SQLite VFS
persistent storage
```

だけである。

---

# 42. 必要な改造量を層ごとに見る

```text
Fossil application logic       ほぼ変更なし
─────────────────────────────────
Fossil Web UI                  ほぼ変更なし
─────────────────────────────────
Fossil sync protocol           変更なし
─────────────────────────────────
SQLite                         ほぼ変更なし
─────────────────────────────────
SQLite VFS                     ★大きく変更
─────────────────────────────────
POSIX / WASI shim              一部実装
─────────────────────────────────
HTTP / CGI adapter             新規
─────────────────────────────────
Cloudflare storage adapter     新規
```

つまり、

> FossilをCloudflareへ移植する

と言っても、実際には、

> **SQLiteより下のI/O層と、CGIより上のHTTP層を差し替える**

作業になる可能性が高い。

これはソフトウェア設計としてかなり合理的である。

---

# 43. 逆に難しそうなFossil機能

すべてがそのまま動くとは考えにくい。

例えば、

```text
fossil shell
fossil ssh
external CGI extensions
external commands
local checkout operations
editor launch
browser launch
```

などOS processやlocal filesystemへ強く依存する機能はWorkersでは意味がない、または実装困難である。

CGI Server Extensionsも、外部executableを起動する設計なのでそのままでは使いにくい。Fossil公式のextension mechanismも実行可能fileをCGI processとして起動する構造になっている。

したがってWorker版Fossilは、

```text
server subset
```

としてcompileするのが合理的だろう。

---

# 44. server側で必要な機能だけを残す

例えば、

```text
ENABLE

/xfer
Web UI
timeline
wiki
tickets
forum
login
artifact browsing
admin
```

を残し、

```text
DISABLE

checkout
update working tree
external editor
SSH server
local browser
external CGI process
```

などをcompile-timeで除外する。

そうすればWasm binary sizeも減らせる。

WorkersではWasm binary sizeやstartup costも考慮すべきなので、server-only Fossil buildを作る価値がある。CloudflareもWasm applicationについてbinary size optimizationを推奨している。

---

# 45. 実現難易度を評価すると

全体を分解すると、

| 項目 | 難易度 |
|---|---:|
| Fossil C → Wasm compile | ★★☆☆☆ |
| Web UI実行 | ★★☆☆☆ |
| `/xfer` protocol | ★★☆☆☆ |
| CGI → Worker adapter | ★★☆☆☆ |
| temporary filesystem | ★★☆☆☆ |
| Fossil repository read-only | ★★☆☆☆ |
| repository丸ごとpersistent保存 | ★★★☆☆ |
| concurrent write | ★★★★☆ |
| custom SQLite VFS | ★★★★★ |
| production-grade durability | ★★★★★ |

つまり、

> **「Fossil Web UIがCloudflare Workerで表示できた」**

程度なら比較的簡単である。

一方、

> **実際にclone/pull/pushでき、複数人が安全に使えるFossil hosting**

まで作るのはかなり本格的なengineeringになる。

---

# 46. SNS投稿の「できることは確認できた」という表現から推測できること

ここはあくまで推測だが、その言い回しが文字通り、

> 「Cloudflare WorkerでFossil SCMできることは確認できた」

程度だったのであれば、完成したhosting serviceというより、

```text
Fossil → WebAssembly
        +
Worker filesystem
        +
最低限のrepository persistence
```

のproof-of-conceptだった可能性が高い。

2025年8月にWorkersへvirtual filesystemが入り、2025～26年にはWASI/Node compatibilityもかなり拡張されたため、以前よりこの種のexperimentは格段に容易になっている。

時期的にも非常に納得できる。

---

# 47. 特に「2025年以降だから可能になった」という可能性

昔のCloudflare Workersでは、

```text
persistent filesystemなし
POSIX filesystemなし
WASI support限定的
```

だった。

そのためFossilをWasm化しても、

```text
SQLite repositoryをopenできない
```

という問題にすぐ当たる。

ところが現在は、

```text
WebAssembly
+
experimental WASI
+
virtual filesystem
+
node:fs
+
SQLite-backed Durable Objects
+
synchronous KV
```

が揃っている。

そのため、

> **2025～2026年になって、Fossilのような既存C applicationをWorkersへ持っていくための部品が一通り揃った**

と見ることができる。

---

# 48. FossilとCloudflare Workersは意外に思想的相性も良い

技術面だけでなく、Fossilの設計思想そのものがserverless向きである。

Fossil：

```text
single executable
single repository file
embedded SQLite
HTTP sync
CGI support
minimal dependencies
```

Cloudflare Workers：

```text
isolated execution
HTTP request driven
WebAssembly
no traditional server management
state via Durable Objects
```

両者を重ねると、

```text
        Fossil
          │
    self-contained
          │
          ▼
      WebAssembly
          │
          ▼
   Cloudflare Worker
```

という非常に小さなhosting stackになる。

---

# 49. Git hostingを同じように作る場合との差

GitをCloudflare Workerでhostingしようとすると、

```text
Git repository
├ objects
├ refs
├ pack
├ index
└ locks

git-upload-pack
git-receive-pack
pack generation
delta compression
smart HTTP
```

などを移植する必要がある。

一方Fossilは、

```text
repo.fossil
      │
    SQLite
      │
      +
HTTP /xfer
```

で済む。

この差はかなり大きい。

**Fossilがsingle-file SQLite repositoryであることが、Cloudflare Workers移植では非常に大きな武器になる。**

---

# 50. 最終的な推定

今回調べた仕様から考えると、「Fossil SCM on Cloudflare Workers」は十分実現可能である。

最も可能性の高い実装経路は二段階である。

### Proof of Concept

```text
Fossil C
   ↓
WebAssembly
   ↓
Cloudflare Worker
   ↓
CGI compatibility layer
   ↓
ephemeral filesystem
   ↓
repo.fossil
   ↕
persistent object storage
```

この方式なら比較的少ない改造で、

```text
Web UI
clone
pull
push
```

まで到達できる可能性がある。

そして本格版では、

```text
Fossil
  ↓
SQLite
  ↓
Cloudflare-specific SQLite VFS
  ↓
Durable Object synchronous storage
```

へ移行する。

---

# 51. 最も重要な技術的ポイント

この仕組みの本質は、

> **FossilをCloudflare向けに書き直すことではない。**

むしろ、

```text
          Cloudflare
              │
       ┌──────┴──────┐
       │             │
      HTTP        Storage
       │             │
       ▼             ▼
   CGI adapter   SQLite VFS
       │             │
       └──────┬──────┘
              ▼
           Fossil
```

という二つのadapterを作り、

> **Fossilには「普通のCGI環境と普通のSQLiteファイルが存在する」と思わせる**

ことである。

この発想なら、Fossilの大部分は一切Cloudflareを意識しなくてよい。

---

# 52. 結論

私が実装するとすれば、最初は次の順序を取る。

```text
Step 1
FossilをWasmとしてcompile

        ↓

Step 2
read-only repositoryを
Workers ephemeral FS上でopen

        ↓

Step 3
CGI adapterを実装して
Fossil Web UIを表示

        ↓

Step 4
/xferを通して
clone/pullを動かす

        ↓

Step 5
repositoryをrequest前後で
persistent storageへload/save

        ↓

Step 6
pushを許可

        ↓

Step 7
1 repository = 1 Durable Object化

        ↓

Step 8
custom SQLite VFSを実装

        ↓

Step 9
full-file load/saveを廃止
```

特にStep 3までなら、

> **「Cloudflare WorkersでFossil SCMが動いた」**

というproof-of-conceptは十分現実的に見える。

そしてStep 8まで行けば、単なる実験ではなく、

> **Cloudflareのedge/serverless architectureにかなり自然に適合したFossil hosting service**

まで発展できる。

今回の調査で最も興味深い点は、CloudflareがFossil専用の機能を提供しているわけではないのに、

```text
Fossilの
single executable
+
single SQLite repository
+
CGI
+
HTTP-based sync
```

という20年来の設計と、

```text
Workersの
WebAssembly
+
request-based execution
+
Durable Objects
+
synchronous persistent storage
```

という現代的なserverless設計が、**偶然かなり綺麗に噛み合う**ことである。

したがって、このSNS投稿が単なる思いつきではなく実際のproof-of-conceptを指していたとしても、技術的には十分納得できる話である。