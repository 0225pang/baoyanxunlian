import { apiError, requireUser } from "@/lib/auth";
import { execute, query } from "@/lib/db";
import {
  aiRequestError,
  chatCompletionsUrl,
  extractChatContent,
  getActiveAiConfig,
  safeJsonParse,
  samplingParameters,
} from "@/lib/ai";
import { assertApiAccess, logApiUsage, readTokenUsage } from "@/lib/usage";
import { synthesizeConfiguredQuestionVoice } from "@/lib/question-voices";
import type { RowDataPacket } from "mysql2/promise";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id: rawId } = await context.params;
    const sessionId = Number(rawId);
    const body = (await request.json()) as {
      question?: string;
      answer?: string;
      moduleTitle?: string;
      followupRound?: number;
      followupCount?: number;
      priorTurns?: Array<{ question?: string; answer?: string }>;
    };
    const sessions = await query<RowDataPacket[]>(
      "SELECT user_id AS userId, template_id AS templateId FROM simulation_sessions WHERE id = ? LIMIT 1",
      [sessionId],
    );
    if (
      !sessions[0] ||
      (Number(sessions[0].userId) !== user.id && user.role !== "admin")
    )
      return Response.json(
        { error: "模拟场次不存在或无权访问" },
        { status: 404 },
      );
    const config = await getActiveAiConfig();
    if (!config?.apiKey)
      return Response.json(
        { error: "请先在管理后台配置 AI 模型" },
        { status: 503 },
      );
    await assertApiAccess(Number(sessions[0].userId), "ai");
    const templates = await query<RowDataPacket[]>(
      "SELECT followup_prompt AS followupPrompt, dynamic_tts_config AS dynamicTtsConfig FROM simulation_templates WHERE id = ? LIMIT 1",
      [Number(sessions[0].templateId)],
    );
    const prompt = String(
      templates[0]?.followupPrompt ||
        "你是一名食品专业保研面试老师，正在进行真实面试。请结合原题、已完成问答链与当前追问轮次，生成一条自然、具体且不重复的追问。只输出问题本身，不要解释。",
    );
    const priorTurns = Array.isArray(body.priorTurns)
      ? body.priorTurns.slice(-6).map((item) => ({
          question: String(item.question || "").trim(),
          answer: String(item.answer || "").trim(),
        }))
      : [];
    const round = Math.max(1, Number(body.followupRound) || 1);
    const count = Math.min(5, Math.max(round, Number(body.followupCount) || 1));
    const response = await fetch(chatCompletionsUrl(config.baseUrl), {
      method: "POST",
      headers: {
        Authorization: "Bearer " + config.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        ...samplingParameters(config.model, 0.45),
        messages: [
          { role: "system", content: prompt },
          {
            role: "user",
            content:
              "环节：" + String(body.moduleTitle || "") +
              "\n原题：" + String(body.question || "") +
              "\n本次为第 " + round + "/" + count + " 轮追问。" +
              "\n已完成的问答链：\n" + JSON.stringify(priorTurns, null, 2) +
              "\n学员刚完成的回答：" + String(body.answer || ""),
          },
        ],
      }),
    });
    const raw = await response.text();
    if (!response.ok)
      return Response.json(
        { error: aiRequestError(response.status, raw) },
        { status: 502 },
      );
    const payload = safeJsonParse(raw);
    const followup = extractChatContent(payload);
    if (!followup)
      return Response.json({ error: "未生成追问" }, { status: 502 });
    const usage = readTokenUsage(payload);
    await logApiUsage(Number(sessions[0].userId), "ai", {
      inputTokens:
        usage.inputTokens ||
        Math.ceil(
          (prompt + String(body.question || "") + String(body.answer || ""))
            .length / 2,
        ),
      outputTokens: usage.outputTokens || Math.ceil(followup.length / 2),
      model: config.model,
    });
    let audio: { base64: string; mime: string } | null = null;
    let audioError = "";
    try {
      const rawConfig = templates[0]?.dynamicTtsConfig;
      const config = typeof rawConfig === "string" ? JSON.parse(rawConfig || "{}") : rawConfig;
      const generated = await synthesizeConfiguredQuestionVoice(config, followup);
      if (generated) audio = { base64: generated.audio.toString("base64"), mime: generated.mime };
    } catch (error) {
      audioError = error instanceof Error ? error.message.slice(0, 300) : "现场题目语音生成失败";
    }
    return Response.json({ followup, audio, audioError: audioError || undefined });
  } catch (error) {
    return apiError(error);
  }
}
