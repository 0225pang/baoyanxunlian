import { apiError, requireUser } from '@/lib/auth';
import { execute, query } from '@/lib/db';

export async function GET() {
  try {
    const user = await requireUser();
    const rows = await query('SELECT auto_record AS autoRecord, avoid_repeated AS avoidRepeated, read_question AS readQuestion, default_voice_id AS defaultVoiceId FROM user_settings WHERE user_id = ?', [user.id]);
    const row = rows[0] as { autoRecord: number; avoidRepeated: number; readQuestion: number; defaultVoiceId: number | null } | undefined;
    const previewRows = await query(`SELECT id, name, provider, model, output_mime AS outputMime
      FROM question_voices
      WHERE kind = 'settings_preview' AND status = 'ready' AND output_path IS NOT NULL
      ORDER BY created_at DESC`);
    const previewIds = new Set(previewRows.map((item) => Number((item as { id: number }).id)));
    const selectedVoiceId = row?.defaultVoiceId == null || !previewIds.has(Number(row.defaultVoiceId)) ? null : Number(row.defaultVoiceId);
    const aiRows = await query('SELECT auto_transcribe AS autoTranscribe FROM ai_settings WHERE id = 1 LIMIT 1');
    const autoTranscribe = Boolean((aiRows[0] as { autoTranscribe?: number } | undefined)?.autoTranscribe);
    return Response.json({
      settings: {
        autoRecord: Boolean(row?.autoRecord),
        avoidRepeated: Boolean(row?.avoidRepeated),
        readQuestion: Boolean(row?.readQuestion),
        defaultVoiceId: selectedVoiceId,
        autoTranscribe,
      },
      voicePreviews: previewRows.map((item) => ({
        id: Number((item as { id: number }).id),
        name: String((item as { name: string }).name),
        provider: String((item as { provider: string }).provider),
        model: String((item as { model: string }).model || ''),
        audioUrl: `/api/question-voices/${Number((item as { id: number }).id)}/audio?kind=output`,
      })),
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function PUT(request: Request) {
  try {
    const user = await requireUser();
    const body = await request.json() as { autoRecord?: boolean; avoidRepeated?: boolean; readQuestion?: boolean; defaultVoiceId?: number | null };
    const autoRecord = Boolean(body.autoRecord);
    const avoidRepeated = Boolean(body.avoidRepeated);
    const readQuestion = Boolean(body.readQuestion);
    const hasVoiceSelection = Object.prototype.hasOwnProperty.call(body, 'defaultVoiceId');
    const currentRows = await query('SELECT default_voice_id AS defaultVoiceId FROM user_settings WHERE user_id = ?', [user.id]);
    const currentDefaultVoiceId = (currentRows[0] as { defaultVoiceId?: number | null } | undefined)?.defaultVoiceId;
    let defaultVoiceId = hasVoiceSelection && body.defaultVoiceId != null ? Number(body.defaultVoiceId) : (currentDefaultVoiceId == null ? null : Number(currentDefaultVoiceId));
    if (defaultVoiceId !== null) {
      if (!Number.isInteger(defaultVoiceId) || defaultVoiceId < 1) return Response.json({ error: '试听音色选择无效。' }, { status: 400 });
      const voiceRows = await query("SELECT id FROM question_voices WHERE id=? AND kind='settings_preview' AND status='ready' AND output_path IS NOT NULL LIMIT 1", [defaultVoiceId]);
      if (!voiceRows.length) return Response.json({ error: '所选试听音色不存在或尚未生成。' }, { status: 400 });
    }

    await execute(
      'INSERT INTO user_settings (user_id, auto_record, avoid_repeated, read_question, default_voice_id) VALUES (?, ?, ?, ?, ?)' +
      ' ON DUPLICATE KEY UPDATE auto_record = VALUES(auto_record), avoid_repeated = VALUES(avoid_repeated), read_question = VALUES(read_question), default_voice_id = VALUES(default_voice_id), updated_at = CURRENT_TIMESTAMP',
      [user.id, autoRecord ? 1 : 0, avoidRepeated ? 1 : 0, readQuestion ? 1 : 0, defaultVoiceId],
    );
    return Response.json({ settings: { autoRecord, avoidRepeated, readQuestion, defaultVoiceId } });
  } catch (error) {
    return apiError(error);
  }
}
