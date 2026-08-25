import { apiError, requireUser } from '@/lib/auth';
import { query } from '@/lib/db';
export async function GET(request: Request) {
  try {
    await requireUser();
    const category = new URL(request.url).searchParams.get('category');
    const rows = await query('SELECT id, category, content FROM questions WHERE category = ? AND enabled = 1 ORDER BY RAND() LIMIT 1', [category]);
    const row = rows[0];
    return row ? Response.json({ question: row }) : Response.json({ error: '该分类暂无题目' }, { status: 404 });
  } catch (error) { return apiError(error); }
}
