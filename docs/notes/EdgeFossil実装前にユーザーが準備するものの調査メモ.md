# EdgeFossil 実装前にユーザーが準備するものの調査メモ

調査日: 2026-08-24  
最終更新: 2026-08-25
対象環境: macOS 15.6.1 / Apple Silicon  
位置づけ: [`EdgeFossil実装計画書.md`](../plans/EdgeFossil実装計画書.md) を進めるために、project ownerが自分で取得・設定する必要があるものを、必要になる時期ごとに整理したもの

## 1. 結論

準備するものは次に限定できる。

| 時期 | 必要なもの | 今すぐ必要か |
|---|---|---:|
| P0開始前 | supported Node.js LTS | 必要。現在のNode.jsは更新対象 |
| P0開始前 | Git、Rust toolchain、pnpm | 準備済み |
| 実データで最初のlocal repositoryを作る直前 | EdgeFossil署名鍵と暗号化backup | まだ不要。I3eの実装testは合成一時鍵で行う |
| 最初のremote deploy前 | Cloudflare account、2FA、recovery codes | accountがなければ準備 |
| P3/P4直前 | Wrangler OAuth login、`workers.dev` subdomain | その時に設定 |
| P4直前 | R2 subscriptionとbilling profile | その時に設定 |
| 最初のR2/DO作成前 | data residency方針 | 法的要件がなければAutomatic |
| CIからdeployする時 | account IDとscoped Cloudflare API token | それまでは不要 |
| P4bで最初の認証済みremote uploadを行う時 | EdgeFossil staging owner tokenとWorker secret | adapterのcommit・通常CI成功後だけ必要 |
| P7でdirect large uploadを実装する時 | bucket限定R2 S3 credentials | 方式確定まで不要 |
| production custom URLを使う時 | Cloudflare管理zone/custom domain | 条件付き。開発には不要 |

Cloudflare Workers Paid plan、独自domain、D1、KV、Cloudflare Access、Turnstile、Workflows、R2 public URLなどを先に契約・作成する必要はない。

重要なのは、次を早く作りすぎないことである。

- R2 bucket名、Queue名、Worker名はP0で命名規則を決めてから作る。
- R2 jurisdictionは作成後に変更できないため、最初のbucket作成前にだけ確認する。
- CI用API tokenはCI deployを作る時に、必要なaccountへ限定して発行する。
- EdgeFossil owner tokenは認証済みupload adapterがgreenになってからstagingだけに設定する。
- S3 credentialsはWorker bindingだけで足りる段階では発行しない。
- custom domainは`workers.dev`でstagingを検証した後に設定する。

---

## 2. 現在のローカル環境の確認結果

2026-08-24に実機で確認した結果:

| 項目 | 現在値 | 判定 |
|---|---|---|
| macOS | 15.6.1、Apple Silicon | Wranglerの対応範囲 |
| Xcode Command Line Tools | `/Applications/Xcode.app/Contents/Developer` | 準備済み |
| Git | 2.50.1 | 準備済み |
| Rust | `rustc/cargo 1.94.1` | 準備済み |
| rustup | 導入済み | 準備済み |
| Node.js | 23.2.0 | **EOL。更新が必要** |
| npm | 10.9.0 | Node更新後に同梱版を利用 |
| pnpm | 10.10.0 | 準備済み。P0でversionをpinする |
| global Wrangler | 4.18.0 | 存在するが、project local版を使う |

CloudflareはWranglerについて、Node.jsのCurrent、Active、Maintenance releaseをsupport対象としている。Node.js 23は既にEOLである。EdgeFossilでは安定したLTSであるNode.js 24を使い、P0でversion fileとlockfileへ固定する。

参考:

