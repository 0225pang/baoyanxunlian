# 研路｜保研面试训练系统

面向小规模保研辅导的全栈系统。用户、题库、设置、作答记录和录音均存入 MySQL，应用容器本身不保存业务数据。

## 功能

- 管理员与普通用户登录，管理员可创建用户
- 学员可以提交注册申请，管理员审核通过后方可登录
- 三类题库随机抽题与 3 秒准备倒计时
- 可在个人设置中配置倒计时结束后自动录音，倒计时和录音开始带提示音
- 作答记录持久化，支持类别筛选、关键词搜索和录音回放
- MySQL 初始化只在对应表不存在或表为空时写入默认数据，已有内容不会覆盖
- Docker Compose + Caddy HTTP 反向代理（无域名时使用服务器 IP:18080）
- 作答详情支持调用阿里云百炼 Paraformer-v1 异步生成带时间戳的录音文字稿
- 独立 AI 复盘页：使用最近最多 3 次回答生成评估，并支持围绕同一学员、同一道题持续对话
- 管理后台统一管理用户、题库和 AI 模型配置

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

删除用户只能由管理员在“用户管理”中执行；删除会同时删除该用户的设置、作答记录和录音。

## 阿里云部署

1. 使用 `http://服务器公网IP:18080` 访问网站（当前为 HTTP）。
2. 安全组开放 22、18080 端口，不开放 3306。
3. 安装 Docker 和 Docker Compose。
4. 复制 `.env.example` 为 `.env`，填写 MySQL 凭据。当前使用 IP + HTTP，`COOKIE_SECURE` 保持为 `false`。服务器上的应用容器不要填写本地 `33060`；应使用数据库所在服务器的内网地址和 3306，或配置 Docker 到宿主机 MySQL 的内部网络连接。
5. 启动：

```bash
docker compose -p baoyanxunlian up -d --build --force-recreate
```

以后更新代码：

```bash
git pull
docker compose -p baoyanxunlian up -d --build --force-recreate
```

数据库和录音都在 MySQL 中，重新构建容器不会丢失数据。生产环境建议使用 `mysqldump` 或阿里云 RDS/云数据库备份策略定期备份 `baoyanxunlian`。
