# VPS-ONE Cloudflare 一键部署说明

本文说明如何把 IDC-ONEMAN 部署为一个 Cloudflare Worker。前端由 Worker Assets 提供，API、D1、Queues、Cron、HashPay、CLICD、Resend 邮件任务都在同一 Worker 项目中运行。

> 部署页面会要求你登录 Cloudflare 和 GitHub，并由 Cloudflare 在你的账号中创建资源。只有使用本地 Wrangler 或自动化脚本部署时才需要 OAuth 登录或 API Token。

## 1. 一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Foneman-idc%2Fidc-oneman-cf%2Ftree%2Fmain%2Fcloudflare)

直接链接：

```text
https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Foneman-idc%2Fidc-oneman-cf%2Ftree%2Fmain%2Fcloudflare
```

Deploy Button 只支持 Workers，不支持 Pages；因此本版本使用单 Worker + Worker Assets，而不是旧版的 Worker API + Pages 双项目结构。

## 部署步骤：

1. 点击按钮并登录 Cloudflare。
2. 按页面提示授权 GitHub。Cloudflare 会把 `cloudflare/` 子目录复制为一个独立仓库，因此后续可以通过 Git 提交自动更新。
3. 选择 Cloudflare Account、GitHub 仓库名和 Worker 名。默认值可以直接使用。
4. 填写下面五项部署变量。前三个安全值[SECRET_KEY、MASTER_KEY、ADMIN_BOOTSTRAP_TOKEN]必须分别填入16+位字符串，ADMIN_BOOTSTRAP_TOKEN值初始化时必须用到请谨记。
5. RESEND_API_TOKEN填入Resend API KEY，EMAIL_FROM填入邮箱[格式 noreply@域名.com]，发件地址必须属于已验证域名 https://resend.com/ 上验证域名及获取API KEY。
6. ALLOWED_ORIGINS，PAGES_ORIGIN 为跨域域名，填写格式为：a.com,b.com,c.com,a.com部署站点的域名|b.com支付接口域名|c.com CLICD母鸡域名,可添加多条[,]分割，可CF中 Worker 定义环境变量和机密修改。
7. 确认构建命令和部署命令，开始部署。
8. 等待构建完成，打开页面给出的 `https://<worker>.<subdomain>.workers.dev` 地址或worker绑定的自定义域名进行初始化。
9. 首次打开会显示“创建管理员”。输入管理员邮箱、密码和第 4 步填写的 `ADMIN_BOOTSTRAP_TOKEN`。

部署页面应识别以下命令：

```text
Build command: npm run build
Deploy command: npm run deploy
```

`npm run deploy` 会再次确认静态资源构建结果，随后按 D1 binding 名称执行远端 migration，最后发布 Worker。重复执行 migration 是安全的，已应用的 migration 不会重复执行。
Worker 首次处理 API、Queue 或 Cron 前还会检查 16 张必需表和实例交付字段；一键部署过程若留下空库或不完整旧库，会使用随 Worker 打包的幂等 schema 自动补齐。

## 2. 部署变量说明

| 名称 | 用途 | 要求 |
| --- | --- | --- |
| `SECRET_KEY` | Session、CSRF 及安全令牌签名 | 至少 32 字节随机值 |
| `MASTER_KEY` | 加密 CLICD Token、HashPay 私钥、卡密和实例凭据 | 至少 32 字节随机值，且必须与 `SECRET_KEY` 不同 |
| `ADMIN_BOOTSTRAP_TOKEN` | 首次创建管理员时的一次性授权 | 至少 32 字节随机值 |
| `RESEND_API_TOKEN` | 调用 Resend HTTP API | Resend 创建的 API Token |
| `EMAIL_FROM` | 实例、卡密和退款邮件发件人 | 已验证域名，如 `VPS-ONE <noreply@example.com>` |
| `ALLOWED_ORIGINS` | 你要使用的自定义跨域域名 | 如 `a.com,b.com,c.com` |
| `PAGES_ORIGIN` | 你要使用的自定义跨域域名 | 如 `a.com,b.com,c.com` |
建议ALLOWED_ORIGINS PAGES_ORIGIN值保持一致！

## 关于MASTER_KEY的重要说明：

Linux、macOS 或安装了 OpenSSL 的终端可执行三次：

```bash
openssl rand -hex 32
```

也可以在浏览器开发者工具 Console 中执行三次：

```js
[...crypto.getRandomValues(new Uint8Array(32))].map((value) => value.toString(16).padStart(2, "0")).join("")
```

请使用密码管理器保存 `MASTER_KEY`。丢失该值后，D1 中已经加密的 CLICD Token、HashPay 私钥、卡密和实例凭据无法恢复。

