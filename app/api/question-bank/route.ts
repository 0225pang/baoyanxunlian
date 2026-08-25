import * as XLSX from 'xlsx';
import { apiError, requireUser } from '@/lib/auth';
import { execute, query } from '@/lib/db';

type QuestionPayload = {
  typeId?: number;
  content?: string;
  answer?: string | null;
  subcategory?: string | null;
  extra?: unknown;
  status?: string;
};

function parseExtra(value: unknown) {
  if (!value) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  try { return JSON.stringify(JSON.parse(String(value))); } catch { return JSON.stringify({ note: String(value) }); }
}

async function ensureAdmin() {
  const user = await requireUser();
  if (user.role !== 'admin') throw new Error('FORBIDDEN');
  return user;
}

async function typeExists(typeId: number) {
  const rows = await query('SELECT id FROM question_types WHERE id = ? AND is_active = 1 LIMIT 1', [typeId]);
  return rows.length > 0;
}

export async function GET(request: Request) {
  try {
    await ensureAdmin();
    const params = new URL(request.url).searchParams;
    const page = Math.max(1, Number(params.get('page') || 1));
    const pageSize = Math.min(50, Math.max(5, Number(params.get('pageSize') || 10)));
    const typeId = Number(params.get('typeId') || 0);
    const search = params.get('q')?.trim() || '';
    const where = ['1 = 1'];
    const values: unknown[] = [];
    if (typeId) { where.push('q.type_id = ?'); values.push(typeId); }
    if (search) { where.push('(q.content LIKE ? OR q.answer LIKE ? OR q.subcategory LIKE ?)'); values.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    const countRows = await query(`SELECT COUNT(*) AS total FROM questions q WHERE ${where.join(' AND ')}`, values);
    const total = Number((countRows[0] as { total: number }).total);
    const offset = (page - 1) * pageSize;
    const questions = await query(`SELECT q.id, q.type_id AS typeId, t.code AS typeCode, t.name AS typeName,
      q.content, q.answer, q.subcategory, q.extra, q.status,
      DATE_FORMAT(q.created_at, '%Y-%m-%dT%H:%i:%s') AS createdAt,
      DATE_FORMAT(q.updated_at, '%Y-%m-%dT%H:%i:%s') AS updatedAt
      FROM questions q LEFT JOIN question_types t ON t.id = q.type_id
      WHERE ${where.join(' AND ')} ORDER BY q.updated_at DESC, q.id DESC LIMIT ? OFFSET ?`, [...values, pageSize, offset]);
    return Response.json({ questions, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    await ensureAdmin();
    const data = await request.json() as QuestionPayload;
    const typeId = Number(data.typeId);
    const content = String(data.content || '').trim();
    if (!Number.isInteger(typeId) || !content) return Response.json({ error: '题型和题目内容不能为空' }, { status: 400 });
    if (!(await typeExists(typeId))) return Response.json({ error: '题型不存在或已停用' }, { status: 400 });
    const result = await execute('INSERT INTO questions (type_id, content, answer, subcategory, extra, status) VALUES (?, ?, ?, ?, ?, ?)', [
      typeId, content, String(data.answer || '').trim() || null, String(data.subcategory || '').trim() || null, parseExtra(data.extra), ['active', 'draft', 'archived'].includes(String(data.status)) ? String(data.status) : 'active',
    ]);
    return Response.json({ id: Number(result.insertId) }, { status: 201 });
  } catch (error) { return apiError(error); }
}

export async function PATCH(request: Request) {
  try {
    await ensureAdmin();
    const data = await request.json() as QuestionPayload & { id?: number };
    const id = Number(data.id);
    const typeId = Number(data.typeId);
    const content = String(data.content || '').trim();
    if (!Number.isInteger(id) || !Number.isInteger(typeId) || !content) return Response.json({ error: '题目参数不完整' }, { status: 400 });
    if (!(await typeExists(typeId))) return Response.json({ error: '题型不存在或已停用' }, { status: 400 });
    const result = await execute('UPDATE questions SET type_id = ?, content = ?, answer = ?, subcategory = ?, extra = ?, status = ? WHERE id = ?', [
      typeId, content, String(data.answer || '').trim() || null, String(data.subcategory || '').trim() || null, parseExtra(data.extra), ['active', 'draft', 'archived'].includes(String(data.status)) ? String(data.status) : 'active', id,
    ]);
    if (!result.affectedRows) return Response.json({ error: '题目不存在' }, { status: 404 });
    return Response.json({ ok: true });
  } catch (error) { return apiError(error); }
}

export async function DELETE(request: Request) {
  try {
    await ensureAdmin();
    const data = await request.json() as { id?: number };
    const id = Number(data.id);
    if (!Number.isInteger(id)) return Response.json({ error: '题目编号无效' }, { status: 400 });
    const result = await execute('DELETE FROM questions WHERE id = ?', [id]);
    if (!result.affectedRows) return Response.json({ error: '题目不存在' }, { status: 404 });
    return Response.json({ ok: true });
  } catch (error) { return apiError(error); }
}

export async function PUT(request: Request) {
  try {
    await ensureAdmin();
    const form = await request.formData();
    const typeId = Number(form.get('typeId'));
    const file = form.get('file');
    if (!Number.isInteger(typeId) || !(await typeExists(typeId))) return Response.json({ error: '请选择有效题型' }, { status: 400 });
    if (!(file instanceof File) || !file.size) return Response.json({ error: '请选择 Excel 文件' }, { status: 400 });
    if (file.size > 10 * 1024 * 1024) return Response.json({ error: 'Excel 文件不能超过 10MB' }, { status: 400 });
    const workbook = XLSX.read(Buffer.from(await file.arrayBuffer()), { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) return Response.json({ error: 'Excel 中没有可读取的工作表' }, { status: 400 });
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
    const aliases = {
      content: ['题目内容', '题目', '问题', 'content', 'question'],
      answer: ['参考答案', '答案', 'answer'],
      subcategory: ['具体分类', '细分类', '分类', 'subcategory'],
      source: ['来源', 'source'],
      notes: ['备注', '说明', 'notes'],
    } as const;
    const valueOf = (row: Record<string, unknown>, names: readonly string[]) => {
      const key = Object.keys(row).find((item) => names.includes(item.trim()));
      return key ? String(row[key] ?? '').trim() : '';
    };
    let imported = 0; let skipped = 0; const errors: string[] = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]; const content = valueOf(row, aliases.content);
      if (!content) { skipped += 1; continue; }
      const answer = valueOf(row, aliases.answer); const subcategory = valueOf(row, aliases.subcategory);
      const source = valueOf(row, aliases.source); const notes = valueOf(row, aliases.notes);
      const extra = source || notes ? JSON.stringify({ ...(source ? { source } : {}), ...(notes ? { notes } : {}) }) : null;
      try {
        await execute('INSERT INTO questions (type_id, content, answer, subcategory, extra, status) VALUES (?, ?, ?, ?, ?, ?)', [typeId, content, answer || null, subcategory || null, extra, 'active']);
        imported += 1;
      } catch (error) { errors.push(`第 ${index + 2} 行：${String(error)}`); }
    }
    return Response.json({ imported, skipped, errors: errors.slice(0, 20), totalRows: rows.length });
  } catch (error) { return apiError(error); }
}
