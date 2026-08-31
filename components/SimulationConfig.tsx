"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type QuestionType = {
  id: number;
  code: string;
  name: string;
  description?: string | null;
};
type SimulationStep = {
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
type SimulationTemplate = {
  id: number;
  name: string;
  description: string;
  totalSeconds: number | null;
  moduleTimeoutMode?: "warn" | "immediate_advance" | "auto_advance";
  dynamicTtsConfig?: DynamicTtsConfig | string;
  modules: SimulationStep[] | string;
  followupPrompt?: string;
  isActive?: boolean;
};
type DynamicTtsConfig = { provider: "browser" | "baidu" | "bailian"; sourceMode?: "sambert" | "clone"; model?: string; voiceId?: string; per?: number; rate?: number; pitch?: number; volume?: number };
type CloneVoice = { id: number; name: string; model: string; voiceId: string | null; kind: string; provider: string; status: string };
type RealtimeConfig = {
  provider: string;
  websocketUrl: string;
  workspaceId?: string;
  model: string;
  apiKey?: string;
  apiKeySet?: boolean;
  apiKeyPreview?: string;
};

const REALTIME_ASR_MODELS = [
  { value: "qwen-audio-3.0-asr-flash-streaming", label: "Qwen Audio 3.0 ASR Flash（流式）" },
  { value: "paraformer-realtime-v2", label: "Paraformer Realtime v2" },
  { value: "paraformer-realtime-v1", label: "Paraformer Realtime v1（16 kHz）" },
];
const PARAFORMER_WORKSPACE_URL = (workspaceId: string) =>
  workspaceId.trim()
    ? `wss://${workspaceId.trim()}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference`
    : "";

const DEFAULT_FOLLOWUP_PROMPT =
  "你是一名食品专业保研面试老师，正在进行真实面试。请根据原题、学员的全部已作答内容、当前追问轮次和所在模块，只生成一条自然、具体、可继续作答的老师追问。第 1 轮优先核验核心观点、事实依据或表达中的模糊处；后续轮次要么沿同一问题继续深入，要么换一个能补足判断的信息角度。不得重复已问问题，不要评价、提示、编号或解释，只输出追问问题本身。";
const DEFAULT_DYNAMIC_QUESTION_PROMPT =
  "你是一名食品专业保研面试老师。请根据学员在本场面试此前完成的自我介绍、科研项目介绍及其他回答，设计一条适合“自由交流”环节的具体问题。优先追问其研究经历、项目细节、方法选择、结果意义或与食品专业的关联；若信息不足，可提出一条能了解研究兴趣与学术潜力的问题。只输出一条自然的面试问题，不要解释。";

async function requestJson(url: string, options?: RequestInit) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "请求失败，请稍后重试。");
  return body;
}
function parseModules(value: SimulationTemplate["modules"]) {
  try {
    return (
      Array.isArray(value) ? value : JSON.parse(value || "[]")
    ) as SimulationStep[];
  } catch {
    return [];
  }
}
function parseDynamicTts(value: SimulationTemplate["dynamicTtsConfig"]): DynamicTtsConfig {
  try { const item = typeof value === "string" ? JSON.parse(value || "{}") : value || {}; const sourceMode = item.sourceMode === "clone" ? "clone" : "sambert"; return { provider: ["browser", "baidu", "bailian"].includes(String(item.provider)) ? item.provider : "browser", sourceMode, model: String(item.model || (sourceMode === "clone" ? "qwen-audio-3.0-tts-flash" : "sambert-zhida-v1")), voiceId: String(item.voiceId || ""), per: Number(item.per) || 1, rate: Number(item.rate) || 1, pitch: Number(item.pitch) || 1, volume: Number(item.volume) || 50 }; } catch { return { provider: "browser", sourceMode: "sambert", model: "sambert-zhida-v1", voiceId: "", per: 1, rate: 1, pitch: 1, volume: 50 }; }
}

