import * as XLSX from 'xlsx';
import type { RowDataPacket } from 'mysql2/promise';
import { apiError, requireUser } from '@/lib/auth';
import { execute, query } from '@/lib/db';
import { regenerateQuestionVoiceVariants } from '@/lib/question-voices';

type QuestionPayload = {
  typeId?: number;
  content?: string;
  answer?: string | null;
  subcategory?: string | null;
  extra?: unknown;
  status?: string;
};

type ImportCandidate = { row: number; content: string; answer: string; subcategory: string; extra: string | null };

function normalizedContent(value: unknown) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function parseExtra(value: unknown) {
  if (!value) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  try { return JSON.stringify(JSON.parse(String(value))); } catch { return JSON.stringify({ note: String(value) }); }
}

// Deduplicate questions by content only. Type and metadata are intentionally ignored.
async function questionIdWithContent(content: string, excludeId?: number) {
  const rows = await query('SELECT id FROM questions WHERE content = ?' + (excludeId ? ' AND id <> ?' : '') + ' LIMIT 1', excludeId ? [content, excludeId] : [content]);
  return rows.length ? Number((rows[0] as { id: number }).id) : null;
}

async function existingContentKeys() {
  const rows = await query<RowDataPacket[]>('SELECT content FROM questions');
  return new Set(rows.map((row) => normalizedContent(row.content)).filter(Boolean));
}

