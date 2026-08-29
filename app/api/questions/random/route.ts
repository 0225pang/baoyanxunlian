import { apiError, requireUser } from '@/lib/auth';
import { query } from '@/lib/db';

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const params = new URL(request.url).searchParams;
    const category = params.get('category') || '';
    const typeId = Number(params.get('typeId') || 0);
    const settingsRows = await query('SELECT avoid_repeated AS avoidRepeated FROM user_settings WHERE user_id = ?', [user.id]);
    const avoidRepeated = Boolean((settingsRows[0] as { avoidRepeated?: number } | undefined)?.avoidRepeated);

    const conditions = ["q.status = 'active'", 't.is_active = 1'];
    const values: unknown[] = [];
    if (Number.isInteger(typeId) && typeId > 0) {
      conditions.push('t.id = ?');
      values.push(typeId);
    }
    if (category) {
      conditions.push('t.name = ?');
      values.push(category);
    }
    if (avoidRepeated) {
      conditions.push('NOT EXISTS (SELECT 1 FROM practice_records practiced WHERE practiced.user_id = ? AND practiced.question_id = q.id)');
      values.push(user.id);
    }

    const sql = 'SELECT q.id, q.content, q.subcategory, t.id AS typeId, t.code AS typeCode, t.name AS category, '
      + "CASE WHEN q.answer IS NULL OR TRIM(q.answer) = '' THEN 0 ELSE 1 END AS hasAnswer "
      + ", (SELECT v.id FROM question_voices v WHERE v.question_id=q.id AND v.kind='generated' AND v.status='ready' AND v.output_path IS NOT NULL ORDER BY RAND() LIMIT 1) AS questionVoiceId "
      + 'FROM questions q JOIN question_types t ON t.id = q.type_id '
      + 'WHERE ' + conditions.join(' AND ') + ' ORDER BY RAND() LIMIT 1';
    const rows = await query(sql, values);
    const row = rows[0];
    if (row) return Response.json({ question: { ...row, questionVoiceUrl: row.questionVoiceId ? `/api/question-voices/${Number(row.questionVoiceId)}/audio?kind=output` : null } });
    return Response.json({ error: avoidRepeated ? '该分类暂无未练习题目' : '该分类暂无题目' }, { status: 404 });
  } catch (error) { return apiError(error); }
}
