import mysql, { type Pool, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import { hash } from 'bcryptjs';

let pool: Pool | null = null;
let initialized: Promise<void> | null = null;

const questionTypes = [
  { code: 'professional', name: '专业问题', description: '食品专业笔试、面试和专业课问题', sortOrder: 1 },
  { code: 'english', name: '英语问答问题', description: '英语口语、英文自我介绍和专业英语问答', sortOrder: 2 },
  { code: 'comprehensive', name: '综合面试问题', description: '综合素质、科研规划和压力面试问题', sortOrder: 3 },
] as const;

const mockQuestions = [
  { code: 'professional', content: '请解释食品褐变反应的主要类型，并分别举例说明。', answer: '食品褐变主要包括酶促褐变和非酶促褐变。前者常见于切开的果蔬，后者包括美拉德反应和焦糖化反应。', subcategory: '食品化学' },
  { code: 'professional', content: '如果食品实验结果与预期完全相反，你会如何分析和处理？', answer: '应先复核实验设计、样品与试剂，再检查仪器和操作记录，通过平行实验和对照实验定位原因，最后如实记录异常并调整方案。', subcategory: '实验设计' },
  { code: 'english', content: 'Please introduce yourself and explain why you are applying for this program.', answer: 'A complete answer can include your academic background, relevant experience, research interests, and the reason this program matches your goals.', subcategory: '英语自我介绍' },
  { code: 'english', content: 'Please describe your research interests in English.', answer: 'You can introduce the research topic, explain why it interests you, and briefly describe the methods or questions you would like to explore.', subcategory: '专业英语' },
  { code: 'comprehensive', content: '为什么选择保研，而不是直接就业或出国深造？', answer: null, subcategory: '报考动机' },
  { code: 'comprehensive', content: '请谈谈你的一次失败经历，以及它带给你的改变。', answer: null, subcategory: '个人经历' },
] as const;

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
  `CREATE TABLE IF NOT EXISTS question_types (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    description VARCHAR(500) NULL,
    settings JSON NULL,
    sort_order INT NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS questions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    type_id INT UNSIGNED NULL,
    content LONGTEXT NOT NULL,
    answer LONGTEXT NULL,
    subcategory VARCHAR(100) NULL,
    extra JSON NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_questions_type_status (type_id, status)
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
    INDEX idx_records_user_created (user_id, created_at),
    INDEX idx_records_user_category (user_id, category)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

async function hasColumn(db: Pool, table: string, column: string) {
  const [rows] = await db.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS count FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?',
    [table, column],
  );
  return Number(rows[0].count) > 0;
}

async function hasIndex(db: Pool, table: string, index: string) {
  const [rows] = await db.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS count FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?',
    [table, index],
  );
  return Number(rows[0].count) > 0;
}

async function ensureQuestionColumns(db: Pool) {
  // Remove the legacy index before dropping category/enabled during migration.
  if (await hasIndex(db, 'questions', 'idx_questions_category_enabled')) {
    await db.query('ALTER TABLE questions DROP INDEX idx_questions_category_enabled');
  }
  const columns: Array<[string, string]> = [
    ['type_id', 'INT UNSIGNED NULL'],
    ['answer', 'LONGTEXT NULL'],
    ['subcategory', 'VARCHAR(100) NULL'],
    ['extra', 'JSON NULL'],
    ['status', "VARCHAR(20) NOT NULL DEFAULT 'active'"],
    ['updated_at', 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'],
  ];
  for (const [name, definition] of columns) {
    if (!(await hasColumn(db, 'questions', name))) await db.query(`ALTER TABLE questions ADD COLUMN ${name} ${definition}`);
  }
  if (!(await hasIndex(db, 'questions', 'idx_questions_type_status'))) await db.query('ALTER TABLE questions ADD INDEX idx_questions_type_status (type_id, status)');
}

async function migrateLegacyQuestions(db: Pool) {
  if (await hasColumn(db, 'questions', 'category')) {
    await db.query(`UPDATE questions q JOIN question_types t ON t.code = CASE
      WHEN q.category IN ('专业素养', '专业问题') THEN 'professional'
      WHEN q.category IN ('英语能力', '英语问答问题') THEN 'english'
      WHEN q.category = '综合面试' THEN 'comprehensive'
      ELSE 'professional' END
      SET q.type_id = t.id WHERE q.type_id IS NULL`);
  }
  await db.query("UPDATE questions SET type_id = (SELECT id FROM question_types WHERE code = 'professional') WHERE type_id IS NULL");
  if (await hasColumn(db, 'questions', 'enabled')) await db.query("UPDATE questions SET status = CASE WHEN enabled = 1 THEN 'active' ELSE 'archived' END");
  // The current table uses type_id/status; remove legacy category/enabled once migrated.
  if (await hasColumn(db, 'questions', 'category')) await db.query("ALTER TABLE questions DROP COLUMN category");
  if (await hasColumn(db, 'questions', 'enabled')) await db.query("ALTER TABLE questions DROP COLUMN enabled");
}
async function initializeDatabase(db: Pool) {
  for (const statement of schema) await db.query(statement);
  await db.query("ALTER TABLE users MODIFY COLUMN status ENUM('pending', 'active', 'rejected', 'deleted') NOT NULL DEFAULT 'active'");
  await ensureQuestionColumns(db);

  // Seed mock questions only for a completely empty question bank. Existing
  // question types or questions are preserved and never receive extra rows.
  const [existingTypeRows] = await db.query<RowDataPacket[]>('SELECT COUNT(*) AS count FROM question_types');
  const [existingQuestionRows] = await db.query<RowDataPacket[]>('SELECT COUNT(*) AS count FROM questions');
  const seedQuestionBank = Number(existingTypeRows[0].count) === 0 && Number(existingQuestionRows[0].count) === 0;

  const [userRows] = await db.query<RowDataPacket[]>('SELECT COUNT(*) AS count FROM users');
  if (Number(userRows[0].count) === 0) {
    const adminPassword = await hash('admin123', 12);
    const userPassword = await hash('user123', 12);
    await db.query('INSERT INTO users (username, password_hash, display_name, role, status) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)', [
      'admin', adminPassword, '管理员', 'admin', 'active',
      'user', userPassword, '示例学员', 'student', 'active',
    ]);
  }

  // Type definitions are initialized only for an empty type table.
  // Existing names/descriptions remain managed by the database.
  if (Number(existingTypeRows[0].count) === 0) {
    for (const type of questionTypes) {
      await db.query(
        'INSERT INTO question_types (code, name, description, settings, sort_order, is_active) VALUES (?, ?, ?, ?, ?, 1)',
        [type.code, type.name, type.description, JSON.stringify({ countdownSeconds: 3, autoRecord: true, answerReveal: 'after_recording' }), type.sortOrder],
      );
    }
  }
  await migrateLegacyQuestions(db);

  if (seedQuestionBank) {
    for (const mock of mockQuestions) {
      const [typeRows] = await db.query<RowDataPacket[]>('SELECT id FROM question_types WHERE code = ? LIMIT 1', [mock.code]);
      await db.query('INSERT INTO questions (type_id, content, answer, subcategory, extra, status) VALUES (?, ?, ?, ?, ?, ?)', [
        typeRows[0].id, mock.content, mock.answer, mock.subcategory, JSON.stringify({ source: '系统 mock 数据' }), 'active',
      ]);
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
