# 研路｜保研面试训练系统

面向小规模保研辅导的全栈系统。用户、题库、设置、作答记录和录音均存入 MySQL，应用容器本身不保存业务数据。

## 功能

- 管理员与普通用户登录，管理员可创建用户
- 学员可以提交注册申请，管理员审核通过后方可登录
- 三类题库随机抽题与 3 秒准备倒计时
- 可在个人设置中配置倒计时结束后自动录音，倒计时和录音开始带提示音
- 作答记录持久化，支持类别筛选、关键词搜索和录音回放
- MySQL 初始化只在对应表不存在或表为空时写入默认数据，已有内容不会覆盖
- Docker Compose + Caddy 反向代理（保留服务器 IP:18080 的 HTTP 入口；配置域名后自动提供 HTTPS）
- 作答详情支持调用阿里云百炼 Paraformer-v1 异步生成带时间戳的录音文字稿
- 独立 AI 复盘页：使用最近最多 3 次回答生成评估，并支持围绕同一学员、同一道题持续对话；模型返回的 Markdown 会在页面中格式化展示
- 管理后台统一管理用户、题库、模型配置和提示词；模型平台、模型名称、接口地址和 API Key 均可保存为多个配置并切换
- 管理员可开启录音后的全自动转写；开启时学员端隐藏手动转写按钮，关闭时可在复盘页手动触发

## 初始账号

- 管理员：`admin` / `admin123`
- 普通用户：`user` / `user123`

以上账号密码由系统首次初始化时固定创建，不依赖 `.env`。正式使用后，建议通过后续的密码修改功能或数据库管理流程更换默认密码。

## 本地开发

本地运行时不要直接连接公网 MySQL 端口。先在一个终端建立 SSH 隧道（保持该终端运行）：

```bash
ssh -N -L 33060:127.0.0.1:3306 root@你的云服务器公网IP
```

隧道含义是：本机 `127.0.0.1:33060` 转发到云服务器本机的 `127.0.0.1:3306`。然后再启动应用：

```bash
cp .env.example .env
npm install
npm run dev
```

`.env` 默认使用以下隧道连接：

- 主机：`127.0.0.1`
- 端口：`33060`
- 数据库：`baoyanxunlian`

录音转写配置（可选）：

DASHSCOPE_API_KEY=你的百炼 API Key
DASHSCOPE_ASR_MODEL=paraformer-v1
DASHSCOPE_ASR_URL=https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription
ASR_PUBLIC_BASE_URL=http://你的服务器公网IP:18080
ASR_AUDIO_TOKEN_SECRET=建议填写一段随机字符串

百炼录音文件识别需要读取公网音频 URL，因此 ASR_PUBLIC_BASE_URL 必须是百炼可以访问的地址。应用会生成 1 小时有效的签名音频 URL，不会公开整个录音接口。API Key 使用 Bearer 认证，修改服务器 .env 后需要重新创建容器：

~~~bash
docker compose -p baoyanxunlian up -d --build --force-recreate
~~~

未配置 API Key 或公网地址时，录音仍可正常保存，但生成文字稿会提示配置错误。

AI 评估配置：

管理员登录后进入“管理后台 → AI 模型管理”，填写 API 平台、兼容 OpenAI Chat Completions 的接口地址、模型名称、API Key 和评估系统提示词。系统默认使用阿里云百炼兼容接口和 `qwen3.8-27b`，API Key 只在服务端使用，前端只显示脱敏结果。评估按“用户 + 题目 + 最近三次回答内容”去重，没有新回答时不会重复调用模型。

MySQL 用户名和密码只放在 `.env`，不会写入代码或 README。请使用数据库专用账号，不要使用 `root`；密码字段使用 bcrypt 哈希，不保存应用用户的明文密码。

如果本机 `33060` 已被占用，可以把 SSH 命令中的本地端口换成其他端口，并同步修改 `.env` 的 `MYSQL_PORT`。

## 忘记密码

不提供找回密码页面。管理员在服务器上执行以下命令即可重置任意账号，命令行中的新密码只用于生成哈希，不会写入数据库：

```bash
npm run reset-password -- admin 新密码
npm run reset-password -- user 新密码
```

删除用户只能由管理员在“用户管理”中执行；删除时默认保留作答记录和录音，也可以在确认操作中勾选一并删除。

