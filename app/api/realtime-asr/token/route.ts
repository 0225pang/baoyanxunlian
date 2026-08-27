import { createHmac } from 'node:crypto';
import { apiError, requireUser } from '@/lib/auth';
import { assertApiAccess } from '@/lib/usage';

function sign(value: string, secret: string) {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

export async function POST() {
  try {
    const user = await requireUser();
    await assertApiAccess(user.id, 'realtime_asr');
    const secret = process.env.ASR_AUDIO_TOKEN_SECRET || process.env.DASHSCOPE_API_KEY || process.env.BAILIAN_API_KEY;
    if (!secret) return Response.json({ error: '服务端缺少实时转写令牌密钥' }, { status: 503 });
    const payload = Buffer.from(JSON.stringify({ userId: user.id, expiresAt: Date.now() + 2 * 60 * 1000 })).toString('base64url');
    return Response.json({ token: `${payload}.${sign(payload, secret)}` });
  } catch (error) {
    return apiError(error);
  }
}