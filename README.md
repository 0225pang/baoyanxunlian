# 研路｜保研面试训练系统

面向小规模保研辅导的全栈系统。用户、题库、设置、作答记录和录音均存入 MySQL，应用容器本身不保存业务数据。

## 功能

- 管理员与普通用户登录，管理员可创建用户
- 学员可以提交注册申请，管理员审核通过后方可登录
- 三类题库随机抽题与 3 秒准备倒计时
- 可在个人设置中配置倒计时结束后自动录音
- 作答记录持久化，支持类别筛选、关键词搜索和录音回放
- MySQL 初始化只在对应表不存在或表为空时写入默认数据，已有内容不会覆盖
- Docker Compose + Caddy HTTP 反向代理（无域名时使用服务器 IP:18080）

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