- [Install/Update Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- [Node.js releases](https://nodejs.org/en/about/previous-releases)

---

## 3. 今すぐ行うローカル準備

### 3.1 Node.js 24 LTSへ更新する

現在のNode.jsはHomebrewの`node 23.2.0_1`である。既存環境に合わせ、最小手順はHomebrewのmajor-version formulaを使う方法である。

実行前に、現在の場所を確認する。

```bash
which node
node --version
brew list --versions node node@24
```

Node.js 24をinstallする。

```bash
brew install node@24
```

Homebrewの`node@24`は通常keg-onlyなので、bashのlogin shellから優先して使うようPATHを設定する。

```bash
echo 'export PATH="/opt/homebrew/opt/node@24/bin:$PATH"' >> ~/.bash_profile
exec bash -l
```

確認する。

```bash
which node
node --version
npm --version
pnpm --version
```

合格条件:

- `node --version` が `v24.` で始まる。
- `which node` が `/opt/homebrew/opt/node@24/bin/node` を指す。
- `pnpm --version` が実行できる。

注意:

- 既存のHomebrew `node` formulaを今すぐuninstallする必要はない。
- P0で`.node-version`または同等のversion fileと`packageManager` fieldを追加した後は、repositoryの指定を優先する。
- global Wranglerを更新・削除する必要はない。EdgeFossilではproject dependencyとしてinstallしたWranglerを使う。

### 3.2 既に準備済みのtoolを再確認する

```bash
git --version
rustup show active-toolchain
rustc --version
cargo --version
pnpm --version
```

すべて成功すれば追加installは不要である。

SQLite CLI、Docker、Terraform、D1 CLI、Cloudflare TunnelはP0開始条件ではない。local SQLiteはRust libraryから扱い、Cloudflare local runtimeはWranglerのproject dependencyから使う。

### 3.3 実データを扱う直前にlocal署名鍵を作る

この手順は`ef keygen`と`ef checkpoint`が実装されたI3e以降で、**破棄可能なtestではない最初のrepositoryを`ef init`する直前**に一度だけ行う。現在の実装・CI確認だけなら、testが一時鍵を自動生成するためuser作業は不要である。

まずrepositoryの外にownerだけが読めるdirectoryを用意する。次の`my-project`は秘密を含まない識別名へ置き換える。

```bash
mkdir -p ~/.config/edgefossil/keys
chmod 700 ~/.config/edgefossil ~/.config/edgefossil/keys
cargo run -p ef-cli --bin ef -- keygen \
  --output ~/.config/edgefossil/keys/my-project-owner.seed
```

commandは次の二行だけを表示する。

```text
actor-key: <64文字の公開鍵>
signing-key-file: <鍵fileの絶対path>
```

`actor-key`は公開情報であり、続く`init --actor-key`へ指定する。鍵fileの内容は32-byte Ed25519 seedであり秘密である。CLIは内容を表示しない。

```bash
cargo run -p ef-cli --bin ef -- init \
  --name "My project" \
  --actor-key <keygenが表示したactor-key> \
  --path /path/to/project
```

確認する。

```bash
stat -f '%Sp %N' ~/.config/edgefossil/keys/my-project-owner.seed
cargo run -p ef-cli --bin ef -- status --path /path/to/project
```

合格条件:

- key fileのpermissionが`-rw-------`である。
- key fileがproject directoryや`.edgefossil`の内側にない。
- `status`のproject identityが表示される。
- `init`へ渡した公開鍵とkey fileの組が分かるよう、秘密を含まないproject名だけをpassword manager等へ記録する。
- key fileを暗号化されたbackupへ一つ保存し、復元できることを確認する。I3eでは鍵rotation/recoveryが未実装なので、原本とbackupの両方を失うと新しいcheckpointを署名できない。

snapshot後、履歴へ確定する時はrealmとmessageを明示する。

```bash
cargo run -p ef-cli --bin ef -- checkpoint \
  --path /path/to/project \
  --realm public \
  -m "Initial parser" \
  --signing-key-file ~/.config/edgefossil/keys/my-project-owner.seed
```

`--realm public`のmessageは将来webへ公開され得る。restrictedな説明は`--realm members`の別checkpointへ書き、端末内だけの説明は`--realm local`へ書く。一つのcommandで複数realmを進めないのはmessageの誤公開を防ぐためである。

禁止事項:

- seed内容をterminal command、shell環境変数、`.env`、repository、issue、chatへ貼らない。
- test用repositoryと実データrepositoryでowner keyを使い回さない。
- public keyだけを保存してseed fileを削除しない。public keyから署名seedは復元できない。

このlocal署名鍵はCloudflare API tokenやWrangler credentialとは別物であり、Cloudflareへ登録・uploadしない。

---

## 4. Cloudflare accountを準備する

この作業はremote deployの直前までに済ませればよい。P0/P1のformat作業と大半のP2 local作業にはCloudflare accountは不要である。

### 4.1 accountを選ぶ

既に自分がownerとして管理するCloudflare accountがある場合、新しいaccountを作る必要はない。そのaccountを使う。

新しく作る場合:

1. [Cloudflare dashboard](https://dash.cloudflare.com/)を開く。
2. `Sign up`を選ぶ。
3. 長く利用できるemail addressと固有のpasswordを設定する。
4. Cloudflareから届くemailでaddressをverifyする。
5. Dashboardで作成されたaccountを開く。

選択条件:

- 自分がowner/Super Administratorである。
- `Workers & Pages`の設定とstaging deployを自分で管理できる。

複数のCloudflare accountがある場合、EdgeFossilに使う一つを決める。stagingとproductionのためにaccountを二つ作る必要はない。resource名とWrangler environmentで分離する。

### 4.2 2FAとrecovery codesを設定する

EdgeFossil accountはsource、restricted data、deployment secretを管理するため、remote resourceを作る前に2FAを必須とする。

1. Cloudflare dashboardへloginする。
2. 右上のuser menuから `My Profile` を開く。
3. `Authentication` を開く。
4. `Two-Factor Authentication` の `Set up` を選ぶ。
5. security keyまたはTOTP authenticatorを少なくとも一つ登録する。
6. passwordと認証codeで設定を確定する。
7. 表示されたbackup codesをdownloadまたはcopyする。
8. backup codesをpassword manager等、Cloudflare loginとは別の安全な場所へ保存する。

確認:

- 一度logoutし、password + 2FAでloginできる。
- backup codesがrepository、Downloads folder、plain text noteに残っていない。

参考:

- [Cloudflare two-factor authentication](https://developers.cloudflare.com/fundamentals/user-profiles/2fa/)

### 4.3 account IDを確認する

local interactive利用ではWranglerがaccountを選べるため、account IDを環境変数へ入れる必要はない。CIを設定する時に必要になるので、確認方法だけ記録する。

Dashboardで:

1. account homeを開く。
2. `CMD + K`を押す。
3. `Copy account ID`を検索して選ぶ。

別の方法:

1. `Workers & Pages`を開く。
2. `Account Details`に表示されるAccount IDをcopyする。

Account IDはpasswordではないが、public issueやsample configへ不用意に載せない。password managerまたはprivate project noteへ、どのaccountのIDか分かる名前で保存する。

参考:

- [Find account and zone IDs](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/)

---

## 5. WranglerでCloudflareへloginする

この作業はP3/P4で最初のremote deployを行う時に実施する。今のglobal Wranglerではなく、P0でrepositoryへ追加されるproject-local Wranglerを使う。

P0完了後の想定手順（依存関係が導入済みなら`pnpm install`は不要）:

```bash
cd /Users/dolphilia/github/edgefoss
pnpm exec wrangler --version
pnpm exec wrangler login --use-keyring
pnpm exec wrangler whoami
```

`login`を実行するとbrowserが開く。

1. Cloudflareへloginする。
2. EdgeFossil用に選んだaccountへのWrangler accessを許可する。
3. terminalへ戻る。
4. `whoami`のaccount名が、利用するaccountと一致することを確認する。

`--use-keyring`により、OAuth credentialの暗号化keyをmacOS Keychainで管理する。Global API Keyを取得・設定してはいけない。

注意:

- `whoami`の出力にはaccount情報が含まれるため、public issueへ全文を貼らない。
- `CLOUDFLARE_API_TOKEN`がshellや`.env`に設定されていると、OAuthより優先される。意図しないaccountが表示される場合は、その環境変数を確認する。
- `.wrangler`やOS keychainのcredentialをrepositoryへcopyしない。

参考:

- [Wrangler general commands and login](https://developers.cloudflare.com/workers/wrangler/commands/general/)
- [Wrangler system environment variables](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/)

---

## 6. `workers.dev` subdomainを設定する

custom domainを買わずにP3/P4のstagingへアクセスするために必要である。初回remote deploy時まで待ってよい。

1. Cloudflare dashboardで `Workers & Pages` を開く。
2. `Your subdomain`を確認する。
3. 未設定なら `Change` または初回setup promptを選ぶ。
4. account全体で使う短いsubdomainを設定する。
5. 公開URLになる名前なので、秘密、email address、projectのrestricted名称を含めない。

Worker URLは概ね次になる。

```text
https://<worker-name>.<account-subdomain>.workers.dev
```

確認は、P3/P4のdeploy後に行う。

```bash
pnpm exec wrangler deploy --env staging
```

deploy outputのURLをbrowserで開き、staging health pageだけが返ることを確認する。

安全上の注意:

- `workers.dev`は有効にするとpublic endpointである。restricted securityはURLの推測困難性ではなくEdgeFossilのauthenticationで守る。
- productionでcustom domainへ移行した後に`workers.dev`を無効化する場合、dashboardだけでなく`wrangler.jsonc`へ`"workers_dev": false`を記録する。そうしないと次回deployで再び有効になり得る。
- preview URLも同様にpublic exposureとして確認する。

参考:

- [workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)

---

## 7. R2 subscriptionを有効にする

P4のRepositoryDO + R2 vertical sliceを始める直前に必要である。Cloudflare accountを作っただけではR2を利用できず、R2 subscriptionのcheckoutが必要である。

CloudflareのR2にはfree monthly usageが含まれるが、subscription自体はbilling productであり、checkout時にbilling profile/payment methodを求められる場合がある。

手順:

1. Cloudflare dashboardで、EdgeFossilに使うaccountを選ぶ。
2. `Storage & databases` → `R2` → `Overview` を開く。
3. subscriptionが未設定なら、表示されるcheckout flowを開始する。
4. account種別、billing address等を確認する。
5. 必要なら `Billing` → `Subscriptions` → `Payment methods` からprimary payment methodを追加する。
6. checkoutを完了する。
7. R2 Overviewを再度開き、bucket作成画面が利用できることを確認する。

CLIでの確認はWrangler login後に行う。

```bash
pnpm exec wrangler r2 bucket list
```

bucketが0件でも、permission errorではなく正常なlist結果になればよい。

この時点ではbucketを手作業で作らない。P4のresource manifestと命名規則が完成してから、projectのprovision commandで作る。

参考:

- [R2 get started](https://developers.cloudflare.com/r2/get-started/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Cloudflare billing profile](https://developers.cloudflare.com/billing/get-started/create-billing-profile/)

---

## 8. data locationを決める

これは設定作業というより、最初のR2 bucketとRepositoryDOを作る前の一回の判断である。

### 8.1 法的なdata residency要件がない場合

推奨:

```text
R2: Automatic
DO jurisdiction: 指定なし
DO location hint: primary userに近い地域をapplication側で指定
```

日本を主な利用場所とするなら、RepositoryDOの初回作成時にapplicationから`apac-ne` location hintを与える案をP4で実装する。userがDashboardでDOを事前作成する必要はない。

R2はAutomaticが公式の推奨defaultである。bucket作成requestに近い利用可能regionが選ばれる。

### 8.2 法令・契約による要件がある場合

R2とDOで同じjurisdiction方針を選ぶ。

- `eu`: European Union
- `us`: United States
- `fedramp`: 対象契約・planがある場合のみ

判断前に確認すること:

1. restricted sourceやissue/wikiをどの地域へ保存しなければならないか。
2. log、backup、exportにも同じ制約が必要か。
3. projectの主な利用者がいる地域と法的storage地域が異なるか。

R2 bucketは作成後にjurisdictionを変更できない。要件が不明なら、推測で`eu`や`us`を選ばずbucket作成を止める。

project configへ記録する想定:

```jsonc
{
  "data_policy": {
    "jurisdiction": "automatic",
    "primary_region": "apac-ne"
  }
}
```

参考:

- [R2 data location](https://developers.cloudflare.com/r2/reference/data-location/)
- [Durable Objects data location](https://developers.cloudflare.com/durable-objects/reference/data-location/)

---

## 9. cloud resourcesはproject側で作る

userがDashboardで個別に作成・bindingするのではなく、P4で実装するidempotent provision commandに任せる。

stagingで必要になるresource:

```text
Worker + Static Assets
RepositoryDO SQLite namespace
R2 public blobs bucket
R2 restricted blobs bucket
R2 exports bucket
events Queue
dead-letter Queue
```

userが行うこと:

1. `wrangler.jsonc`とprovision planをreviewする。
2. resource名に`staging`が含まれ、production名と重ならないことを確認する。
3. R2 jurisdiction/AutomaticがSection 8の判断と一致することを確認する。
4. dry-run/plan outputを確認する。
5. projectが用意するcommandを実行する。
6. list/info commandで作成結果を確認する。

command interface:

```bash
pnpm run cloud:plan -- --env staging
# U2承認後、実装済みと案内された時だけ次の二つを実行する
pnpm run cloud:provision -- --env staging
pnpm run cloud:verify -- --env staging
```

`cloud:plan`はlocal manifestだけを読み、Cloudflareへread/writeを行わない。
U2承認後に`cloud:provision`と`cloud:verify`も実装した。provisionは承認済み
digestが一致しなければremote access前に停止し、既存resourceを全件確認して
から不足分だけを作る。verifyはremote readだけを行う。productionには承認
fileがないため、両commandとも停止する。

実装変更のcommit/CI成功を確認するまではprovisionを実行しない。実行を案内
された後は、最初に`cloud:provision`、続けて`cloud:verify`を実行し、後者が
`readyForWorkerDeployment: true`になることを確認する。途中で失敗しても
Dashboardで削除せず、出力を確認して同じprovisionを再実行する。

planが表示する`manifestDigest`は承認対象を固定する。resource名や配置方針を
変更するとdigestも変わるため、変更後は再reviewする。

作成後のWrangler確認例:

```bash
pnpm exec wrangler r2 bucket list
pnpm exec wrangler queues list
pnpm exec wrangler whoami
```

Durable Object namespaceは、Worker code、binding、`wrangler.jsonc`のdeclarative `exports`をdeployした時にCloudflareがreconcileする。Dashboardで空のDOを手作りしない。

禁止事項:

- restricted R2 bucketで`r2.dev`を有効にしない。
- restricted R2 bucketへcustom domainを付けない。
- stagingからproduction bucketをremote bindingしない。
- resource ID/nameをlocal secret fileへ手書きしてsource of truthを二重化しない。
- production resourceのdelete/renameをapprovalなしで行わない。

---

## 10. CI deploy用API token

localで手動deployする間は不要である。P4以降、CIからstagingまたはproductionへdeployする時にだけ作る。

### 10.1 tokenを作る

1. Cloudflare dashboardでEdgeFossilに使うaccountを開く。
2. `Manage Account` → `API Tokens`を開く。
3. `Create Account API token`または`Create Token`を選ぶ。
4. permission policyの`Custom` dropdownから`Edit Cloudflare Workers`を選ぶ。
5. token名を`edgefoss-staging-github-actions`など用途が分かる名前にする。
6. account resourcesをEdgeFossilに使う一つのaccountへ限定する。
7. template外のpermission、別account、不要なzoneを追加しない。
8. summaryを確認してtokenを作成する。
9. 表示されたtokenを一度だけcopyし、直ちにCI secret storeへ保存する。

tokenをlocal shell profile、repository、`.env`、issue、chatへ保存しない。

### 10.2 GitHub Actionsへ保存する場合

1. GitHub repositoryの `Settings` を開く。
2. `Secrets and variables` → `Actions` を開く。
3. `New repository secret`を選ぶ。
4. nameを `CLOUDFLARE_API_TOKEN`、valueをCloudflare tokenにする。
5. `New repository secret`をもう一度選び、nameを`CLOUDFLARE_ACCOUNT_ID`、valueを選択済みaccountのAccount IDにする。
6. `Deploy staging Worker` workflowがcommit済みになるまではworkflowを実行しない。
7. production deployにenvironment approvalを使う場合、repository secretではなくGitHub `production` environmentへ別tokenを置く。

CI workflowは次の環境変数だけをWranglerへ渡す。

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

確認:

- CI logにtoken valueが表示されない。
- pull requestからproduction deploy jobを直接実行できない。
- staging tokenでproduction environmentを変更できない構成を、可能な範囲でresource/approvalにより分離する。
- Global API Keyを使っていない。

Cloudflareの公式GitHub Actions手順も、localでは`wrangler login`、CIではAPI token + account IDを使い、`Edit Cloudflare Workers` templateからtokenを作る方法を示している。

現在のstaging workflowは二つともrepository secretとして参照する。Account IDはtokenではないが、workflowとの設定差を減らし、account情報を不用意にlogへ出さないため同じ画面へ保存する。GitHub Environment、production token、automatic push deployはこのcheckpointでは作らない。

参考:

- [Deploy Workers with GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [Wrangler system environment variables](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/)

### 10.3 最初のremote upload直前にEdgeFossil owner tokenを設定する

これはGitHub ActionsがCloudflareを操作するためのAPI tokenではなく、EdgeFossil
applicationのupload APIへownerとして認証するためのbootstrap secretである。P4bの
認証済みadapterがcommitされ通常CIに通るまでは作らない。stagingだけに一つ設定し、
production用はまだ作らない。

1. repository rootで次を実行する。

   ```bash
   pnpm run auth:generate-owner-token
   ```

2. 表示された`efoss_owner_v0_...`をpassword managerへ保存する。項目名は
   `EdgeFossil staging owner token`など、環境が分かる名前にする。
3. tokenをargument、shell profile、`.env`、repository、issue、chatへ貼らず、次の
   commandをそのまま実行する。

   ```bash
   pnpm exec wrangler secret put EDGEFOSS_OWNER_TOKEN --env staging --config apps/worker/wrangler.jsonc
   ```

4. Wranglerがsecret valueを求めた時だけpassword managerから貼り付けて確定する。
   command lineへvalueを続けて書かない。
5. command成功だけを報告し、token valueや先頭・末尾文字を報告しない。
6. その後、`main`からmanual `Deploy staging Worker` workflowを実行する。healthが
   `schemaVersion: 3`を返すまではremote upload smokeを実行しない。

`wrangler secret put`はWorker secretを変更し、新しいWorker versionをdeployする操作で
ある。従って通常CI成功後、このcheckpointで一度だけ実行する。紛失・漏洩の疑いが
ある場合は新しいtokenを生成して同じcommandで置き換え、古い値をpassword manager
から削除する。

参考:

- [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Wrangler secrets](https://developers.cloudflare.com/workers/wrangler/commands/#secret)

### 10.4 schema 3 health成功後にsynthetic uploadを一度だけ確認する

実装担当者がschema 3 health成功を確認して案内した後にだけ行う。次のcommandはtokenを
shell historyへ残さず、そのprocess環境からreview済みsmokeへ渡す。

```bash
read -r -s EDGEFOSS_OWNER_TOKEN
export EDGEFOSS_OWNER_TOKEN
pnpm run cloud:smoke-upload --origin https://edgefoss-staging.miga-and-raia.workers.dev
unset EDGEFOSS_OWNER_TOKEN
```

`pnpm run`と`--origin`の間に追加の`--`を入れない。URLはMarkdown linkではなく、
上記のように角括弧や丸括弧を含まない生のHTTPS originとして貼り付ける。実行前に
`node --version`がrepositoryの`.node-version`と同じ`v24.19.0`であることも確認する。

最初の`read`で表示が止まったら、password managerからtokenを貼り付けてEnterを押す。
画面にtokenが表示されないのが正常である。smoke commandはtargetをこのstaging originへ
固定し、宣言・content・finalizeを各再送して同じ結果へ収束することとschema 3 healthを
確認する。

この操作はstagingの`PUBLIC_BLOBS`へ30 byteの固定synthetic objectを一つ作り、対応する
upload/blob rowをRepositoryDOへ残すremote mutationである。自動削除はまだ実装しない。
同じoperation IDとcontentを使うためcommand再実行でcanonical blobは増えないが、成功後
に理由なく繰り返さない。報告するのは`state`、`retryConverged`、
`repositorySchemaVersion`だけでよく、tokenは報告しない。

### 10.5 schema 4 publish adapter deploy後にsynthetic projectを一度だけ初期化する

新しいCloudflare credentialやresourceは不要である。既にpassword managerへ保存した
`EDGEFOSS_OWNER_TOKEN`だけを使う。次の全条件を満たすまで実行しない。

- publish adapter変更をcommit/pushし、通常GitHub Actionsが成功した。
- `main`からmanual staging deployが成功した。
- stateful healthが`schemaVersion: 4`を返す。
- 対象がexact staging originであり、productionではない。
- 次の恒久的なstaging state変更をuserが確認した。

実行すると、公開synthetic signing fixtureをowner actorとするproject genesis、既存30-byte
public blobを参照するtree、changeを各1件acceptし、public `heads/main`をgeneration 1へ
進める。receiptとoperation resultも各3件作る。同じ入力の再実行は保存済み結果へ収束する。
新しいR2 object、members data、Queue consumerは作らない。Single Editionのproject identityは
一つなので、productionや既存user repositoryでは絶対に実行しない。

実行手順:

```bash
cd /Users/dolphilia/github/edgefoss
read -r -s EDGEFOSS_OWNER_TOKEN
export EDGEFOSS_OWNER_TOKEN
pnpm run cloud:smoke-publish --origin https://edgefoss-staging.miga-and-raia.workers.dev
unset EDGEFOSS_OWNER_TOKEN
```

注意:

- URLにMarkdownの`[]()`を付けず、上記のraw URLをそのまま使う。
- tokenはcommand argument、shell history、issue、log、完了報告へ書かない。
- 成功時は`state: published`、`retryConverged: true`、
  `repositorySchemaVersion: 4`、`repoSequence: 3`、`refGeneration: 1`、
  `r2WritePerformed: false`を確認する。
- 失敗時もtoken値は共有せず、HTTP statusとerror codeだけを報告する。

---

## 11. P7で必要になるR2 S3 credentials

small uploadをWorker binding経由だけで処理するP4/P5では不要である。P7でbrowser/CLIからR2へ直接multipart uploadし、Workerがpresigned URLを発行する方式を採用した場合にだけ作る。

### 11.1 bucketを作った後にcredentialを発行する

1. Cloudflare dashboardで `Storage & databases` → `R2` → `Overview` を開く。
2. `Manage in API Tokens`を選ぶ。
3. `Create Account API token`を選ぶ。
4. permissionを `Object Read & Write`にする。
5. `Apply to specific buckets only`を選ぶ。
6. direct upload対象のEdgeFossil bucketだけを選ぶ。
7. tokenを作成する。
8.表示されたAccess Key IDとSecret Access Keyをcopyする。Secretは後から再表示できない。

### 11.2 Worker secretへ保存する

projectでbinding名が確定した後、値をcommand argumentへ書かずinteractive promptで設定する。

```bash
pnpm exec wrangler secret put R2_UPLOAD_ACCESS_KEY_ID --env staging
pnpm exec wrangler secret put R2_UPLOAD_SECRET_ACCESS_KEY --env staging
```

productionでは`--env production`へ別credentialを設定する。staging credentialを再利用しない。

確認:

- token scopeに関係ないbucketが含まれない。
- credentialを`.dev.vars`、`.env`、`wrangler.jsonc`へ書いていない。
- Workerはcredentialをresponse/logへ出さない。
- presigned URLのexpiry、method、keyが限定されるtestがある。

direct uploadを採用しない場合、このcredentialは作らない。

参考:

- [R2 S3 credentials](https://developers.cloudflare.com/r2/get-started/s3/)
- [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)

---

## 12. custom domainは条件付き

P3–P6の開発・canaryは`workers.dev`で進められるため、domain購入やDNS移管は必須ではない。

次のどれかが必要になった時に設定する。

- 一般利用者へ安定したproject URLを案内する。
- business-critical productionとして運用する。
- public R2 contentをcustom domain/CDN経由で配信する。
- `workers.dev`から独立したorigin/security policyを持つ。

### 12.1 既存domainを使う場合

1. domainがEdgeFossilと同じCloudflare accountのactive zoneであることを確認する。
2. まだCloudflare zoneでなければ、Dashboardの `Domains`からdomainを追加する。
3. Dashboardが指定するnameserverへregistrar側のnameserverを変更する。
4. zone statusが `Active`になるまで待つ。
5. EdgeFossil用hostnameを決める。例: `project.example.com`。
6. そのhostnameに既存CNAMEがないことを確認する。
7. `wrangler.jsonc`へCustom Domain routeを追加する。

```jsonc
{
  "routes": [
    {
      "pattern": "project.example.com",
      "custom_domain": true
    }
  ]
}
```

8. staging test後、`pnpm exec wrangler deploy --env production`で反映する。
9. certificate発行とHTTPS accessを確認する。

Workerがapplication originなので、外部originを前提とするRouteではなくCustom Domainを使う。

restricted R2 bucketにdomainを直接接続しない。public blob用のdomainを追加する場合も、public bucketだけを対象にする。

参考:

- [Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Workers routes and domains](https://developers.cloudflare.com/workers/configuration/routing/)

---

## 13. Workers Paid planは最初は不要

2026-08-24時点では、次がWorkers Free planで利用できる。

- SQLite-backed Durable Objects
- Cloudflare Queues
- Workers/Static Assetsのfree allowance
- R2のfree monthly usage。別途R2 subscription checkoutは必要

従ってP0–P6の開発開始条件としてWorkers Paid planを契約しない。

Paidへ移る判断はP4/P5の実測後に行う。

- Free limit超過でoperationが失敗する。
- retention、storage、request/CPU budgetがcanaryに不足する。
- productionの予測usageがfree allowanceを安定して超える。
- paid featureを具体的に採用する。

「将来必要そう」という理由だけでupgradeしない。一方、productionでFree limit超過が即failureになる状態を許容できない場合は、release前にPaidへ移る。

参考:

- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)

---

## 14. 今は準備しないもの

| 項目 | なぜ不要か | 再検討時期 |
|---|---|---|
| D1 database | 最初のauthorityはRepositoryDO | `single-d1` decision時 |
| Workers KV | canonical stateに使わない | public cache要件発生時 |
| Workflows | P4/P5の短い処理には不要 | P7 export/restoreがHTTP範囲を超えた時 |
| Cloudflare Access | EdgeFossil自身のrealm authを検証する | private stagingの補助保護が必要な時 |
| Turnstile | anonymous writeを初期実装しない | public form/issue abuseが対象になった時 |
| WAF/API Shield paid option | core correctnessの前提にしない | production threat model後 |
| Vectorize/Workers AI | MVP検索はSQLite FTS | post-MVP semantic search |
| R2 public `r2.dev` | public配信も最初はWorker/static route | public bucket delivery設計が確定した時 |
| bucket lock | GC/retention prefix設計前は危険 | P7 retention policy確定後 |
| separate Cloudflare account | environment/resource名で分離可能 | organization/security要件発生時 |
| S3 client/rclone | Worker bindingとWranglerで足りる | bulk migration要件発生時 |
| GitHub App/OAuth App |初期CLI authとsource hostingに不要 | P8 browser auth/proposal integration時 |

---

## 15. user checklist

### 今行う

- [ ] Node.js 24 LTSへ更新する。
- [ ] Git、Rust、Cargo、pnpmが引き続き動くことを確認する。
- [ ] Cloudflare accountを既に持っているか確認する。なければ作成する。
- [ ] Cloudflare accountで2FAを有効にし、recovery codesを安全に保存する。

### P3 remote deploy直前に行う

- [ ] EdgeFossilに使うCloudflare accountを一つ決める。
- [ ] project-local Wranglerで`login --use-keyring`し、`whoami`を確認する。
- [ ] `workers.dev` account subdomainを設定する。

### P4 stateful resource作成直前に行う

- [ ] R2 subscription checkoutを完了する。
- [ ] data residency要件の有無を回答する。なければAutomaticを選ぶ。
- [ ] `cloud:plan`が示すstaging resource名とjurisdictionをreviewする。

### P4b最初のremote upload直前に行う

- [x] project commandでstaging owner tokenを生成しpassword managerへ保存する。
- [x] `EDGEFOSS_OWNER_TOKEN`をstaging Worker secretとして設定する。
- [x] schema 3 deployとhealth成功前にはremote upload smokeを実行しない。
- [x] 案内後にsynthetic staging smokeを一度実行し、tokenをunsetする。

### P4c最初のremote publish直前に行う

- [x] publish adapterのcommit後に通常CI成功を確認する。
- [x] manual staging deployとschema 4 stateful health成功を確認する。
- [ ] synthetic staging projectの恒久的な初期化効果を確認する。
- [ ] 案内後にpublish smokeを一度実行し、tokenをunsetする。

### 必要になった時だけ行う

- [ ] CI deploy開始時にscoped Cloudflare API tokenを作る。
- [ ] P7でdirect upload採用時にbucket限定R2 S3 credentialsを作る。
- [ ] production URLが必要になった時にcustom domainを追加する。
- [ ] 実測で必要になった時だけWorkers Paidへ変更する。

---

## 16. userが保存する情報

password manager等に保存するもの:

- Cloudflare login account/email
- 2FA recovery codes
- 選択したCloudflare account名とaccount ID
- billing profileの管理責任者
- data residency判断と根拠
- CI API tokenを作った日、scope、用途、rotation/revoke記録
- EdgeFossil staging owner tokenと作成・rotation日
- R2 S3 credentialを作った日、対象bucket、用途、rotation/revoke記録
- production domain/zone ID。custom domainを使う場合のみ

repositoryへ保存してよいもの:

- resourceの論理名と実resource名
- accountを識別する非secretなconfiguration。ただしpublic公開の必要性を確認する
- jurisdiction/location policy
- `wrangler.jsonc`
- Cloudflare product/format/compatibility version
- secretの**名前**と設定手順

repositoryへ保存してはいけないもの:

- Cloudflare API token value
- Global API Key
- R2 Secret Access Key
- OAuth token
- session cookie
- presigned URL
- 2FA recovery code
- billing/card情報

---

## 17. 最終提案

2026-08-25時点でNode.js 24、account安全確認、Wrangler OAuth、workers.dev、R2、
staging resources、CI deploy token、staging owner secret、schema 4 migrationまでは完了した。
次に新しく準備するCloudflare resourceやcredentialはない。publish adapterのcommit/通常CI、
manual staging deploy、schema 4 healthの順に確認した後、既存owner tokenを一時的な環境変数
として一度だけsynthetic publish smokeへ渡す。production secret、R2 S3 credential、
custom domainはまだ作らない。

Cloudflare側の準備は、次の順で段階的に行う。

```text
Cloudflare account + 2FA
        ↓ remote deploy直前
Wrangler OAuth + workers.dev
        ↓ R2を初めて使う直前
R2 subscription + data location確認
        ↓ project manifest完成後
staging resourcesをproject commandでprovision
        ↓ CI deploy開始時
scoped API token
        ↓ 最初の認証済みupload直前
EdgeFossil staging owner secret
        ↓ direct upload採用時のみ
bucket限定R2 S3 credentials
        ↓ production URLが必要な時のみ
custom domain
```

この順序なら、使わないproductやcredentialを先に増やさず、irreversibleなjurisdiction判断とsecurity-criticalなcredential発行だけを適切な時点で行える。

---

## 参考資料

### Account / authentication

- [Cloudflare two-factor authentication](https://developers.cloudflare.com/fundamentals/user-profiles/2fa/)
- [Find account and zone IDs](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/)
- [Wrangler login commands](https://developers.cloudflare.com/workers/wrangler/commands/general/)
- [Wrangler environment variables](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/)
- [GitHub Actions deployment](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)

### Workers / domains

- [Install/Update Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- [workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
- [Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Durable Object class exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)

### R2 / location / pricing

- [R2 get started](https://developers.cloudflare.com/r2/get-started/)
- [R2 data location](https://developers.cloudflare.com/r2/reference/data-location/)
- [R2 S3 credentials](https://developers.cloudflare.com/r2/get-started/s3/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Durable Objects data location](https://developers.cloudflare.com/durable-objects/reference/data-location/)
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)

### Local toolchain

- [Homebrew `node@24` formula](https://formulae.brew.sh/formula/node@24)
- [Node.js releases](https://nodejs.org/en/about/previous-releases)