## 阿里云部署

1. 保留 `http://服务器公网IP:18080` 作为 HTTP 临时入口。
2. 若已为 `baoyan.xiaodaidai.tech` 添加 A 记录，在 `.env` 设置 `SITE_DOMAIN=baoyan.xiaodaidai.tech`，并填写具备 `AliyunDNSFullAccess` 权限的 `ALIYUN_DNS_ACCESS_KEY_ID`、`ALIYUN_DNS_ACCESS_KEY_SECRET`。主 Caddy 使用 AliDNS 的 DNS-01 验证自动申请和续期 Let's Encrypt HTTPS 证书，不依赖公网 80/443 的验证回调，使用 `https://baoyan.xiaodaidai.tech` 访问。
   - IP:18080 入口由独立的 `caddy-ip` 容器提供，不会参与域名证书申请，也不会受 DNS-01 改动影响。
3. 同时使用 HTTP IP 入口和 HTTPS 域名时，`COOKIE_SECURE` 保持为 `false`，以免 HTTP 登录 Cookie 无法回传；正式仅保留 HTTPS 时可改为 `true`。
4. 安全组开放 22、18080、80、443 端口，不开放 3306。
5. 安装 Docker 和 Docker Compose。
6. 复制 `.env.example` 为 `.env`，填写 MySQL 凭据。服务器上的应用容器不要填写本地 `33060`；应使用数据库所在服务器的内网地址和 3306，或配置 Docker 到宿主机 MySQL 的内部网络连接。
7. 启动：

```bash
docker compose -p baoyanxunlian up -d --build --force-recreate
```

以后更新代码：

```bash
git pull
docker compose -p baoyanxunlian up -d --build --force-recreate
```

数据库和录音都在 MySQL 中，重新构建容器不会丢失数据。生产环境建议使用 `mysqldump` 或阿里云 RDS/云数据库备份策略定期备份 `baoyanxunlian`。

## 运行日志与 I/O 追查

Caddy 会把访问审计日志持久化到 Docker 命名卷中，记录请求路径、状态码、耗时、响应大小和客户端地址；不记录请求或响应正文，也会自动跳过通知铃铛的轮询接口 `/api/notifications`。日志滚动保存，避免单个文件无限增长。

在应用服务器的项目目录执行以下命令：

```bash
# HTTPS 域名入口：查看最近 300 条访问记录
docker compose -p baoyanxunlian exec caddy sh -lc 'tail -n 300 /var/log/caddy/https-access.json'

# IP / HTTP 入口：查看最近 300 条访问记录
docker compose -p baoyanxunlian exec caddy-ip sh -lc 'tail -n 300 /var/log/caddy/http-ip-access.json'

# 筛选指定时间段，例如 2026-08-30 23:18 至 23:25
docker compose -p baoyanxunlian exec caddy-ip sh -lc "grep '2026-08-30T23:1[89]\|2026-08-30T23:2[0-5]' /var/log/caddy/http-ip-access.json"

# 找出最近日志中的慢请求（耗时至少 2 秒）和大响应（至少 1 MiB）；Caddy 镜像无需额外安装 jq
docker compose -p baoyanxunlian exec caddy-ip sh -lc "tail -n 5000 /var/log/caddy/http-ip-access.json | grep -E '\"duration\":([2-9]|[1-9][0-9]+)|\"size\":[1-9][0-9]{6,}'"

# 查看应用容器的最近错误与超时
docker compose -p baoyanxunlian logs --since 30m --tail 500 app

# 查看应用持久化的慢 SQL / SQL 失败记录（默认仅记录 >= 1000ms 的查询及所有失败）
docker compose -p baoyanxunlian exec app sh -lc 'tail -n 300 /app/data/app-logs/mysql-slow-$(date -u +%F).jsonl'
```

访问审计可以把 I/O 异常关联到具体 HTTP 路由、客户端、响应体积和耗时；应用还会持久记录慢 SQL 的语句模板、耗时、返回行数/影响行数与失败原因（不记录参数值）。默认阈值为 1000ms，可用 `DB_SLOW_QUERY_MS` 调整。若仍需 MySQL 服务端级别的交叉验证，可启用低开销慢查询日志；不要开启 `general_log`，它会产生大量额外 I/O。