export default function SimulationConfig() {
  const [templates, setTemplates] = useState<SimulationTemplate[]>([]);
  const [types, setTypes] = useState<QuestionType[]>([]);
  const [cloneVoices, setCloneVoices] = useState<CloneVoice[]>([]);
  const [selected, setSelected] = useState<SimulationTemplate | null>(null);
  const [realtime, setRealtime] = useState<RealtimeConfig | null>(null);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const load = useCallback(async () => {
    try {
      const [simulationData, typeData, voiceData] = await Promise.all([
        requestJson("/api/simulations/config"),
        requestJson("/api/question-types"),
        requestJson("/api/question-voices"),
      ]);
      const items = simulationData.templates || [];
      setTemplates(items);
      setTypes(typeData.types || []);
      setCloneVoices((voiceData.voices || []).filter((voice: CloneVoice) => voice.provider === "bailian" && voice.kind === "custom" && voice.status === "ready" && voice.voiceId));
      setSelected((current) =>
        current?.id &&
        items.some((item: SimulationTemplate) => item.id === current.id)
          ? items.find((item: SimulationTemplate) => item.id === current.id)
          : items[0] || null,
      );
      setRealtime(simulationData.realtimeAsr || null);
    } catch (error) {
      setMessage((error as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const modules = useMemo(
    () => (selected ? parseModules(selected.modules) : []),
    [selected],
  );
  const defaultTypeCode = types[0]?.code || "professional";
  const dynamicTts = useMemo(() => selected ? parseDynamicTts(selected.dynamicTtsConfig) : parseDynamicTts(undefined), [selected]);
  function updateTemplate(patch: Partial<SimulationTemplate>) {
    setSelected((current) => (current ? { ...current, ...patch } : current));
  }
  function updateDynamicTts(patch: Partial<DynamicTtsConfig>) { updateTemplate({ dynamicTtsConfig: { ...dynamicTts, ...patch } }); }
  function updateModule(index: number, patch: Partial<SimulationStep>) {
    if (!selected) return;
    updateTemplate({
      modules: modules.map((item, position) =>
        position === index ? { ...item, ...patch } : item,
      ),
    });
  }
  function removeModule(index: number) {
    if (modules.length <= 1) {
      setMessage("模拟流程至少需要保留一个模块。");
      return;
    }
    updateTemplate({
      modules: modules.filter((_item, position) => position !== index),
    });
  }
  function addModule(kind: SimulationStep["kind"]) {
    if (!selected) return;
    const id = `${kind}-${Date.now()}`;
    const item: SimulationStep =
      kind === "question"
        ? {
            id,
            title: "题库抽题",
            kind,
            typeCode: defaultTypeCode,
            count: 1,
            timeSeconds: 120,
            allowFollowup: false,
          }
        : kind === "fixed"
          ? {
              id,
              title: "固定题目",
              kind,
              prompt: "请回答以下问题：",
              count: 1,
              timeSeconds: 120,
              allowFollowup: false,
            }
          : kind === "dynamic"
            ? {
                id,
                title: "自由交流",
                kind,
                prompt: DEFAULT_DYNAMIC_QUESTION_PROMPT,
                count: 1,
                timeSeconds: 180,
                allowFollowup: true,
                followupCount: 1,
              }
            : {
                id,
                title: "中文自我介绍",
                kind,
                prompt: "请进行中文自我介绍。",
                count: 1,
                timeSeconds: 480,
                allowFollowup: false,
                followupCount: 1,
              };
    updateTemplate({ modules: [...modules, item] });
  }
  function createTemplate() {
    setSelected({
      id: 0,
      name: "新学校面试模拟",
      description: "请填写该学校的面试流程说明",
      totalSeconds: 1800,
      modules: [
        {
          id: "intro-" + Date.now(),
          title: "中文自我介绍",
          kind: "intro",
          count: 1,
          timeSeconds: 480,
          allowFollowup: false,
          followupCount: 1,
          prompt: "请进行中文自我介绍。",
        },
      ],
      followupPrompt: DEFAULT_FOLLOWUP_PROMPT,
      dynamicTtsConfig: { provider: "browser", sourceMode: "sambert", model: "sambert-zhida-v1", voiceId: "", per: 1, rate: 1, pitch: 1, volume: 50 },
      isActive: true,
    });
  }
  async function saveTemplate() {
    if (!selected) return;
    setSaving(true);
    setMessage("");
    try {
      const saved = await requestJson("/api/simulations/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          template: {
            ...selected,
            followupPrompt: selected.followupPrompt || DEFAULT_FOLLOWUP_PROMPT,
          },
        }),
      });
      const savedTemplateId = Number(selected.id) || Number((saved.templates || []).find((item: SimulationTemplate) => item.name === selected.name)?.id);
      if (savedTemplateId) {
        setMessage("模拟流程已保存，正在按当前配置预生成固定题音频…");
        try {
          const sync = await requestJson(`/api/simulations/config/${savedTemplateId}/sync-fixed-voices`, { method: "POST" });
          if (sync.browser) setMessage("模拟流程已保存。当前使用浏览器朗读，未新增固定题音频；已有同文本配音仍会随机播放。");
          else setMessage(`模拟流程已保存。固定题音频：新增 ${Number(sync.generated) || 0} 条，已存在 ${Number(sync.skipped) || 0} 条，失败 ${Number(sync.failed) || 0} 条。`);
        } catch (error) {
          setMessage(`模拟流程已保存，但固定题音频预生成未完成：${(error as Error).message}`);
        }
      } else setMessage("模拟流程已保存，但未能定位流程 ID，固定题音频暂未预生成。");
      await load();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function removeTemplate() {
    if (!selected) return;
    if (!selected.id) {
      setSelected(templates[0] || null);
      return;
    }
    if (
      !window.confirm(
        `确定删除“${selected.name}”吗？已完成的真实模拟记录会继续保留。`,
      )
    )
      return;
    setSaving(true);
    setMessage("");
    try {
      await requestJson("/api/simulations/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deleteTemplateId: selected.id }),
      });
      setMessage("模拟流程已删除，历史记录已保留。");
      await load();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function saveRealtime() {
    if (!realtime) return;
    setSaving(true);
    setMessage("");
    try {
      await requestJson("/api/simulations/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ realtimeAsr: realtime }),
      });
      setMessage("实时语音识别配置已保存。");
      await load();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="simulation-config">
      <header>
        <span className="section-kicker">SIMULATION BUILDER</span>
        <h2>真实场景模拟</h2>
        <p>
          每个模块独立设置来源、时长和追问。固定题目直接写入流程；题库抽题从当前题型下拉框选择；自由交流会参考前序回答动态生成问题。
        </p>
      </header>
      {message && (
        <div className="management-message" role="status">
          {message}
        </div>
      )}
      <div className="simulation-config-grid">
        <section className="simulation-builder">
          <div className="simulation-config-toolbar">
            <label>
              选择流程
              <select
                value={selected?.id || ""}
                onChange={(event) =>
                  setSelected(
                    templates.find(
                      (item) => item.id === Number(event.target.value),
                    ) || null,
                  )
                }
              >
                {templates.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="create-trigger small-trigger"
              onClick={createTemplate}
            >
              新增学校流程
            </button>
            {selected?.id ? (
              <button
                type="button"
                className="template-delete"
                disabled={saving}
                onClick={() => void removeTemplate()}
              >
                删除流程
              </button>
            ) : null}
          </div>
          {selected && (
            <>
              <div className="simulation-template-fields">
                <label>
                  流程名称
                  <input
                    value={selected.name}
                    onChange={(event) =>
                      updateTemplate({ name: event.target.value })
                    }
                  />
                </label>
                <label>
                  总时长（秒）
                  <input
                    type="number"
                    step="1"
                    value={selected.totalSeconds ?? ""}
                    onChange={(event) => {
                      const value = event.target.value;
                      updateTemplate({
                        totalSeconds: value === "" ? null : Number(value),
                      });
                    }}
                  />
                </label>
                <label className="template-description">
                  流程说明
                  <textarea
                    value={selected.description || ""}
                    onChange={(event) =>
                      updateTemplate({ description: event.target.value })
                    }
                    placeholder="例如：中文自我介绍、专业课提问与自由交流，全程约 25 分钟。"
                  />
                  <small>显示在学员选择模拟流程的卡片中。</small>
                </label>
                <label className="module-timeout-policy">
                  模块超时策略
                  <select
                    value={selected.moduleTimeoutMode || "warn"}
                    onChange={(event) =>
                      updateTemplate({
                        moduleTimeoutMode: event.target.value as
                          | "warn"
                          | "immediate_advance"
                          | "auto_advance",
                      })
                    }
                  >
                    <option value="warn">仅提示，不自动结束</option>
                    <option value="immediate_advance">
                      达到建议时长后自动进入下一题
                    </option>
                    <option value="auto_advance">
                      超出建议时长 50% 后自动进入下一题
                    </option>
                  </select>
                  <small>
                    此设置作用于本流程所有模块；整场总时长始终为硬上限。
                  </small>
                </label>
              </div>
              <label>
                老师追问提示词
                <textarea
                  value={selected.followupPrompt || DEFAULT_FOLLOWUP_PROMPT}
                  onChange={(event) =>
                    updateTemplate({ followupPrompt: event.target.value })
                  }
                />
              </label>
              <section className="dynamic-tts-config">
                <p className="field-hint">现场 AI 题目和追问会严格使用当前配置实时合成，并保存到本次记录；保存流程时，开场和固定题会按当前配置预生成新音频。文本未变的历史音频始终保留，模拟时会随机播放其中任一条。</p>
                <div><b>现场 AI 题目朗读</b><small>适用于自由交流和老师追问等现场生成的问题；生成的音频会随本次模拟记录保存。</small></div>
                <label>朗读来源<select value={dynamicTts.provider} onChange={(event) => updateDynamicTts({ provider: event.target.value as DynamicTtsConfig["provider"] })}><option value="browser">浏览器朗读（不调用 TTS API）</option><option value="bailian">百炼语音合成</option><option value="baidu">百度短文本合成</option></select></label>
                {dynamicTts.provider === "bailian" && <>
                  <label>百炼音色类型<select value={dynamicTts.sourceMode || "sambert"} onChange={(event) => { const sourceMode = event.target.value as "sambert" | "clone"; const voice = cloneVoices[0]; updateDynamicTts(sourceMode === "clone" ? { sourceMode, model: voice?.model || "qwen-audio-3.0-tts-flash", voiceId: voice?.voiceId || "" } : { sourceMode, model: "sambert-zhida-v1", voiceId: "" }); }}><option value="sambert">Sambert 预设音色</option><option value="clone">已复刻音色</option></select></label>
                  {dynamicTts.sourceMode === "clone" ? <>
                    <label>复刻音色<select value={dynamicTts.voiceId || ""} onChange={(event) => { const voice = cloneVoices.find((item) => item.voiceId === event.target.value); updateDynamicTts({ voiceId: event.target.value, model: voice?.model || dynamicTts.model || "qwen-audio-3.0-tts-flash" }); }}><option value="">请选择已复刻音色</option>{cloneVoices.map((voice) => <option key={voice.id} value={voice.voiceId || ""}>{voice.name} · {voice.model}</option>)}</select><small>{cloneVoices.length ? "复刻音色将使用对应的 Qwen 模型与已保存 voice ID。" : "暂无可用复刻音色，请先在“题目语音管理”完成声音复刻。"}</small></label>
                    <label>Qwen 合成模型<input value={dynamicTts.model || "qwen-audio-3.0-tts-flash"} onChange={(event) => updateDynamicTts({ model: event.target.value })} placeholder="qwen-audio-3.0-tts-flash" /></label>
                  </> : <label>Sambert 模型<input value={dynamicTts.model || "sambert-zhida-v1"} onChange={(event) => updateDynamicTts({ model: event.target.value })} placeholder="sambert-zhida-v1" /></label>}
                  <label>语速<input type="number" min="0.5" max="2" step="0.05" value={dynamicTts.rate ?? 1} onChange={(event) => updateDynamicTts({ rate: Number(event.target.value) || 1 })} /></label><label>音调<input type="number" min="0.5" max="2" step="0.05" value={dynamicTts.pitch ?? 1} onChange={(event) => updateDynamicTts({ pitch: Number(event.target.value) || 1 })} /></label>
                </>}
                {dynamicTts.provider === "baidu" && <label>百度发音人 per<input type="number" min="0" max="50000" value={dynamicTts.per ?? 1} onChange={(event) => updateDynamicTts({ per: Number(event.target.value) || 1 })} /><small>默认 1 为度小宇；可填账号已开通的其他发音人。</small></label>}
              </section>
              <small className="field-hint">
                勾选老师追问后，学员点击“完成回答”会自动保存本段并生成下一轮；未完成配置轮次前，不能进入下一环节。
              </small>
              <div className="module-puzzle-list">
                {modules.map((item, index) => (
                  <article key={item.id}>
                    <button
                      type="button"
                      className="module-remove"
                      aria-label={"删除模块：" + item.title}
                      title="删除此模块"
                      onClick={() => removeModule(index)}
                    >
                      ×
                    </button>
                    <b>{String(index + 1).padStart(2, "0")}</b>
                    <div className="module-card-grid">
                      <label>
                        模块名称
                        <input
                          value={item.title}
                          onChange={(event) =>
                            updateModule(index, { title: event.target.value })
                          }
                        />
                      </label>
                      <label>
                        题目来源
                        <select
                          value={item.kind}
                          onChange={(event) =>
                            updateModule(index, {
                              kind: event.target
                                .value as SimulationStep["kind"],
                              count:
                                event.target.value === "question"
                                  ? item.count || 1
                                  : 1,
                            })
                          }
                        >
                          <option value="intro">自我介绍 / 开场任务</option>
                          <option value="fixed">固定题目</option>
                          <option value="question">从题库抽题</option>
                          <option value="dynamic">
                            AI 动态提问 / 自由交流
                          </option>
                        </select>
                      </label>
                      {item.kind === "question" ? (
                        <>
                          <label>
                            题库题型
                            <select
                              value={item.typeCode || defaultTypeCode}
                              onChange={(event) =>
                                updateModule(index, {
                                  typeCode: event.target.value,
                                })
                              }
                            >
                              {types.map((type) => (
                                <option key={type.id} value={type.code}>
                                  {type.name}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            抽题数
                            <input
                              type="number"
                              min="1"
                              value={item.count || 1}
                              onChange={(event) =>
                                updateModule(index, {
                                  count: Math.max(
                                    1,
                                    Number(event.target.value) || 1,
                                  ),
                                })
                              }
                            />
                          </label>
                        </>
                      ) : (
                        <label className="module-prompt">
                          {item.kind === "fixed"
                            ? "固定题目内容"
                            : item.kind === "dynamic"
                              ? "动态提问提示词"
                              : "开场提示内容"}
                          <textarea
                            value={item.prompt || ""}
                            placeholder={
                              item.kind === "dynamic"
                                ? DEFAULT_DYNAMIC_QUESTION_PROMPT
                                : item.kind === "fixed"
                                  ? "例如：请用英文介绍你的科研经历。"
                                  : "例如：请进行中文自我介绍。"
                            }
                            onChange={(event) =>
                              updateModule(index, {
                                prompt: event.target.value,
                              })
                            }
                          />
                        </label>
                      )}
                      <label>
                        建议时长（秒）
                        <input
                          type="number"
                          step="1"
                          value={item.timeSeconds ?? ""}
                          onChange={(event) => {
                            const value = event.target.value;
                            updateModule(index, {
                              timeSeconds:
                                value === "" ? undefined : Number(value),
                            });
                          }}
                        />
                      </label>
                      <label className="module-followup">
                        <input
                          type="checkbox"
                          checked={Boolean(item.allowFollowup)}
                          onChange={(event) =>
                            updateModule(index, {
                              allowFollowup: event.target.checked,
                              followupCount: event.target.checked
                                ? Math.max(1, Number(item.followupCount) || 1)
                                : 1,
                            })
                          }
                        />{" "}
                        本题后进入老师追问
                      </label>
                      {item.allowFollowup && (
                        <label>
                          老师追问次数
                          <input
                            type="number"
                            min="1"
                            max="5"
                            value={Math.max(1, Number(item.followupCount) || 1)}
                            onChange={(event) =>
                              updateModule(index, {
                                followupCount: Math.min(
                                  5,
                                  Math.max(1, Number(event.target.value) || 1),
                                ),
                              })
                            }
                          />
                        </label>
                      )}
                    </div>
                  </article>
                ))}
              </div>
              <div className="simulation-module-actions">
                <button
                  type="button"
                  className="create-trigger"
                  onClick={() => addModule("fixed")}
                >
                  添加固定题目
                </button>
                <button
                  type="button"
                  className="secondary-action"
                  onClick={() => addModule("question")}
                >
                  添加题库抽题
                </button>
                <button
                  type="button"
                  className="secondary-action"
                  onClick={() => addModule("dynamic")}
                >
                  添加自由交流
                </button>
                <button
                  type="button"
                  className="secondary-action"
                  onClick={() => addModule("intro")}
                >
                  添加开场任务
                </button>
              </div>
              <button
                className="modal-submit"
                disabled={saving}
                onClick={() => void saveTemplate()}
              >
                {saving ? "保存中…" : "保存模拟流程"}
              </button>
            </>
          )}
        </section>
        <section className="realtime-asr-card">
          <span className="section-kicker">REALTIME ASR</span>
          <h3>实时语音识别 API</h3>
          <p>仅用于真实模拟；普通练习继续使用单独的 Paraformer 转写配置。</p>
          {realtime && (
            <>
              <label>
                服务平台
                <input
                  value={realtime.provider}
                  onChange={(event) =>
                    setRealtime({ ...realtime, provider: event.target.value })
                  }
                />
              </label>
              <label>
                百炼业务空间 ID（Paraformer 必填）
                <input
                  value={realtime.workspaceId || ""}
                  onChange={(event) => {
                    const workspaceId = event.target.value.trim();
                    const isParaformer = realtime.model.startsWith("paraformer-realtime-");
                    setRealtime({
                      ...realtime,
                      workspaceId,
                      websocketUrl: isParaformer
                        ? PARAFORMER_WORKSPACE_URL(workspaceId)
                        : realtime.websocketUrl,
                    });
                  }}
                  placeholder="例如：llm-xxxxxxxx"
                />
                <small>Paraformer 仅支持北京地域；填写后会自动使用该业务空间的专属 WebSocket 地址。</small>
              </label>
              <label>
                WebSocket 地址
                <input
                  value={realtime.websocketUrl}
                  onChange={(event) =>
                    setRealtime({
                      ...realtime,
                      websocketUrl: event.target.value,
                    })
                  }
                />
              </label>
              <label>
                模型名称
                <select
                  value={realtime.model}
                  onChange={(event) => {
                    const model = event.target.value;
                    const isParaformer = model.startsWith("paraformer-realtime-");
                    const workspaceUrl = isParaformer
                      ? PARAFORMER_WORKSPACE_URL(realtime.workspaceId || "")
                      : "";
                    setRealtime({
                      ...realtime,
                      model,
                      websocketUrl: workspaceUrl || realtime.websocketUrl,
                    });
                  }}
                >
                  {REALTIME_ASR_MODELS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                API Key{" "}
                {realtime.apiKeySet && (
                  <small className="key-preview">
                    当前：{realtime.apiKeyPreview}（留空不修改）
                  </small>
                )}
                <input
                  type="password"
                  value={realtime.apiKey || ""}
                  onChange={(event) =>
                    setRealtime({ ...realtime, apiKey: event.target.value })
                  }
                  placeholder="实时语音识别的 API Key"
                />
              </label>
              <button
                className="modal-submit"
                disabled={saving}
                onClick={() => void saveRealtime()}
              >
                {saving ? "保存中…" : "保存实时转写配置"}
              </button>
            </>
          )}
        </section>
      </div>
    </section>
  );
}
