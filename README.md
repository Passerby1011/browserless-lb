# Browserless Key Balancer

一个小型 Browserless API Key 负载均衡代理。它不创建浏览器，只负责把请求轮询转发到 Browserless，并在临时失败时自动重试。

## 工作方式

- `BROWSERLESS_KEYS` 使用逗号或换行分隔多个 Browserless Key。
- `PROXY_AUTH_TOKEN` 是客户端访问本代理所需的 Token，不是 Browserless Key。
- 每次请求按轮询顺序选择一个可用 Key。
- 网络错误、超时以及 `408/425/429/500/502/503/504` 会触发重试。
- 失败 Key 进入 `COOLDOWN_SECONDS` 冷却时间，冷却结束后重新参与轮询。
- 客户端必须传入正确的查询参数 `token`，代理验证通过后才会注入实际 Browserless Key。

`MAX_RETRIES` 表示首次失败之后的重试次数，总尝试次数为 `MAX_RETRIES + 1`。

## 配置

创建 `.env`，至少设置以下变量：

```dotenv
BROWSERLESS_URL=https://production-sfo.browserless.io
PROXY_AUTH_TOKEN=replace_with_a_long_random_token
BROWSERLESS_KEYS=your_key_1,your_key_2,your_key_3
MAX_RETRIES=2
COOLDOWN_SECONDS=30
```

可选变量：

```dotenv
PORT=3000
UPSTREAM_TIMEOUT_SECONDS=120
MAX_REQUEST_BODY_MB=32
```

不要把真实 Key 提交到 Git；可参考 `.env.example`。

## Docker 部署

```bash
docker compose up -d --build
```

服务监听 `3000` 端口。Browserless REST 请求示例：

```bash
curl -X POST "http://localhost:3000/scrape?token=YOUR_PROXY_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","elements":[{"selector":"h1"}]}'
```

常用路径：

```text
/content        返回渲染后的 HTML
/scrape         使用 CSS Selector 提取结构化 JSON
/smart-scrape   自动选择抓取策略
/screenshot     截图
/pdf            生成 PDF
/function       执行 Browserless Function
```

健康检查：

```text
GET http://localhost:3000/healthz?token=YOUR_PROXY_AUTH_TOKEN
```

## Vercel 部署

项目已包含 `api/proxy.js` 和 `vercel.json`，可直接把 `browserless-lb` 作为 Vercel 项目根目录。

在 Vercel Project Settings 的 Environment Variables 中设置：

```text
BROWSERLESS_URL
PROXY_AUTH_TOKEN
BROWSERLESS_KEYS
MAX_RETRIES
COOLDOWN_SECONDS
UPSTREAM_TIMEOUT_SECONDS
MAX_REQUEST_BODY_MB
```

Vercel 部署后可直接沿用 Browserless 原始路径；`/api` 前缀也兼容：

```text
https://your-project.vercel.app/content?token=YOUR_PROXY_AUTH_TOKEN
https://your-project.vercel.app/scrape?token=YOUR_PROXY_AUTH_TOKEN
https://your-project.vercel.app/smart-scrape?token=YOUR_PROXY_AUTH_TOKEN
```

Vercel 函数默认最大执行时间配置为 60 秒。建议在 Vercel 中将 `UPSTREAM_TIMEOUT_SECONDS` 设置为 `50` 或更低。

### Vercel 限制

- Vercel Functions 只适合 Browserless 的 HTTP REST API，例如 `POST /content`、`POST /scrape`、`POST /smart-scrape`。
- Vercel 不支持长期 WebSocket `upgrade`；`/chrome`、`/chrome/playwright` 等 CDP WebSocket 请求，以及依赖 Browserless 浏览器会话的客户端，必须使用 Docker 部署。
- `GET /content` 不是 Browserless REST API。`/content` 必须使用 `POST` 并传递 JSON 请求体，例如 `{ "url": "https://example.com" }`。
- Key 轮询状态保存在函数实例内存中。Vercel 冷启动或多实例扩容后，不能保证全局严格轮询，但每个实例会正常执行冷却和重试。
- Vercel 入口要求 `?token=PROXY_AUTH_TOKEN`。请使用足够长的随机值，并通过 HTTPS 调用，避免 Token 泄露。

## GitHub Actions / GHCR

`.github/workflows/docker.yml` 会自动构建 Docker 镜像：

- Pull Request：只构建，不推送。
- 推送到 `main` 或 `master`：推送 `latest`、分支标签和提交 SHA 标签。
- 推送版本标签（例如 `v1.0.0`）：推送对应版本标签和提交 SHA 标签。

镜像发布到：

```text
ghcr.io/你的 GitHub 用户名/你的仓库名:latest
```

拉取并运行：

```bash
docker pull ghcr.io/OWNER/REPOSITORY:latest
docker run -d \
  --name browserless-key-balancer \
  --env-file .env \
  -p 3000:3000 \
  ghcr.io/OWNER/REPOSITORY:latest
```

工作流使用 GitHub Actions 自带的 `GITHUB_TOKEN` 登录 GHCR，不需要配置 Docker Hub 密码。首次发布后，可在仓库的 **Packages** 页面调整镜像的公开或私有状态。

## 本地测试

```bash
npm test
```

运行时依赖只有 Node.js 内置模块，无需安装额外 npm 包。

本地直接启动 Docker 版本：

```bash
npm run start:local
```
