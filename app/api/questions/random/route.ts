import { apiError, requireUser } from '@/lib/auth';
import { query } from '@/lib/db';

export async function GET(request: Request) {
  try {
    await requireUser();
    const params = new URL(request.url).searchParams;
    const category = params.get('category') || '';
    const typeId = Number(params.get('typeId') || 0);
    const rows = await query(`SELECT q.id, q.content, q.subcategory, t.id AS typeId, t.code AS typeCode, t.name AS category,
      CASE WHEN q.answer IS NULL OR TRIM(q.answer) = '' THEN 0 ELSE 1 END AS hasAnswer
      FROM questions q JOIN question_types t ON t.id = q.type_id
      WHERE q.status = 'active' AND t.is_active = 1 AND (${typeId ? 't.id = ?' : '? = 0'})
        AND (? = '' OR t.name = ?)
      ORDER BY RAND() LIMIT 1`, [typeId, category, category]);
    const row = rows[0];
    return row ? Response.json({ question: row }) : Response.json({ error: '该分类暂无题目' }, { status: 404 });
  } catch (error) { return apiError(error); }
}