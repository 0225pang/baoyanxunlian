import { apiError, requireUser } from '@/lib/auth';
import { query } from '@/lib/db';

export async function GET(request: Request) {
  try {
    await requireUser();
    const params = new URL(request.url).searchParams;
    const page = Math.max(1, Number(params.get('page') || 1));
    const pageSize = Math.min(30, Math.max(6, Number(params.get('pageSize') || 12)));
    const typeId = Number(params.get('typeId') || 0);
    const search = params.get('q')?.trim() || '';
    const where = ["q.status = 'active'"];
    const values: unknown[] = [];
    if (typeId) { where.push('q.type_id = ?'); values.push(typeId); }
    if (search) { where.push('(q.content LIKE ? OR q.subcategory LIKE ?)'); values.push(`%${search}%`, `%${search}%`); }
    const totalRows = await query(`SELECT COUNT(*) AS total FROM questions q WHERE ${where.join(' AND ')}`, values);
    const total = Number((totalRows[0] as { total: number }).total);
    const questions = await query(`SELECT q.id, q.type_id AS typeId, t.code AS typeCode, t.name AS category,
      q.content, q.subcategory, (q.answer IS NOT NULL AND CHAR_LENGTH(TRIM(q.answer)) > 0) AS hasAnswer,
      CASE WHEN t.code='literature_translation' THEN (SELECT v.id FROM question_voices v WHERE v.question_id IS NULL AND v.kind='translation_prompt' AND v.status='ready' AND v.output_path IS NOT NULL ORDER BY RAND() LIMIT 1) ELSE (SELECT v.id FROM question_voices v WHERE v.question_id=q.id AND v.kind='generated' AND v.status='ready' AND v.output_path IS NOT NULL ORDER BY RAND() LIMIT 1) END AS questionVoiceId
      FROM questions q JOIN question_types t ON t.id = q.type_id
      WHERE ${where.join(' AND ')} ORDER BY q.updated_at DESC, q.id DESC LIMIT ? OFFSET ?`, [...values, pageSize, (page - 1) * pageSize]);
    return Response.json({ questions: questions.map((item) => ({ ...item, suppressBrowserRead: String(item.typeCode) === 'literature_translation', questionVoiceUrl: item.questionVoiceId ? `/api/question-voices/${Number(item.questionVoiceId)}/audio?kind=output` : null })), total, page, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
  } catch (error) { return apiError(error); }
}
