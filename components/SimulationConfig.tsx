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
  totalSeconds: number;
  modules: SimulationStep[] | string;
  followupPrompt?: string;
  isActive?: boolean;
};
type RealtimeConfig = {
  provider: string;
  websocketUrl: string;
  model: string;
  apiKey?: string;
  apiKeySet?: boolean;
  apiKeyPreview?: string;
};

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

export default function SimulationConfig() {
  const [templates, setTemplates] = useState<SimulationTemplate[]>([]);
  const [types, setTypes] = useState<QuestionType[]>([]);
  const [selected, setSelected] = useState<SimulationTemplate | null>(null);
  const [realtime, setRealtime] = useState<RealtimeConfig | null>(null);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const load = useCallback(async () => {
    try {
      const [simulationData, typeData] = await Promise.all([
        requestJson("/api/simulations/config"),
        requestJson("/api/question-types"),
      ]);
      const items = simulationData.templates || [];
      setTemplates(items);
      setTypes(typeData.types || []);
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
  function updateTemplate(patch: Partial<SimulationTemplate>) {
    setSelected((current) => (current ? { ...current, ...patch } : current));
  }
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
      isActive: true,
    });
  }
  async function saveTemplate() {
    if (!selected) return;
    setSaving(true);
    setMessage("");
    try {
      await requestJson("/api/simulations/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          template: {
            ...selected,
            followupPrompt: selected.followupPrompt || DEFAULT_FOLLOWUP_PROMPT,
          },
        }),
      });
      setMessage("模拟流程已保存。");
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
                    min="60"
                    value={selected.totalSeconds}
                    onChange={(event) =>
                      updateTemplate({
                        totalSeconds: Math.max(
                          60,
                          Number(event.target.value) || 60,
                        ),
                      })
                    }
                  />
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
                          min="30"
                          value={item.timeSeconds || 120}
                          onChange={(event) =>
                            updateModule(index, {
                              timeSeconds: Math.max(
                                30,
                                Number(event.target.value) || 30,
                              ),
                            })
                          }
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
                <input
                  value={realtime.model}
                  onChange={(event) =>
                    setRealtime({ ...realtime, model: event.target.value })
                  }
                />
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
