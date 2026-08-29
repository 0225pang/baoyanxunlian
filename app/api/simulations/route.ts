import { apiError, requireUser } from "@/lib/auth";
import { execute, query } from "@/lib/db";
import type { RowDataPacket } from "mysql2/promise";

type Module = {
  id: string;
  title: string;
  kind: "intro" | "question" | "fixed" | "dynamic";
  typeCode?: string;
  count?: number;
  timeSeconds?: number;
  allowFollowup?: boolean;
  followupCount?: number;
  prompt?: string;
};

function voiceUrl(voiceId: unknown) { return voiceId ? `/api/question-voices/${Number(voiceId)}/audio?kind=output` : null; }

export async function GET() {
  try {
    await requireUser();
    const templates = await query(
      "SELECT id, name, description, modules, total_seconds AS totalSeconds, module_timeout_mode AS moduleTimeoutMode FROM simulation_templates WHERE is_active = 1 ORDER BY id ASC",
    );
    return Response.json({ templates });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = (await request.json()) as { templateId?: number };
    const rows = await query<RowDataPacket[]>(
      "SELECT id, name, modules, total_seconds AS totalSeconds, module_timeout_mode AS moduleTimeoutMode, dynamic_tts_config AS dynamicTtsConfig FROM simulation_templates WHERE id = ? AND is_active = 1 LIMIT 1",
      [Number(body.templateId)],
    );
    const template = rows[0];
    if (!template)
      return Response.json(
        { error: "模拟模板不存在或未启用" },
        { status: 404 },
      );
    const modules = (
      typeof template.modules === "string"
        ? JSON.parse(template.modules)
        : template.modules
    ) as Module[];
    const steps: Array<
      Module & {
        templateModuleId?: string;
        questionId?: number;
        questionVoiceUrl?: string | null;
        question?: string;
        category?: string;
        subcategory?: string | null;
      }
    > = [];
    for (const module of modules) {
      const count = Math.max(1, Number(module.count) || 1);
      for (let index = 0; index < count; index += 1) {
        if (module.kind === "intro" || module.kind === "fixed") {
          const prompt = String(module.prompt || "").trim();
          if (!prompt)
            return Response.json(
              { error: "固定题目或开场任务缺少题目内容，请在模拟配置中补充" },
              { status: 400 },
            );
          steps.push({
            ...module,
            id: module.id + "-" + index,
            question: prompt,
            category: module.kind === "fixed" ? "固定题目" : "开场任务",
          });
          continue;
        }
        if (module.kind === "dynamic") {
          steps.push({
            ...module,
            id: module.id + "-" + index,
            templateModuleId: module.id,
            category: "AI 动态提问",
          });
          continue;
        }
        const questions = await query<RowDataPacket[]>(
          `SELECT q.id, q.content, q.answer AS referenceAnswer, q.subcategory, t.name AS category,
          (SELECT v.id FROM question_voices v WHERE v.question_id=q.id AND v.kind='generated' AND v.status='ready' AND v.output_path IS NOT NULL ORDER BY RAND() LIMIT 1) AS questionVoiceId
          FROM questions q JOIN question_types t ON t.id = q.type_id WHERE q.status = 'active' AND t.code = ? ORDER BY RAND() LIMIT 1`,
          [module.typeCode || "professional"],
        );
        if (!questions[0])
          return Response.json(
            {
              error:
                "题库中没有“" +
                module.title +
                "”可抽取的题目，请先补充该题型题目",
            },
            { status: 400 },
          );
        const question = questions[0];
        steps.push({
          ...module,
          id: module.id + "-" + index,
          questionId: Number(question.id),
          questionVoiceUrl: voiceUrl(question.questionVoiceId),
          question: String(question.content),
          category: String(question.category),
          subcategory: question.subcategory
            ? String(question.subcategory)
            : null,
        });
      }
    }
    const result = await execute(
      "INSERT INTO simulation_sessions (user_id, template_id, template_name, total_seconds) VALUES (?, ?, ?, ?)",
      [
        user.id,
        Number(template.id),
        String(template.name),
        Number(template.totalSeconds),
      ],
    );
    return Response.json(
      {
        sessionId: Number(result.insertId),
        template: {
          id: Number(template.id),
          name: template.name,
          totalSeconds: Number(template.totalSeconds),
          moduleTimeoutMode: ["immediate_advance", "auto_advance"].includes(String(template.moduleTimeoutMode)) ? template.moduleTimeoutMode : "warn",
          dynamicTtsConfig: typeof template.dynamicTtsConfig === 'string' ? JSON.parse(template.dynamicTtsConfig || '{}') : (template.dynamicTtsConfig || { provider: 'browser' }),
        },
        steps,
      },
      { status: 201 },
    );
  } catch (error) {
    return apiError(error);
  }
}
