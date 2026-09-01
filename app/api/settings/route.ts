import { apiError, requireUser } from '@/lib/auth';
import { execute, query } from '@/lib/db';

export async function GET() {
  try {
    const user = await requireUser();
    const rows = await query('SELECT auto_record AS autoRecord, avoid_repeated AS avoidRepeated, read_question AS readQuestion, default_voice_id AS defaultVoiceId, ai_config_id AS aiConfigId FROM user_settings WHERE user_id = ?', [user.id]);
    const row = rows[0] as { autoRecord: number; avoidRepeated: number; readQuestion: number; defaultVoiceId: number | null; aiConfigId: number | null } | undefined;
    const previewRows = await query(`SELECT id, name, provider, model, output_mime AS outputMime
      FROM question_voices
      WHERE kind = 'settings_preview' AND status = 'ready' AND output_path IS NOT NULL
      ORDER BY created_at DESC`);
    const previewIds = new Set(previewRows.map((item) => Number((item as { id: number }).id)));
    const selectedVoiceId = row?.defaultVoiceId == null || !previewIds.has(Number(row.defaultVoiceId)) ? null : Number(row.defaultVoiceId);
    const aiRows = await query('SELECT auto_transcribe AS autoTranscribe FROM ai_settings WHERE id = 1 LIMIT 1');
    const autoTranscribe = Boolean((aiRows[0] as { autoTranscribe?: number } | undefined)?.autoTranscribe);
    const aiConfigRows = await query('SELECT id, name, logo_image_id AS logoImageId FROM ai_model_configs WHERE enabled=1 ORDER BY id ASC');
    const defaultConfigRows = await query('SELECT active_config_id AS id FROM ai_settings WHERE id=1 LIMIT 1');
    const availableAiConfigIds = new Set(aiConfigRows.map((item) => Number((item as { id: number }).id)));
    const selectedAiConfigId = row?.aiConfigId != null && availableAiConfigIds.has(Number(row.aiConfigId)) ? Number(row.aiConfigId) : null;
    if (row?.aiConfigId != null && selectedAiConfigId === null) await execute('UPDATE user_settings SET ai_config_id=NULL WHERE user_id=?', [user.id]);
    const configuredDefaultId = Number((defaultConfigRows[0] as { id?: number } | undefined)?.id || 0);
    const defaultAiConfigId = availableAiConfigIds.has(configuredDefaultId) ? configuredDefaultId : Number((aiConfigRows[0] as { id?: number } | undefined)?.id || 0);
    return Response.json({
      settings: {
        autoRecord: Boolean(row?.autoRecord),
        avoidRepeated: Boolean(row?.avoidRepeated),
        readQuestion: Boolean(row?.readQuestion),
        defaultVoiceId: selectedVoiceId,
        autoTranscribe,
        aiConfigId: selectedAiConfigId,
        defaultAiConfigId,
      },
      voicePreviews: previewRows.map((item) => ({
        id: Number((item as { id: number }).id),
        name: String((item as { name: string }).name),
        provider: String((item as { provider: string }).provider),
        model: String((item as { model: string }).model || ''),
        audioUrl: `/api/question-voices/${Number((item as { id: number }).id)}/audio?kind=output`,
      })),
      aiModelOptions: aiConfigRows.map((item) => {
        const row = item as { id: number; name: string; logoImageId?: number | null };
        const logoImageId = row.logoImageId == null ? null : Number(row.logoImageId);
        return { id: Number(row.id), name: String(row.name), logoImageId, logoUrl: logoImageId ? `/api/ai/model-images/${logoImageId}` : null };
      }),
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function PUT(request: Request) {
  try {
    const user = await requireUser();
    const body = await request.json() as { autoRecord?: boolean; avoidRepeated?: boolean; readQuestion?: boolean; defaultVoiceId?: number | null; aiConfigId?: number | null };
    const autoRecord = Boolean(body.autoRecord);
    const avoidRepeated = Boolean(body.avoidRepeated);
    const readQuestion = Boolean(body.readQuestion);
    const hasVoiceSelection = Object.prototype.hasOwnProperty.call(body, 'defaultVoiceId');
    const hasAiSelection = Object.prototype.hasOwnProperty.call(body, 'aiConfigId');
    const currentRows = await query('SELECT default_voice_id AS defaultVoiceId, ai_config_id AS aiConfigId FROM user_settings WHERE user_id = ?', [user.id]);
    const currentDefaultVoiceId = (currentRows[0] as { defaultVoiceId?: number | null } | undefined)?.defaultVoiceId;
    const currentAiConfigId = (currentRows[0] as { aiConfigId?: number | null } | undefined)?.aiConfigId;
    let aiConfigId = hasAiSelection ? (body.aiConfigId == null ? null : Number(body.aiConfigId)) : (currentAiConfigId == null ? null : Number(currentAiConfigId));
    if (aiConfigId !== null) {
      const modelRows = await query('SELECT id FROM ai_model_configs WHERE id=? AND enabled=1 LIMIT 1', [aiConfigId]);
      if (!modelRows.length) return Response.json({ error: '所选 AI 模型已不可用，已为你保留管理员默认模型。' }, { status: 400 });
    }
    let defaultVoiceId = hasVoiceSelection && body.defaultVoiceId != null ? Number(body.defaultVoiceId) : (currentDefaultVoiceId == null ? null : Number(currentDefaultVoiceId));
    if (defaultVoiceId !== null) {
      if (!Number.isInteger(defaultVoiceId) || defaultVoiceId < 1) return Response.json({ error: '试听音色选择无效。' }, { status: 400 });
      const voiceRows = await query("SELECT id FROM question_voices WHERE id=? AND kind='settings_preview' AND status='ready' AND output_path IS NOT NULL LIMIT 1", [defaultVoiceId]);
      if (!voiceRows.length) {
        if (hasVoiceSelection) return Response.json({ error: '所选试听音色不存在或尚未生成。' }, { status: 400 });
        defaultVoiceId = null;
      }
    }

    await execute(
      'INSERT INTO user_settings (user_id, auto_record, avoid_repeated, read_question, default_voice_id, ai_config_id) VALUES (?, ?, ?, ?, ?, ?)' +
      ' ON DUPLICATE KEY UPDATE auto_record = VALUES(auto_record), avoid_repeated = VALUES(avoid_repeated), read_question = VALUES(read_question), default_voice_id = VALUES(default_voice_id), ai_config_id = VALUES(ai_config_id), updated_at = CURRENT_TIMESTAMP',
      [user.id, autoRecord ? 1 : 0, avoidRepeated ? 1 : 0, readQuestion ? 1 : 0, defaultVoiceId, aiConfigId],
    );
    return Response.json({ settings: { autoRecord, avoidRepeated, readQuestion, defaultVoiceId, aiConfigId } });
  } catch (error) {
    return apiError(error);
  }
}
