import mysql from 'mysql2/promise';
import { hash } from 'bcryptjs';
import fs from 'node:fs';

const fileEnv = fs.existsSync('.env')
  ? Object.fromEntries(fs.readFileSync('.env', 'utf8').split(/\r?\n/).filter((line) => line && !line.startsWith('#')).map((line) => {
      const index = line.indexOf('=');
      return index > 0 ? [line.slice(0, index).trim(), line.slice(index + 1).trim()] : [line, ''];
    }))
  : {};
const env = { ...fileEnv, ...process.env };

const [username, password] = process.argv.slice(2);
if (!username || !password || password.length < 8) {
  console.error('用法：npm run reset-password -- <用户名> <新密码>（密码至少 8 位）');
  process.exit(1);
}

const db = await mysql.createConnection({
  host: env.MYSQL_HOST || '127.0.0.1',
  port: Number(env.MYSQL_PORT || 33060),
  database: env.MYSQL_DATABASE || 'baoyanxunlian',
  user: env.MYSQL_USER || 'baoyan_app',
  password: env.MYSQL_PASSWORD || '',
  charset: 'utf8mb4',
});
const [result] = await db.execute('UPDATE users SET password_hash = ?, status = \'active\' WHERE username = ?', [await hash(password, 12), username]);
if (!result.affectedRows) {
  console.error(`未找到用户：${username}`);
  process.exitCode = 1;
} else {
  console.log(`已重置用户 ${username} 的密码（数据库中只保存 bcrypt 哈希）`);
}
await db.end();
