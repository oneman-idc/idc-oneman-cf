# VPS-ONE Cloudflare

该目录是可独立部署到 Cloudflare Workers 的 VPS-ONE 适配版本。原 Python/FastAPI/Docker 版本保持不变。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Foneman-idc%2Fidc-oneman-cf%2Ftree%2Fmain%2Fcloudflare)

- `wrangler.jsonc`：一键部署入口，声明 Worker Assets、D1、Queues、Cron 和可观测性。
- `worker/`：API、D1 migration、Queue/Cron、CLICD、HashPay、邮件和 WebVNC。
- `pages/`：静态 SPA、三套界面主题与自包含的 noVNC 资源。
- `scripts/`：静态资源构建与语法检查。
- `.dev.vars.example`：Deploy Button 需要收集的三个安全密钥、Resend API Token 和已验证发件地址。

Cloudflare 会自动创建 D1 和 Queues，`npm run deploy` 会先构建前端、应用全部 D1 migration，再发布 Worker。部署完成后打开 Worker URL，使用部署时填写的 `ADMIN_BOOTSTRAP_TOKEN` 创建首位管理员。

完整步骤见仓库根目录的 `CLOUDFLARE_DEPLOYMENT.md`。
