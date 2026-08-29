import mysql, { type Pool, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import { hash } from 'bcryptjs';

let pool: Pool | null = null;
let initialized: Promise<void> | null = null;

const questionTypes = [
  { code: 'professional', name: '专业问题', description: '食品专业笔试、面试和专业课问题', sortOrder: 1 },
  { code: 'english', name: '英语问答问题', description: '英语口语、英文自我介绍和专业英语问答', sortOrder: 2 },
  { code: 'comprehensive', name: '综合面试问题', description: '综合素质、科研规划和压力面试问题', sortOrder: 3 },
  { code: 'literature_translation', name: '文献英语翻译', description: '食品专业英文文献、术语与段落翻译训练', sortOrder: 4 },
  { code: 'ideology', name: '思政问题', description: '思想政治理论与时事政策类面试问题', sortOrder: 5 },
] as const;

const mockQuestions = [
  { code: 'professional', content: '请解释食品褐变反应的主要类型，并分别举例说明。', answer: '食品褐变主要包括酶促褐变和非酶促褐变。前者常见于切开的果蔬，后者包括美拉德反应和焦糖化反应。', subcategory: '食品化学' },
  { code: 'professional', content: '如果食品实验结果与预期完全相反，你会如何分析和处理？', answer: '应先复核实验设计、样品与试剂，再检查仪器和操作记录，通过平行实验和对照实验定位原因，最后如实记录异常并调整方案。', subcategory: '实验设计' },
  { code: 'english', content: 'Please introduce yourself and explain why you are applying for this program.', answer: 'A complete answer can include your academic background, relevant experience, research interests, and the reason this program matches your goals.', subcategory: '英语自我介绍' },
  { code: 'english', content: 'Please describe your research interests in English.', answer: 'You can introduce the research topic, explain why it interests you, and briefly describe the methods or questions you would like to explore.', subcategory: '专业英语' },
  { code: 'comprehensive', content: '为什么选择保研，而不是直接就业或出国深造？', answer: null, subcategory: '报考动机' },
  { code: 'comprehensive', content: '请谈谈你的一次失败经历，以及它带给你的改变。', answer: null, subcategory: '个人经历' },
  { code: 'literature_translation', content: '请翻译：The Maillard reaction is a complex series of chemical reactions between reducing sugars and amino compounds, which contributes to the color and flavor development of many foods during thermal processing.', answer: '美拉德反应是还原糖与氨基化合物之间发生的一系列复杂化学反应。在热加工过程中，该反应会促进许多食品颜色和风味的形成。', subcategory: '食品化学文献' },
  { code: 'ideology', content: '请结合食品专业背景，谈谈你如何理解“把论文写在祖国大地上”。', answer: '可从国家粮食安全、食品安全、健康中国等需求切入，说明科研选题应面向真实产业和民生问题，并结合自身学习或科研经历，提出未来能够落地的行动。', subcategory: '专业与国家需求' },
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
    avoid_repeated TINYINT(1) NOT NULL DEFAULT 0,
    read_question TINYINT(1) NOT NULL DEFAULT 1,
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
    transcript LONGTEXT NULL,
    transcript_segments JSON NULL,
    transcript_status VARCHAR(20) NOT NULL DEFAULT 'none',
    transcript_error TEXT NULL,
    transcript_started_at DATETIME NULL,
    transcribed_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_records_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_records_user_created (user_id, created_at),
    INDEX idx_records_user_category (user_id, category)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS ai_settings (
    id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
    provider VARCHAR(50) NOT NULL DEFAULT 'bailian',
    base_url VARCHAR(500) NOT NULL DEFAULT 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model VARCHAR(150) NOT NULL DEFAULT 'qwen3.8-27b',
    api_key TEXT NULL,
    system_prompt LONGTEXT NOT NULL,
    active_config_id BIGINT UNSIGNED NULL,
    active_prompt_id BIGINT UNSIGNED NULL,
    auto_transcribe TINYINT(1) NOT NULL DEFAULT 0,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS app_migrations (
    name VARCHAR(120) NOT NULL PRIMARY KEY,
    applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS asr_settings (
    id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
    provider VARCHAR(50) NOT NULL DEFAULT 'bailian',
    submit_url VARCHAR(500) NOT NULL,
    task_url VARCHAR(500) NOT NULL,
    model VARCHAR(150) NOT NULL DEFAULT 'paraformer-v1',
    api_key TEXT NULL,
    public_base_url VARCHAR(500) NULL,
    token_secret TEXT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS ai_model_configs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    provider VARCHAR(50) NOT NULL DEFAULT 'bailian',
    base_url VARCHAR(500) NOT NULL,
    model VARCHAR(150) NOT NULL,
    api_key TEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_ai_model_config_name (name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS ai_prompts (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    content LONGTEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_ai_prompt_name (name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS ai_evaluations (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,
    question_id BIGINT UNSIGNED NOT NULL,
    input_hash CHAR(64) NOT NULL,
    input_snapshot LONGTEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'processing',
    result LONGTEXT NULL,
    error TEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME NULL,
    UNIQUE KEY uq_ai_evaluation_input (user_id, question_id, input_hash),
    INDEX idx_ai_evaluations_conversation (user_id, question_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS ai_messages (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,
    question_id BIGINT UNSIGNED NOT NULL,
    evaluation_id BIGINT UNSIGNED NULL,
    role VARCHAR(20) NOT NULL,
    content LONGTEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_ai_messages_conversation (user_id, question_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS simulation_templates (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    description VARCHAR(500) NULL,
    modules JSON NOT NULL,
    total_seconds INT UNSIGNED NOT NULL DEFAULT 1800,
    module_timeout_mode VARCHAR(20) NOT NULL DEFAULT 'warn',
    dynamic_tts_config JSON NULL,
    followup_prompt LONGTEXT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_simulation_template_name (name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS realtime_asr_settings (
    id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
    provider VARCHAR(50) NOT NULL DEFAULT 'bailian',
    websocket_url VARCHAR(500) NOT NULL,
    model VARCHAR(150) NOT NULL DEFAULT 'qwen-audio-3.0-asr-flash-streaming',
    api_key TEXT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS simulation_sessions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,
    template_id BIGINT UNSIGNED NULL,
    template_name VARCHAR(120) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'in_progress',
    total_seconds INT UNSIGNED NOT NULL,
    elapsed_seconds INT UNSIGNED NOT NULL DEFAULT 0,
    full_audio_data LONGBLOB NULL,
    full_audio_mime VARCHAR(100) NULL,
    transcript LONGTEXT NULL,
    transcript_segments JSON NULL,
    started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME NULL,
    INDEX idx_simulation_sessions_user_created (user_id, started_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS simulation_answers (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    session_id BIGINT UNSIGNED NOT NULL,
    module_index INT UNSIGNED NOT NULL,
    module_title VARCHAR(120) NOT NULL,
    question_id BIGINT UNSIGNED NULL,
    question TEXT NOT NULL,
    answer LONGTEXT NULL,
    transcript LONGTEXT NULL,
    transcript_segments JSON NULL,
    audio_data LONGBLOB NULL,
    audio_mime VARCHAR(100) NULL,
    question_audio_data LONGBLOB NULL,
    question_audio_mime VARCHAR(100) NULL,
    elapsed_seconds INT UNSIGNED NOT NULL DEFAULT 0,
    followup_question TEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_simulation_answers_session_module (session_id, module_index)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,  `CREATE TABLE IF NOT EXISTS simulation_evaluations (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    session_id BIGINT UNSIGNED NOT NULL,
    user_id BIGINT UNSIGNED NOT NULL,
    input_hash CHAR(64) NOT NULL,
    input_snapshot LONGTEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'processing',
    result LONGTEXT NULL,
    error TEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME NULL,
    UNIQUE KEY uq_simulation_evaluation_input (session_id, input_hash),
    INDEX idx_simulation_evaluations_session_created (session_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS simulation_messages (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    session_id BIGINT UNSIGNED NOT NULL,
    user_id BIGINT UNSIGNED NOT NULL,
    evaluation_id BIGINT UNSIGNED NULL,
    role VARCHAR(20) NOT NULL,
    content LONGTEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_simulation_messages_conversation (session_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS tts_settings (
    id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
    provider VARCHAR(50) NOT NULL DEFAULT 'bailian',
    clone_url VARCHAR(500) NULL,
    synthesis_url VARCHAR(500) NULL,
    websocket_url VARCHAR(500) NULL,
    sambert_websocket_url VARCHAR(500) NULL,
    sambert_api_key TEXT NULL,
    baidu_api_key TEXT NULL,
    baidu_secret_key TEXT NULL,
    baidu_tts_url VARCHAR(500) NULL,
    baidu_clone_url VARCHAR(500) NULL,
    api_key TEXT NULL,
    public_base_url VARCHAR(500) NULL,
    clone_model VARCHAR(150) NOT NULL DEFAULT 'voice-enrollment',
    clone_target_model VARCHAR(150) NOT NULL DEFAULT 'qwen-audio-3.0-tts-flash',
    default_model VARCHAR(150) NOT NULL DEFAULT 'qwen-audio-3.0-tts-flash',
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS question_voices (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    -- Cloned voice IDs are reusable across all questions. Generated audio
    -- files alone are attached to a concrete question.
    question_id BIGINT UNSIGNED NULL,
    name VARCHAR(160) NOT NULL,
    kind VARCHAR(20) NOT NULL DEFAULT 'custom',
    provider VARCHAR(30) NOT NULL DEFAULT 'bailian',
    status VARCHAR(20) NOT NULL DEFAULT 'ready',
    model VARCHAR(150) NOT NULL,
    voice_id VARCHAR(255) NULL,
    source_path VARCHAR(500) NULL,
    source_filename VARCHAR(255) NULL,
    source_mime VARCHAR(120) NULL,
    output_path VARCHAR(500) NULL,
    output_mime VARCHAR(120) NULL,
    parameters JSON NULL,
    public_token CHAR(64) NOT NULL,
    error TEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_question_voices_question_created (question_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS user_api_limits (
    user_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    ai_enabled TINYINT(1) NOT NULL DEFAULT 1,
    asr_enabled TINYINT(1) NOT NULL DEFAULT 1,
    realtime_asr_enabled TINYINT(1) NOT NULL DEFAULT 1,
    ai_token_limit BIGINT UNSIGNED NOT NULL DEFAULT 0,
    asr_request_limit INT UNSIGNED NOT NULL DEFAULT 0,
    realtime_seconds_limit BIGINT UNSIGNED NOT NULL DEFAULT 0,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS api_usage_logs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,
    feature VARCHAR(30) NOT NULL,
    input_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
    output_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
    audio_seconds BIGINT UNSIGNED NOT NULL DEFAULT 0,
    request_count INT UNSIGNED NOT NULL DEFAULT 1,
    model VARCHAR(150) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_api_usage_user_feature_created (user_id, feature, created_at)
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
async function ensurePracticeRecordColumns(db: Pool) {
  const columns: Array<[string, string]> = [
    ['transcript', 'LONGTEXT NULL'],
    ['transcript_segments', 'JSON NULL'],
    ['transcript_status', "VARCHAR(20) NOT NULL DEFAULT 'none'"],
    ['transcript_error', 'TEXT NULL'],
    ['transcript_started_at', 'DATETIME NULL'],
    ['transcribed_at', 'DATETIME NULL'],
  ];
  for (const [name, definition] of columns) {
    if (!(await hasColumn(db, 'practice_records', name))) await db.query('ALTER TABLE practice_records ADD COLUMN ' + name + ' ' + definition);
  }
}
async function ensureAiColumns(db: Pool) {
  const tableColumns: Array<[string, string, string]> = [
    ['ai_settings', 'provider', "VARCHAR(50) NOT NULL DEFAULT 'bailian'"],
    ['ai_settings', 'base_url', "VARCHAR(500) NOT NULL DEFAULT 'https://dashscope.aliyuncs.com/compatible-mode/v1'"],
    ['ai_settings', 'model', "VARCHAR(150) NOT NULL DEFAULT 'qwen3.8-27b'"],
    ['ai_settings', 'api_key', 'TEXT NULL'],
    ['ai_settings', 'system_prompt', 'LONGTEXT NULL'],
    ['ai_settings', 'active_config_id', 'BIGINT UNSIGNED NULL'],
    ['ai_settings', 'active_prompt_id', 'BIGINT UNSIGNED NULL'],
    ['ai_settings', 'auto_transcribe', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['ai_evaluations', 'input_hash', 'CHAR(64) NULL'],
    ['ai_evaluations', 'input_snapshot', 'LONGTEXT NULL'],
    ['ai_evaluations', 'status', "VARCHAR(20) NOT NULL DEFAULT 'processing'"],
    ['ai_evaluations', 'result', 'LONGTEXT NULL'],
    ['ai_evaluations', 'error', 'TEXT NULL'],
    ['ai_evaluations', 'completed_at', 'DATETIME NULL'],
  ];
  for (const [table, column, definition] of tableColumns) {
    if (!(await hasColumn(db, table, column))) await db.query('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + definition);
  }
}
async function ensureSimulationColumns(db: Pool) {
  if (!(await hasColumn(db, 'simulation_templates', 'module_timeout_mode'))) {
    await db.query("ALTER TABLE simulation_templates ADD COLUMN module_timeout_mode VARCHAR(20) NOT NULL DEFAULT 'warn' AFTER total_seconds");
  }
  if (!(await hasColumn(db, 'simulation_templates', 'dynamic_tts_config'))) {
    await db.query('ALTER TABLE simulation_templates ADD COLUMN dynamic_tts_config JSON NULL AFTER module_timeout_mode');
  }
  if (!(await hasColumn(db, 'simulation_answers', 'question_audio_data'))) {
    await db.query('ALTER TABLE simulation_answers ADD COLUMN question_audio_data LONGBLOB NULL AFTER audio_mime');
  }
  if (!(await hasColumn(db, 'simulation_answers', 'question_audio_mime'))) {
    await db.query('ALTER TABLE simulation_answers ADD COLUMN question_audio_mime VARCHAR(100) NULL AFTER question_audio_data');
  }
}
async function ensureQuestionVoiceColumns(db: Pool) {
  // Earlier deployments bound cloned voices to the question selected during
  // upload. Keep existing records, but allow new global voice profiles.
  await db.query('ALTER TABLE question_voices MODIFY COLUMN question_id BIGINT UNSIGNED NULL');
  if (!(await hasColumn(db, 'tts_settings', 'sambert_websocket_url'))) {
    await db.query('ALTER TABLE tts_settings ADD COLUMN sambert_websocket_url VARCHAR(500) NULL AFTER websocket_url');
  }
  if (!(await hasColumn(db, 'tts_settings', 'sambert_api_key'))) {
    await db.query('ALTER TABLE tts_settings ADD COLUMN sambert_api_key TEXT NULL AFTER sambert_websocket_url');
  }
  if (!(await hasColumn(db, 'tts_settings', 'baidu_api_key'))) {
    await db.query('ALTER TABLE tts_settings ADD COLUMN baidu_api_key TEXT NULL AFTER sambert_api_key');
  }
  if (!(await hasColumn(db, 'tts_settings', 'baidu_secret_key'))) {
    await db.query('ALTER TABLE tts_settings ADD COLUMN baidu_secret_key TEXT NULL AFTER baidu_api_key');
  }
  if (!(await hasColumn(db, 'tts_settings', 'baidu_tts_url'))) {
    await db.query("ALTER TABLE tts_settings ADD COLUMN baidu_tts_url VARCHAR(500) NULL AFTER baidu_secret_key");
  }
  if (!(await hasColumn(db, 'tts_settings', 'baidu_clone_url'))) {
    await db.query("ALTER TABLE tts_settings ADD COLUMN baidu_clone_url VARCHAR(500) NULL AFTER baidu_tts_url");
  }
  if (!(await hasColumn(db, 'question_voices', 'provider'))) {
    await db.query("ALTER TABLE question_voices ADD COLUMN provider VARCHAR(30) NOT NULL DEFAULT 'bailian' AFTER kind");
    await db.query("UPDATE question_voices SET provider='bailian' WHERE provider IS NULL OR provider='' ");
  }
}
async function initializeDatabase(db: Pool) {
  for (const statement of schema) await db.query(statement);
  await db.query("ALTER TABLE users MODIFY COLUMN status ENUM('pending', 'active', 'rejected', 'deleted') NOT NULL DEFAULT 'active'");
  await ensureQuestionColumns(db);
  await ensurePracticeRecordColumns(db);
  await ensureAiColumns(db);
  await ensureSimulationColumns(db);
  await ensureQuestionVoiceColumns(db);
  if (!(await hasColumn(db, 'user_settings', 'avoid_repeated'))) {
    await db.query('ALTER TABLE user_settings ADD COLUMN avoid_repeated TINYINT(1) NOT NULL DEFAULT 0');
  }
  if (!(await hasColumn(db, 'user_settings', 'read_question'))) {
    await db.query('ALTER TABLE user_settings ADD COLUMN read_question TINYINT(1) NOT NULL DEFAULT 1');
  }
  await db.query('ALTER TABLE user_settings MODIFY COLUMN read_question TINYINT(1) NOT NULL DEFAULT 1');
  const [readQuestionMigration] = await db.query<ResultSetHeader>('INSERT IGNORE INTO app_migrations (name) VALUES (?)', ['read_question_default_enabled']);
  if (readQuestionMigration.affectedRows) await db.query('UPDATE user_settings SET read_question = 1 WHERE read_question = 0');

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

  // These two categories were added after the first release. They are inserted
  // only when missing so an existing question bank receives the new choices
  // without overwriting any administrator-managed type or question.
  if (!seedQuestionBank) {
    for (const type of questionTypes.filter((item) => item.code === 'literature_translation' || item.code === 'ideology')) {
      await db.query(
        'INSERT IGNORE INTO question_types (code, name, description, settings, sort_order, is_active) VALUES (?, ?, ?, ?, ?, 1)',
        [type.code, type.name, type.description, JSON.stringify({ countdownSeconds: 3, autoRecord: true, answerReveal: 'after_recording' }), type.sortOrder],
      );
    }
    for (const mock of mockQuestions.filter((item) => item.code === 'literature_translation' || item.code === 'ideology')) {
      const [questionRows] = await db.query<RowDataPacket[]>('SELECT id FROM questions WHERE content = ? LIMIT 1', [mock.content]);
      if (questionRows.length) continue;
      const [typeRows] = await db.query<RowDataPacket[]>('SELECT id FROM question_types WHERE code = ? LIMIT 1', [mock.code]);
      if (!typeRows[0]) continue;
      await db.query('INSERT INTO questions (type_id, content, answer, subcategory, extra, status) VALUES (?, ?, ?, ?, ?, ?)', [
        typeRows[0].id, mock.content, mock.answer, mock.subcategory, JSON.stringify({ source: '系统模拟题' }), 'active',
      ]);
    }
  }

  if (seedQuestionBank) {
    for (const mock of mockQuestions) {
      const [typeRows] = await db.query<RowDataPacket[]>('SELECT id FROM question_types WHERE code = ? LIMIT 1', [mock.code]);
      await db.query('INSERT INTO questions (type_id, content, answer, subcategory, extra, status) VALUES (?, ?, ?, ?, ?, ?)', [
        typeRows[0].id, mock.content, mock.answer, mock.subcategory, JSON.stringify({ source: '系统 mock 数据' }), 'active',
      ]);
    }
  }

  await db.query('INSERT IGNORE INTO user_settings (user_id) SELECT id FROM users');
  await db.query('INSERT IGNORE INTO user_api_limits (user_id) SELECT id FROM users');

  const [aiSettingRows] = await db.query<RowDataPacket[]>('SELECT COUNT(*) AS count FROM ai_settings');
  if (Number(aiSettingRows[0].count) === 0) {
    await db.query(
      'INSERT INTO ai_settings (id, provider, base_url, model, api_key, system_prompt) VALUES (1, ?, ?, ?, NULL, ?)',
      [
        'bailian',
        'https://dashscope.aliyuncs.com/compatible-mode/v1',
        'qwen3.8-27b',
        '你是一名资深的食品专业保研面试评估老师，熟悉食品科学与工程、食品质量与安全等方向的笔试和面试要求。\n请根据题目类型、题目内容以及学员最近最多三次回答，客观、具体、可执行地评估学员表现。重点找出回答中的问题和改进方向，同时肯定做得好的地方。\n请关注：专业知识准确性、回答结构、论据与案例、表达清晰度、逻辑连贯性、英语表达（如果是英语题）、思考停顿与回答节奏（如果提供了带时间戳的文字切片）。\n请使用简洁的 Markdown 输出，包含：总体评价、做得好的地方、主要问题、下一步改进建议、参考回答框架、与前几次相比的进步或退步。不要编造学员没有提供的经历或事实。',
      ],
    );
  }

  // ASR is deliberately stored separately from the chat/evaluation model.
  // Environment variables are only used once to bootstrap a new deployment.
  const [asrSettingRows] = await db.query<RowDataPacket[]>('SELECT COUNT(*) AS count FROM asr_settings');
  if (Number(asrSettingRows[0].count) === 0) {
    const submitUrl = (process.env.DASHSCOPE_ASR_URL || 'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription').trim();
    let taskUrl = 'https://dashscope.aliyuncs.com/api/v1/tasks';
    try { taskUrl = new URL(submitUrl).origin + '/api/v1/tasks'; } catch { /* keep default */ }
    await db.query(
      'INSERT INTO asr_settings (id, provider, submit_url, task_url, model, api_key, public_base_url, token_secret) VALUES (1, ?, ?, ?, ?, ?, ?, ?)',
      [
        'bailian', submitUrl, (process.env.DASHSCOPE_TASK_URL || taskUrl).trim().replace(/\/+$/, ''),
        (process.env.DASHSCOPE_ASR_MODEL || 'paraformer-v1').trim(),
        process.env.DASHSCOPE_API_KEY || process.env.BAILIAN_API_KEY || process.env.SILICONFLOW_API_KEY || null,
        (process.env.ASR_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '') || null,
        process.env.ASR_AUDIO_TOKEN_SECRET || process.env.DASHSCOPE_API_KEY || process.env.BAILIAN_API_KEY || process.env.SILICONFLOW_API_KEY || null,
      ],
    );
  }

  const [modelConfigRows] = await db.query<RowDataPacket[]>('SELECT COUNT(*) AS count FROM ai_model_configs');
  if (Number(modelConfigRows[0].count) === 0) {
    const legacy = (await db.query<RowDataPacket[]>('SELECT provider, base_url AS baseUrl, model, api_key AS apiKey FROM ai_settings WHERE id = 1 LIMIT 1'))[0][0];
    const modelResult = await db.query<ResultSetHeader>(
      'INSERT INTO ai_model_configs (name, provider, base_url, model, api_key) VALUES (?, ?, ?, ?, ?)',
      ['百炼默认模型', legacy?.provider || 'bailian', legacy?.baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1', legacy?.model || 'qwen3.8-27b', legacy?.apiKey || process.env.DASHSCOPE_API_KEY || null],
    );
    await db.query('UPDATE ai_settings SET active_config_id = ? WHERE id = 1', [modelResult[0].insertId]);
  }
  const [promptRows] = await db.query<RowDataPacket[]>('SELECT COUNT(*) AS count FROM ai_prompts');
  if (Number(promptRows[0].count) === 0) {
    const legacyPrompt = (await db.query<RowDataPacket[]>('SELECT system_prompt AS systemPrompt FROM ai_settings WHERE id = 1 LIMIT 1'))[0][0];
    const promptResult = await db.query<ResultSetHeader>(
      'INSERT INTO ai_prompts (name, content) VALUES (?, ?)',
      ['食品保研面试评估', legacyPrompt?.systemPrompt || '你是一名资深的食品专业保研面试评估老师，请客观、具体地指出学员回答中的优点、问题和改进方向。'],
    );
    await db.query('UPDATE ai_settings SET active_prompt_id = ? WHERE id = 1', [promptResult[0].insertId]);
  }
  const activeConfig = (await db.query<RowDataPacket[]>('SELECT id, provider, base_url AS baseUrl, model, api_key AS apiKey FROM ai_model_configs ORDER BY id LIMIT 1'))[0][0];
  const activePrompt = (await db.query<RowDataPacket[]>('SELECT id, content FROM ai_prompts ORDER BY id LIMIT 1'))[0][0];
  if (activeConfig && activePrompt) {
    await db.query(
      'UPDATE ai_settings SET active_config_id = COALESCE(active_config_id, ?), active_prompt_id = COALESCE(active_prompt_id, ?), provider = ?, base_url = ?, model = ?, api_key = ?, system_prompt = ? WHERE id = 1',
      [activeConfig.id, activePrompt.id, activeConfig.provider, activeConfig.baseUrl, activeConfig.model, activeConfig.apiKey || null, activePrompt.content],
    );
  }

  const [templateRows] = await db.query<RowDataPacket[]>('SELECT COUNT(*) AS count FROM simulation_templates');
  if (Number(templateRows[0].count) === 0) {
    const modules = [
      { id: 'intro', title: '中文自我介绍', kind: 'intro', count: 1, timeSeconds: 480, allowFollowup: false, prompt: '请进行中文自我介绍，不需要 PPT。' },
      { id: 'ideology', title: '思政抽题', kind: 'question', typeCode: 'comprehensive', count: 1, timeSeconds: 120, allowFollowup: false },
      { id: 'english', title: '英语问答', kind: 'question', typeCode: 'english', count: 1, timeSeconds: 120, allowFollowup: true, followupCount: 1 },
      { id: 'professional', title: '专业课抽题', kind: 'question', typeCode: 'professional', count: 1, timeSeconds: 180, allowFollowup: true, followupCount: 2 },
    ];
    await db.query('INSERT INTO simulation_templates (name, description, modules, total_seconds, followup_prompt) VALUES (?, ?, ?, ?, ?)', [
      '中农完整面试模拟', '中文自我介绍 → 思政抽题 → 英语问答 → 专业课抽题 → 老师追问', JSON.stringify(modules), 1800,
      '你是一名食品专业保研面试老师，正在进行真实面试。请根据原题、学员的全部已作答内容、当前追问轮次和所在模块，只生成一条自然、具体、可继续作答的老师追问。首轮优先核验核心观点、事实依据或表达中的模糊处；后续轮次要么沿同一问题继续深入，要么换一个能补足判断的信息角度。不得重复已问问题，不要评价、提示、编号或解释，只输出追问问题本身。',
    ]);
  }
  await db.query(
    'UPDATE simulation_templates SET followup_prompt = ? WHERE followup_prompt = ?',
    [
      '你是一名食品专业保研面试老师，正在进行真实面试。请根据原题、学员的全部已作答内容、当前追问轮次和所在模块，只生成一条自然、具体、可继续作答的老师追问。首轮优先核验核心观点、事实依据或表达中的模糊处；后续轮次要么沿同一问题继续深入，要么换一个能补足判断的信息角度。不得重复已问问题，不要评价、提示、编号或解释，只输出追问问题本身。',
      '你是一名食品专业保研面试老师。请只根据题目与学员刚才的回答，提出一个自然、具体、有区分度的追问。只输出追问问题本身，不要解释。',
    ],
  );
  const [realtimeRows] = await db.query<RowDataPacket[]>('SELECT COUNT(*) AS count FROM realtime_asr_settings');
  if (Number(realtimeRows[0].count) === 0) {
    await db.query('INSERT INTO realtime_asr_settings (id, provider, websocket_url, model, api_key) VALUES (1, ?, ?, ?, ?)', [
      'bailian', process.env.DASHSCOPE_REALTIME_ASR_URL || 'wss://dashscope.aliyuncs.com/api-ws/v1/inference/',
      process.env.DASHSCOPE_REALTIME_ASR_MODEL || 'qwen-audio-3.0-asr-flash-streaming', process.env.DASHSCOPE_API_KEY || process.env.BAILIAN_API_KEY || null,
    ]);
  }
  const [ttsRows] = await db.query<RowDataPacket[]>('SELECT COUNT(*) AS count FROM tts_settings');
  if (Number(ttsRows[0].count) === 0) {
    await db.query('INSERT INTO tts_settings (id, provider, clone_url, synthesis_url, websocket_url, sambert_websocket_url, sambert_api_key, baidu_api_key, baidu_secret_key, baidu_tts_url, baidu_clone_url, api_key, public_base_url) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      'bailian', process.env.DASHSCOPE_TTS_CLONE_URL || null,
      process.env.DASHSCOPE_TTS_URL || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text2speech/speech-synthesis',
      process.env.DASHSCOPE_TTS_WS_URL || 'wss://dashscope.aliyuncs.com/api-ws/v1/inference/',
      process.env.DASHSCOPE_SAMBERT_TTS_WS_URL || process.env.DASHSCOPE_TTS_WS_URL || 'wss://dashscope.aliyuncs.com/api-ws/v1/inference/',
      process.env.DASHSCOPE_SAMBERT_API_KEY || null,
      process.env.BAIDU_TTS_API_KEY || null,
      process.env.BAIDU_TTS_SECRET_KEY || null,
      process.env.BAIDU_TTS_URL || 'https://tsn.baidu.com/text2audio',
      process.env.BAIDU_TTS_CLONE_URL || 'https://aip.baidubce.com/rest/2.0/speech/publiccloudspeech/v1/voice/clone/create',
      process.env.DASHSCOPE_API_KEY || process.env.BAILIAN_API_KEY || null,
      process.env.TTS_PUBLIC_BASE_URL || process.env.ASR_PUBLIC_BASE_URL || null,
    ]);
  }
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
    // MySQL evaluates CURRENT_TIMESTAMP using the connection session timezone.
    // Set it for every pooled connection so DATETIME defaults are Beijing time,
    // even when the MySQL server itself runs in UTC.
    pool.on('connection', (connection) => {
      const promiseConnection = (connection as unknown as { promise: () => { query: (sql: string) => Promise<unknown> } }).promise();
      void promiseConnection.query("SET time_zone = '+08:00'").catch(() => undefined);
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
