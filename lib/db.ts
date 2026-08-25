import mysql, { type Pool, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import { hash } from 'bcryptjs';

let pool: Pool | null = null;
let initialized: Promise<void> | null = null;

const categories = {
  专业素养: [
    '请介绍一段你参与过的科研经历，并说明你承担的具体工作。',
    '请谈谈你最感兴趣的研究方向，以及你对该方向的理解。',
    '如果实验结果与预期完全相反，你会如何分析和处理？',
  ],
  英语能力: [
    'Please introduce yourself and explain why you are applying for this program.',
    'What is your greatest academic achievement, and what did you learn from it?',
    'Please describe your research interests in English.',
  ],
  综合面试: [
    '为什么选择保研，而不是直接就业或出国深造？',
    '请谈谈你的一次失败经历，以及它带给你的改变。',
    '你认为人工智能会如何改变你所学的专业？',
  ],
} as const;

const schema = [
  `CREATE TABLE IF NOT EXISTS users (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(30) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    display_name VARCHAR(80) NOT NULL,
    role ENUM('admin', 'student') NOT NULL DEFAULT 'student',
    status ENUM('pending', 'active', 'rejected', 'deleted') NOT NULL DEFAULT 'active',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash CHAR(64) NOT NULL PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_sessions_expires (expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS questions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    category VARCHAR(30) NOT NULL,
    content TEXT NOT NULL,
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_questions_category_enabled (category, enabled)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS user_settings (
    user_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    auto_record TINYINT(1) NOT NULL DEFAULT 1,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_settings_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS practice_records (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,
    question_id BIGINT UNSIGNED NULL,
    category VARCHAR(30) NOT NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    audio_data LONGBLOB NULL,
    audio_mime VARCHAR(100) NULL,
    audio_size INT UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_records_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_records_question FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE SET NULL,
    INDEX idx_records_user_created (user_id, created_at),
    INDEX idx_records_user_category (user_id, category)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

async function initializeDatabase(db: Pool) {
  for (const statement of schema) await db.query(statement);
  await db.query("ALTER TABLE users MODIFY COLUMN status ENUM('pending', 'active', 'rejected', 'deleted') NOT NULL DEFAULT 'active'");

  const [userRows] = await db.query<RowDataPacket[]>('SELECT COUNT(*) AS count FROM users');
  if (Number(userRows[0].count) === 0) {
    const adminPassword = await hash('admin123', 12);
    const userPassword = await hash('user123', 12);
    await db.query('INSERT INTO users (username, password_hash, display_name, role, status) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)', [
      'admin', adminPassword, '管理员', 'admin', 'active',
      'user', userPassword, '示例学员', 'student', 'active',
    ]);
  }

  const [questionRows] = await db.query<RowDataPacket[]>('SELECT COUNT(*) AS count FROM questions');
  if (Number(questionRows[0].count) === 0) {
    for (const [category, questions] of Object.entries(categories)) {
      for (const content of questions) await db.query('INSERT INTO questions (category, content) VALUES (?, ?)', [category, content]);
    }
  }

  await db.query('INSERT IGNORE INTO user_settings (user_id) SELECT id FROM users');
}

export async function getDb() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.MYSQL_HOST || '127.0.0.1',
      port: Number(process.env.MYSQL_PORT || 33060),
      database: process.env.MYSQL_DATABASE || 'baoyanxunlian',
      user: process.env.MYSQL_USER || 'baoyan_app',
      password: process.env.MYSQL_PASSWORD || '',
      waitForConnections: true,
      connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT || 10),
      charset: 'utf8mb4',
      timezone: '+08:00',
    });
  }
  initialized ??= initializeDatabase(pool);
  await initialized;
  return pool;
}

export async function query<T extends RowDataPacket[] = RowDataPacket[]>(sql: string, params: unknown[] = []) {
  const db = await getDb();
  const [rows] = await db.query<T>(sql, params);
  return rows;
}

export async function execute(sql: string, params: Array<string | number | boolean | null | Buffer | Date> = []) {
  const db = await getDb();
  const [result] = await db.execute<ResultSetHeader>(sql, params);
  return result;
}