首次管理员创建完成后，即使 `ADMIN_BOOTSTRAP_TOKEN` 仍存在，Bootstrap 接口也会因为用户表非空而返回 `409 already_initialized`。

如需进一步收紧权限，可在 Cloudflare Dashboard 的 Worker 设置中删除该 Secret；不要删除 `SECRET_KEY` 或 `MASTER_KEY`。

## 3. 自动创建的 Cloudflare 资源

Cloudflare 根据 `cloudflare/wrangler.jsonc` 自动创建并绑定：

| 资源 | 默认名称 | 作用 |
| --- | --- | --- |
| Worker | `vps-one` | 同时承载前端、API、Queue consumer 和 Cron |
| Worker Assets | `ASSETS` | 前端 SPA、主题和 noVNC 静态资源 |
| D1 | `vps-one` | 用户、钱包、订单、套餐、设置、任务和审计数据 |
| Queue | `vps-one-jobs` | CLICD 交付、邮件、支付和可重试后台任务 |
| Dead-letter Queue | `vps-one-dead` | 保存超过最大重试次数的任务 |
| Cron Trigger | `*/5 * * * *` | 每 5 分钟补投和维护任务 |

相关文件：

- `cloudflare/wrangler.jsonc`：一键部署资源定义。
- `cloudflare/package.json`：构建、migration 和部署命令，以及部署表单字段说明。
- `cloudflare/.dev.vars.example`：Deploy Button 收集的必需 Secret。
- `cloudflare/worker/migrations/`：D1 migration。
- `cloudflare/pages/assets-source/`：自包含静态依赖，确保 Cloudflare 只复制子目录时仍可构建。


## 4. 首次初始化

部署完成后直接访问 Worker URL。应用会调用 `/api/config` 检查用户表：

- 用户表为空时，只显示管理员初始化表单。
- 初始化前，普通注册接口返回 `503 not_initialized`，避免其他用户抢先注册导致管理员无法创建。
- Bootstrap 成功后创建首位管理员、钱包和登录 Session，并进入管理后台。
- 用户表非空后，Bootstrap 永久返回 `409 already_initialized`。

管理员密码要求 10 至 200 个字符，同时包含字母和数字。初始化也可以通过 API 完成：

```bash
curl -X POST 'https://你的域名/api/bootstrap' \
  -H 'Authorization: Bearer 你的_ADMIN_BOOTSTRAP_TOKEN' \
  -H 'Content-Type: application/json' \
  --data '{"email":"admin@example.com","password":"StrongPassword123"}'
```

健康检查：

```bash
curl https://你的域名/healthz
```

预期结果：

```json
{"status":"ok","runtime":"cloudflare-workers","environment":"production"}
```

## 5. 后台业务配置

管理员登录后进入 `Admin -> Settings`，依次配置：

### 5.1 网站地址

`site_url` 填写用户最终访问的 HTTPS 地址，例如：

```text
https://vps-one.example.com
```

该地址用于 HashPay 回调和支付完成后的返回链接。使用 `workers.dev` 时填写实际 Worker URL；绑定自定义域名后再改为自定义域名。

### 5.2 CLICD 如何填写

每行格式：

```text
节点标签|https://clicd.example.com|API_TOKEN
```

要求：

- CLICD 必须能从 Cloudflare 全球网络访问，支持 HTTP 和 HTTPS；HTTP 会明文传输 API Token，仅建议用于无法配置 TLS 的受控环境。
- 再次保存设置时 Token 留空会保留现值。
- 控制台对容器进行 WebVNC 需要 CLICD 提供公网 `wss://`，并支持 `binary` 与 `clicd-vnc-ticket.*` 子协议。

节点 URL 只能包含协议、主机、端口和可选路径；账号密码、查询串和片段会被拒绝。CLICD 请求完全由 Worker 在服务端发起，浏览器不会直接访问节点，因此前端不依赖 CLICD 的 CORS 配置。HTTP 节点的 WebVNC 也经 Worker 代理，页面不会产生混合内容请求。

### 5.3 HashPay

填写 HashPay 服务地址、Merchant ID 和商户 RSA 私钥。VPS-ONE 使用 RSA PKCS#1 v1.5 SHA-256 对下单请求签名，并使用 RSA-OAEP-256 + AES-GCM 解密回调。

回调地址：

```text
https://你的域名/api/payments/hashpay/callback
```

HashPay 服务必须能从 Cloudflare 网络访问该 HTTPS 地址。重复回调通过订单和流水约束保持幂等，不会重复入账。

### 5.5 Resend 邮件

Workers 不能直连传统 SMTP TCP 端口，本版本使用 Resend 兼容的 HTTP API。邮件用于卡密交付和退款确认码。