async function parseImportCandidates(file: File): Promise<{ candidates: ImportCandidate[]; totalRows: number; blankRows: number }> {
  const workbook = XLSX.read(Buffer.from(await file.arrayBuffer()), { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error('Excel 中没有可读取的工作表');
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
  const aliases = {
    content: ['题目内容', '题目', '问题', 'content', 'question'],
    answer: ['参考答案', '答案', 'answer'], subcategory: ['具体分类', '细分类', '分类', 'subcategory'],
    source: ['来源', 'source'], notes: ['备注', '说明', 'notes'],
  } as const;
  const valueOf = (row: Record<string, unknown>, names: readonly string[]) => {
    const key = Object.keys(row).find((item) => names.includes(item.trim()));
    return key ? String(row[key] ?? '').trim() : '';
  };
  const candidates: ImportCandidate[] = []; let blankRows = 0;
  rows.forEach((row, index) => {
    const content = String(valueOf(row, aliases.content)).trim();
    if (!content) { blankRows += 1; return; }
    const source = valueOf(row, aliases.source); const notes = valueOf(row, aliases.notes);
    candidates.push({ row: index + 2, content, answer: valueOf(row, aliases.answer), subcategory: valueOf(row, aliases.subcategory), extra: source || notes ? JSON.stringify({ ...(source ? { source } : {}), ...(notes ? { notes } : {}) }) : null });
  });
  return { candidates, totalRows: rows.length, blankRows };
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
    if (params.get('mode') === 'duplicates') {
      const rows = await query<RowDataPacket[]>(`SELECT q.id, q.type_id AS typeId, t.name AS typeName, q.content, q.subcategory, q.status,
        DATE_FORMAT(q.created_at, '%Y-%m-%dT%H:%i:%s') AS createdAt,
        (SELECT COUNT(*) FROM practice_records pr WHERE pr.question_id = q.id) AS recordCount,
        (SELECT COUNT(*) FROM question_voices qv WHERE qv.question_id = q.id AND qv.kind = 'generated') AS voiceCount
        FROM questions q LEFT JOIN question_types t ON t.id = q.type_id ORDER BY q.id DESC`);
      const grouped = new Map<string, typeof rows>();
      rows.forEach((row) => {
        const key = normalizedContent(row.content); if (!key) return;
        grouped.set(key, [...(grouped.get(key) || []), row]);
      });
      const groups = Array.from(grouped.values()).filter((items) => items.length > 1).map((items) => ({
        key: normalizedContent(items[0].content), content: items[0].content, count: items.length,
        questions: items.map((item) => ({ ...item, id: Number(item.id), typeId: Number(item.typeId), recordCount: Number(item.recordCount), voiceCount: Number(item.voiceCount) })),
      }));
      return Response.json({ groups, duplicateCount: groups.reduce((total, group) => total + group.count, 0) });
    }
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
    if (await questionIdWithContent(content)) return Response.json({ error: '\u9898\u76ee\u5185\u5bb9\u5df2\u5b58\u5728\uff0c\u672a\u91cd\u590d\u6dfb\u52a0' }, { status: 409 });
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
    if (await questionIdWithContent(content, id)) return Response.json({ error: '\u9898\u76ee\u5185\u5bb9\u5df2\u5b58\u5728\uff0c\u672a\u4fdd\u5b58\u91cd\u590d\u9898\u76ee' }, { status: 409 });
    const originalRows = await query<RowDataPacket[]>('SELECT content FROM questions WHERE id = ? LIMIT 1', [id]);
    const contentChanged = Boolean(originalRows[0]) && String(originalRows[0].content || '').trim() !== content;
    const variants = contentChanged ? await query<RowDataPacket[]>(`SELECT id, name, provider, model, voice_id AS voiceId, parameters
      FROM question_voices WHERE question_id = ? AND kind = 'generated' AND status = 'ready' AND output_path IS NOT NULL ORDER BY id ASC`, [id]) : [];
    const result = await execute('UPDATE questions SET type_id = ?, content = ?, answer = ?, subcategory = ?, extra = ?, status = ? WHERE id = ?', [
      typeId, content, String(data.answer || '').trim() || null, String(data.subcategory || '').trim() || null, parseExtra(data.extra), ['active', 'draft', 'archived'].includes(String(data.status)) ? String(data.status) : 'active', id,
    ]);
    if (!result.affectedRows) return Response.json({ error: '题目不存在' }, { status: 404 });
    if (!contentChanged || !variants.length) return Response.json({ ok: true, contentChanged, voiceRegeneration: { found: 0, generated: 0, failed: 0 } });
    // Old records remain available in the admin voice library, but are no
    // longer eligible for random playback because their text is stale.
    await execute("UPDATE question_voices SET status = 'superseded' WHERE question_id = ? AND kind = 'generated' AND status = 'ready' AND output_path IS NOT NULL", [id]);
    const regenerated = await regenerateQuestionVoiceVariants(id, content, variants.map((voice) => ({ id: Number(voice.id), name: String(voice.name), provider: String(voice.provider), model: String(voice.model), voiceId: voice.voiceId === null ? null : String(voice.voiceId), parameters: voice.parameters })));
    return Response.json({ ok: true, contentChanged, voiceRegeneration: { found: variants.length, ...regenerated } });
  } catch (error) { return apiError(error); }
}

export async function DELETE(request: Request) {
  try {
    await ensureAdmin();
    const data = await request.json() as { id?: number; ids?: number[] };
    const ids = Array.from(new Set((Array.isArray(data.ids) ? data.ids : [data.id])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)));
    if (!ids.length) return Response.json({ error: '请选择要删除的题目' }, { status: 400 });
    const placeholders = ids.map(() => '?').join(', ');
    const result = await execute('DELETE FROM questions WHERE id IN (' + placeholders + ')', ids);
    return Response.json({ ok: true, deleted: Number(result.affectedRows) });
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
    const parsed = await parseImportCandidates(file);
    const existing = await existingContentKeys(); const inFile = new Set<string>();
    const duplicateExisting: { row: number; content: string }[] = []; const duplicateInFile: { row: number; content: string }[] = [];
    const importable = parsed.candidates.filter((candidate) => {
      const key = normalizedContent(candidate.content);
      if (existing.has(key)) { duplicateExisting.push({ row: candidate.row, content: candidate.content }); return false; }
      if (inFile.has(key)) { duplicateInFile.push({ row: candidate.row, content: candidate.content }); return false; }
      inFile.add(key); return true;
    });
    if (String(form.get('preview')) === '1') {
      return Response.json({ preview: true, totalRows: parsed.totalRows, validRows: parsed.candidates.length, willImport: importable.length, blankRows: parsed.blankRows, duplicateExisting, duplicateInFile });
    }
    if (String(form.get('confirmImportDuplicates')) !== '1') return Response.json({ error: '请先完成导入预检确认。' }, { status: 400 });
    let imported = 0; let skipped = parsed.blankRows + duplicateExisting.length + duplicateInFile.length; const errors: string[] = [];
    const currentExisting = await existingContentKeys();
    for (const candidate of importable) {
      const key = normalizedContent(candidate.content);
      if (currentExisting.has(key)) { skipped += 1; continue; }
      try {
        await execute('INSERT INTO questions (type_id, content, answer, subcategory, extra, status) VALUES (?, ?, ?, ?, ?, ?)', [typeId, candidate.content, candidate.answer || null, candidate.subcategory || null, candidate.extra, 'active']);
        currentExisting.add(key);
        imported += 1;
      } catch (error) { errors.push(`第 ${candidate.row} 行：${String(error)}`); }
    }
    return Response.json({ imported, skipped, errors: errors.slice(0, 20), totalRows: parsed.totalRows, duplicateExisting: duplicateExisting.length, duplicateInFile: duplicateInFile.length });
  } catch (error) { return apiError(error); }
}
