import { apiError, requireUser } from '@/lib/auth';
import { execute, query } from '@/lib/db';

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const params = new URL(request.url).searchParams;
    const category = params.get('category') || '';
    const search = params.get('q')?.trim() || '';
    const ownerFilter = user.role === 'admin' ? '' : 'AND r.user_id = ?';
    const values: unknown[] = [];
    if (user.role !== 'admin') values.push(user.id);
    values.push(category, category, search, `%${search}%`, `%${search}%`);
    const records = await query(`SELECT r.id, r.user_id AS userId, r.question_id AS questionId, r.category, r.question, r.answer,
      q.type_id AS typeId, q.subcategory, q.answer AS referenceAnswer,
      (q.answer IS NOT NULL AND CHAR_LENGTH(TRIM(q.answer)) > 0) AS hasReferenceAnswer,
      r.audio_data IS NOT NULL AS hasAudio,
      r.transcript, r.transcript_segments AS transcriptSegments, r.transcript_status AS transcriptStatus, r.transcript_error AS transcriptError,
      DATE_FORMAT(r.transcribed_at, '%Y-%m-%dT%H:%i:%s') AS transcribedAt,
      DATE_FORMAT(r.created_at, '%Y-%m-%dT%H:%i:%s') AS createdAt,
      u.username AS username, u.display_name AS displayName
      FROM practice_records r JOIN users u ON u.id = r.user_id
      LEFT JOIN questions q ON q.id = r.question_id
      WHERE 1 = 1 ${ownerFilter}
        AND (? = '' OR r.category = ?)
        AND (? = '' OR r.question LIKE ? OR r.answer LIKE ?)
      ORDER BY r.created_at DESC, r.id DESC`, values);
    return Response.json({ records });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const data = await request.formData();
    const questionId = Number(data.get('questionId'));
    let category = String(data.get('category') || '');
    let question = String(data.get('question') || '').trim();
    const answer = String(data.get('answer') || '').trim() || '本次为口述作答，未填写文字提纲。';
    if (!Number.isInteger(questionId) || questionId < 1) return Response.json({ error: '题目参数无效，请重新选择题目后提交。' }, { status: 400 });
    // Do not maintain a hard-coded category allowlist here. New question types
    // (for example literature translation and ideology) are valid automatically.
    const questionRows = await query(`SELECT q.content, t.name AS category FROM questions q JOIN question_types t ON t.id=q.type_id WHERE q.id=? AND q.status='active' AND t.is_active=1 LIMIT 1`, [questionId]);
    const storedQuestion = questionRows[0] as { content?: string; category?: string } | undefined;
    if (!storedQuestion?.content || !storedQuestion.category) return Response.json({ error: '题目不存在或已停用，请返回题库重新选择。' }, { status: 400 });
    category = String(storedQuestion.category);
    question = String(storedQuestion.content);

    const audio = data.get('audio');
    let audioData: Buffer | null = null;
    let audioMime: string | null = null;
    let audioSize: number | null = null;
    if (audio instanceof File && audio.size > 0) {
      if (audio.size > 50 * 1024 * 1024 || !audio.type.startsWith('audio/')) return Response.json({ error: '录音格式无效或超过 50MB' }, { status: 400 });
      audioData = Buffer.from(await audio.arrayBuffer());
      audioMime = audio.type;
      audioSize = audio.size;
    }
    const result = await execute(`INSERT INTO practice_records
      (user_id, question_id, category, question, answer, audio_data, audio_mime, audio_size) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [user.id, questionId, category, question, answer, audioData, audioMime, audioSize]);
    return Response.json({ id: Number(result.insertId) }, { status: 201 });
  } catch (error) { return apiError(error); }
}