| 名称 | 类型 | 示例 |
| --- | --- | --- |
| `RESEND_API_TOKEN` | Secret | Resend API Token |
| `EMAIL_FROM` | Secret 或文本变量 | `VPS-ONE <noreply@example.com>` |

`EMAIL_FROM` 的域名必须已经在 Resend 验证。也可以在后台设置 `resend_from`；后台值优先于 `EMAIL_FROM`。保存设置后使用“邮件投递测试”发送真实测试邮件。Queue 重试使用稳定的 Resend `Idempotency-Key`，同一交付任务不会因网络重试产生重复邮件。

## 6. 自定义域名

本版本前端和 API 都由同一个 Worker 提供，不需要再创建 Pages 项目或配置 Pages Service Binding。

在 Cloudflare Dashboard 为 Worker 添加自定义域名，例如 `vps-one.example.com`。绑定完成后：

1. 打开新域名确认前端可访问。
2. 将后台 `site_url` 改为新域名。
3. 将 HashPay 回调改为 `https://vps-one.example.com/api/payments/hashpay/callback`。
4. 验证登录 Cookie、写操作 CSRF、HashPay 回调和 KVM WebVNC。

Worker 会自动允许当前请求 URL 的同源 `Origin`。只有单独的跨域前端才需要在 `wrangler.jsonc` 的 `ALLOWED_ORIGINS` 中配置逗号分隔的完整 Origin；值会规范化为 `scheme://host[:port]`，无效 URL、`null` 和 `*` 不会被接受。默认 `COOKIE_SAME_SITE=Lax` 适合单 Worker 部署；确需跨站前端时改为 `None`，并同时保留 HTTPS、精确 Origin 白名单和 CSRF Header。

## 7. 更新与自动部署

Deploy Button 会创建一个由部署者拥有的 GitHub 仓库并连接 Workers Builds。后续推送到生产分支会自动构建并部署。

## 8. 本地开发和验证

环境要求：Node.js 20+ 和 npm。

```bash
cd cloudflare
npm ci
```

复制本地 Secret：

```bash
cp .dev.vars.example .dev.vars
```

填写三个随机值、Resend API Token 和已验证发件地址后执行：

```bash
npm run build
npm run check
npm test
npm run db:migrate:local
npm run dev
```

默认访问 Wrangler 输出的本地地址，通常是 `http://localhost:8787`。前端、API 和本地 D1 都由同一 Wrangler 进程提供。

其他检查：

```bash
npm run deploy:dry
python tests/schema_check.py
```

`npm run deploy:dry` 不会发布到 Cloudflare，但会验证 Worker bundle、Assets 和 Wrangler 配置。`tests/schema_check.py` 检查 D1 schema 约束。

`npm run preview` 仍提供纯界面模拟预览，不连接 D1、HashPay 或 CLICD，仅用于 UI 验收。

## 9. 本地 Wrangler 手动部署

直接从本机部署时，需要执行：

```bash
npx wrangler login
npx wrangler whoami
```

手动部署前需要先创建 D1 和 Queues，并把 Wrangler 返回的 D1 `database_id` 写入本地 `wrangler.jsonc`：

```bash
npx wrangler d1 create vps-one
npx wrangler queues create vps-one-jobs
npx wrangler queues create vps-one-dead
```

写入部署 Secret：

```bash
npx wrangler secret put SECRET_KEY
npx wrangler secret put MASTER_KEY
npx wrangler secret put ADMIN_BOOTSTRAP_TOKEN
npx wrangler secret put RESEND_API_TOKEN
npx wrangler secret put EMAIL_FROM
```

然后部署：

```bash
npm run deploy
```

如使用 CI，可改用最小权限 Cloudflare API Token。不要使用 Global API Key。所需账号权限通常包括 Workers Scripts Edit、D1 Edit 和 Queues Edit；绑定自定义域名时还需要相应 Zone 的 Workers Routes/DNS 权限。

仓库中的 `cloudflare/deploy.ps1`、`worker/wrangler.toml` 和 `pages/wrangler.toml` 是旧双项目部署流程的兼容文件。新部署应以根级 `cloudflare/wrangler.jsonc` 为准。

## 10. 安全与数据说明

