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
    const records = await query(`SELECT r.id, r.category, r.question, r.answer,
      r.audio_data IS NOT NULL AS hasAudio, DATE_FORMAT(r.created_at, '%Y-%m-%dT%H:%i:%s') AS createdAt,
      u.username AS username, u.display_name AS displayName
      FROM practice_records r JOIN users u ON u.id = r.user_id
      WHERE 1 = 1 ${ownerFilter}
        AND (? = '' OR r.category = ?)
        AND (? = '' OR r.question LIKE ? OR r.answer LIKE ?)
      ORDER BY r.created_at DESC, r.id DESC LIMIT 200`, values);
    return Response.json({ records });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const data = await request.formData();
    const questionId = Number(data.get('questionId'));
    const category = String(data.get('category') || '');
    const question = String(data.get('question') || '').trim();
    const answer = String(data.get('answer') || '').trim() || '本次为口述作答，未填写文字提纲。';
    if (!questionId || !['专业素养', '英语能力', '综合面试'].includes(category) || !question) return Response.json({ error: '作答数据不完整' }, { status: 400 });

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