- D1 是独立数据库，一键部署不会导入 Python/FastAPI 版本的 SQLite 数据。
- 原版 Argon2 密码不能直接转换为 Workers 版本的密码记录，迁移用户时应安排重置密码并生成当前的随机盐 HMAC 记录。
- Session Token 仅以 SHA-256 哈希存入 D1；Cookie 使用 `HttpOnly; Secure; SameSite=Lax`。
- 非 GET 写操作要求 `X-CSRF-Token`。
- Workers Free 的 HTTP CPU 上限很低。新密码使用独立随机盐与 `SECRET_KEY` pepper 的 HMAC-SHA256，避免高迭代 PBKDF2 导致管理员初始化或登录超过 CPU 上限；早期 PBKDF2/HMAC 记录仍可验证。必须使用高熵 `SECRET_KEY`，数据库备份不得与该 Secret 存放在同一位置。
- CLICD Token、HashPay 私钥、卡密、实例凭据和 Queue 敏感载荷使用 AES-GCM 加密。
- 登录、注册、初始化和支付回调使用 D1 限流；生产环境仍建议启用 Cloudflare WAF Rate Limiting。
- 建议启用 Workers Logs、D1 备份/Time Travel 和 Dead-letter Queue 告警。
- 重点监控 `jobs.status='failed'`、HashPay 回调 4xx、CLICD 5xx、邮件 API 429 和 Queue backlog。

## 11. 故障排查

### 部署页面找不到 Wrangler 配置

确认按钮 URL 包含：

```text
/tree/main/cloudflare
```

Deploy Button 会把该子目录当作仓库根目录。若只填写整个仓库 URL，Cloudflare 会看到根目录的 Next.js/Python 项目，而不是独立 Worker 模板。

### 构建提示静态文件不存在

确认以下文件存在于部署仓库：

```text
pages/assets-source/app.css
pages/assets-source/themes.css
pages/assets-source/ui.js
pages/assets-source/vendor/novnc/core/rfb.js
```

一键部署不能读取 `cloudflare/` 之外的父目录，所以这些资源必须保留在子目录中。

### 页面返回 `bindings_missing`

检查 Worker 是否存在 `DB` binding，以及 `SECRET_KEY`、`MASTER_KEY` 是否作为 Secret 写入。名称区分大小写。

### D1 返回 `no such table`

检查部署命令是否为 `npm run deploy`，然后在 Workers Builds 重新部署。也可以在已授权的本地终端执行：

```bash
npx wrangler d1 migrations apply DB --remote
```

### 首次注册返回 `not_initialized`

这是预期保护。访问网站首页，使用 `ADMIN_BOOTSTRAP_TOKEN` 创建首位管理员后再开放普通注册。

### 初始化返回 `invalid_bootstrap_token`

输入值必须与 Worker Secret `ADMIN_BOOTSTRAP_TOKEN` 完全一致。修改 Secret 后等待新版本部署完成，再重试。

### 初始化返回 `already_initialized`

D1 中已经存在用户。请使用现有管理员账号登录；不要删除用户表来重复初始化。

### 邮件任务重复失败

检查 `RESEND_API_TOKEN`、已验证的发件域名、`EMAIL_FROM` 和 Resend 配额，并在后台执行“邮件投递测试”。修复后由 Queue/Cron 重试，或在后台触发相应重试操作。

### 订单一直显示“详情同步中”

在管理后台总览查看对应 `provision` Job 的 `error`。错误会列出仍缺少的字段，例如 `ipv4`、`ssh_password` 或 `management_access_code`。确认 CLICD `/api/v1/containers/:id` 和 `/api/v1/sub-user/create` 返回完整契约；不要手工把订单改为 `fulfilled`，否则会绕过交付完整性保护。

### CLICD 或 HashPay 请求失败

确认上游是公网 HTTP/HTTPS 地址、没有只允许固定源 IP，并可从 Cloudflare 网络访问。HashPay 生产环境仍应使用 HTTPS；CLICD 可按需使用 HTTP。

### 跨域请求返回 `origin_not_allowed`

同一 Worker 域名无需配置。若前端部署在其他 Origin，把完整 Origin 加入 `ALLOWED_ORIGINS`，多个值用逗号分隔；本实现不会接受 `*`。跨站 Cookie 还需要 `COOKIE_SAME_SITE=None`，同站不同子域通常保留 `Lax` 即可。

## 12. 回滚和备份

1. 在 Worker 的 Deployments 页面选择上一成功版本并回滚代码。
2. D1 migration 只向前，不要通过代码回滚删除新列或新表。
3. 数据异常时先暂停支付入口和 Queue consumer，再从 D1 备份恢复。
4. 回滚后验证 `/healthz`、管理员登录、钱包余额、订单状态、CLICD 查询和 Queue backlog。
5. 备份 D1 的同时，必须安全备份当前 `MASTER_KEY`；只有数据库而没有密钥无法恢复加密字段。

## 13. 重要法律法规声明
重要声明：本源码仅开源研究使用，如作为商业用途产生任何后果(正常灾难或商业犯罪行为及其他纠纷问题)，本作者不承担任何相关法律责任，源码您可以自由二次开发，你不必告知他人为师的山门，谢谢理解！


