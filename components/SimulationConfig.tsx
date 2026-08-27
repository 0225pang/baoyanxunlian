'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

type QuestionType = { id: number; code: string; name: string; description?: string | null };
type SimulationStep = { id: string; title: string; kind: 'intro' | 'question' | 'fixed'; typeCode?: string; count?: number; timeSeconds?: number; allowFollowup?: boolean; prompt?: string };
type SimulationTemplate = { id: number; name: string; description: string; totalSeconds: number; modules: SimulationStep[] | string; followupPrompt?: string; isActive?: boolean };
type RealtimeConfig = { provider: string; websocketUrl: string; model: string; apiKey?: string; apiKeySet?: boolean; apiKeyPreview?: string };

const DEFAULT_FOLLOWUP_PROMPT = '你是一名食品专业保研面试老师。请根据当前题目、学员回答以及所在模块，提出一个自然、具体、能检验理解深度的追问。只输出一条追问问题，不要解释。';

async function requestJson(url: string, options?: RequestInit) {
  const response = await fetch(url, options); const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || '请求失败，请稍后重试。');
  return body;
}
function parseModules(value: SimulationTemplate['modules']) {
  try { return (Array.isArray(value) ? value : JSON.parse(value || '[]')) as SimulationStep[]; } catch { return []; }
}

export default function SimulationConfig() {
  const [templates, setTemplates] = useState<SimulationTemplate[]>([]); const [types, setTypes] = useState<QuestionType[]>([]); const [selected, setSelected] = useState<SimulationTemplate | null>(null);
  const [realtime, setRealtime] = useState<RealtimeConfig | null>(null); const [message, setMessage] = useState(''); const [saving, setSaving] = useState(false);
  const load = useCallback(async () => {
    try {
      const [simulationData, typeData] = await Promise.all([requestJson('/api/simulations/config'), requestJson('/api/question-types')]);
      const items = simulationData.templates || []; setTemplates(items); setTypes(typeData.types || []);
      setSelected((current) => current?.id && items.some((item: SimulationTemplate) => item.id === current.id) ? items.find((item: SimulationTemplate) => item.id === current.id) : items[0] || null);
      setRealtime(simulationData.realtimeAsr || null);
    } catch (error) { setMessage((error as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const modules = useMemo(() => selected ? parseModules(selected.modules) : [], [selected]);
  const defaultTypeCode = types[0]?.code || 'professional';
  function updateTemplate(patch: Partial<SimulationTemplate>) { setSelected((current) => current ? { ...current, ...patch } : current); }
  function updateModule(index: number, patch: Partial<SimulationStep>) { if (!selected) return; updateTemplate({ modules: modules.map((item, position) => position === index ? { ...item, ...patch } : item) }); }
  function addModule(kind: SimulationStep['kind']) {
    if (!selected) return;
    const id = `${kind}-${Date.now()}`;
    const item: SimulationStep = kind === 'question'
      ? { id, title: '题库抽题', kind, typeCode: defaultTypeCode, count: 1, timeSeconds: 120, allowFollowup: false }
      : kind === 'fixed'
        ? { id, title: '固定题目', kind, prompt: '请回答以下问题：', count: 1, timeSeconds: 120, allowFollowup: false }
        : { id, title: '中文自我介绍', kind, prompt: '请进行中文自我介绍。', count: 1, timeSeconds: 480, allowFollowup: false };
    updateTemplate({ modules: [...modules, item] });
  }
  function createTemplate() {
    setSelected({ id: 0, name: '新学校面试模拟', description: '请填写该学校的面试流程说明', totalSeconds: 1800, modules: [{ id: 'intro-' + Date.now(), title: '中文自我介绍', kind: 'intro', count: 1, timeSeconds: 480, allowFollowup: false, prompt: '请进行中文自我介绍。' }], followupPrompt: DEFAULT_FOLLOWUP_PROMPT, isActive: true });
  }
  async function saveTemplate() {
    if (!selected) return; setSaving(true); setMessage('');
    try { await requestJson('/api/simulations/config', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ template: { ...selected, followupPrompt: selected.followupPrompt || DEFAULT_FOLLOWUP_PROMPT } }) }); setMessage('模拟流程已保存。'); await load(); }
    catch (error) { setMessage((error as Error).message); } finally { setSaving(false); }
  }
  async function saveRealtime() {
    if (!realtime) return; setSaving(true); setMessage('');
    try { await requestJson('/api/simulations/config', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ realtimeAsr: realtime }) }); setMessage('实时语音识别配置已保存。'); await load(); }
    catch (error) { setMessage((error as Error).message); } finally { setSaving(false); }
  }
  return <section className="simulation-config"><header><span className="section-kicker">SIMULATION BUILDER</span><h2>真实场景模拟</h2><p>每个模块独立设置来源、时长和追问。固定题目直接写入流程；题库抽题从当前题型下拉框选择。</p></header>{message && <div className="management-message" role="status">{message}</div>}<div className="simulation-config-grid"><section className="simulation-builder"><div className="simulation-config-toolbar"><label>选择流程<select value={selected?.id || ''} onChange={(event) => setSelected(templates.find((item) => item.id === Number(event.target.value)) || null)}>{templates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button type="button" className="create-trigger small-trigger" onClick={createTemplate}>新增学校流程</button></div>{selected && <><div className="simulation-template-fields"><label>流程名称<input value={selected.name} onChange={(event) => updateTemplate({ name: event.target.value })} /></label><label>总时长（秒）<input type="number" min="60" value={selected.totalSeconds} onChange={(event) => updateTemplate({ totalSeconds: Math.max(60, Number(event.target.value) || 60) })} /></label></div><label>老师追问提示词<textarea value={selected.followupPrompt || DEFAULT_FOLLOWUP_PROMPT} onChange={(event) => updateTemplate({ followupPrompt: event.target.value })} /></label><small className="field-hint">当模块勾选“本题后进入老师追问”时，系统将把题目和本段回答交给该提示词生成追问。</small><div className="module-puzzle-list">{modules.map((item, index) => <article key={item.id}><b>{String(index + 1).padStart(2, '0')}</b><div className="module-card-grid"><label>模块名称<input value={item.title} onChange={(event) => updateModule(index, { title: event.target.value })} /></label><label>题目来源<select value={item.kind} onChange={(event) => updateModule(index, { kind: event.target.value as SimulationStep['kind'], count: event.target.value === 'question' ? item.count || 1 : 1 })}><option value="intro">自我介绍 / 开场任务</option><option value="fixed">固定题目</option><option value="question">从题库抽题</option></select></label>{item.kind === 'question' ? <><label>题库题型<select value={item.typeCode || defaultTypeCode} onChange={(event) => updateModule(index, { typeCode: event.target.value })}>{types.map((type) => <option key={type.id} value={type.code}>{type.name}</option>)}</select></label><label>抽题数<input type="number" min="1" value={item.count || 1} onChange={(event) => updateModule(index, { count: Math.max(1, Number(event.target.value) || 1) })} /></label></> : <label className="module-prompt">{item.kind === 'fixed' ? '固定题目内容' : '开场提示内容'}<textarea value={item.prompt || ''} placeholder={item.kind === 'fixed' ? '例如：请用英文介绍你的科研经历。' : '例如：请进行中文自我介绍。'} onChange={(event) => updateModule(index, { prompt: event.target.value })} /></label>}<label>建议时长（秒）<input type="number" min="30" value={item.timeSeconds || 120} onChange={(event) => updateModule(index, { timeSeconds: Math.max(30, Number(event.target.value) || 30) })} /></label><label className="module-followup"><input type="checkbox" checked={Boolean(item.allowFollowup)} onChange={(event) => updateModule(index, { allowFollowup: event.target.checked })} /> 本题后进入老师追问</label></div></article>)}</div><div className="simulation-module-actions"><button type="button" className="create-trigger" onClick={() => addModule('fixed')}>添加固定题目</button><button type="button" className="secondary-action" onClick={() => addModule('question')}>添加题库抽题</button><button type="button" className="secondary-action" onClick={() => addModule('intro')}>添加开场任务</button></div><button className="modal-submit" disabled={saving} onClick={() => void saveTemplate()}>{saving ? '保存中…' : '保存模拟流程'}</button></>}</section><section className="realtime-asr-card"><span className="section-kicker">REALTIME ASR</span><h3>实时语音识别 API</h3><p>仅用于真实模拟；普通练习继续使用单独的 Paraformer 转写配置。</p>{realtime && <><label>服务平台<input value={realtime.provider} onChange={(event) => setRealtime({ ...realtime, provider: event.target.value })} /></label><label>WebSocket 地址<input value={realtime.websocketUrl} onChange={(event) => setRealtime({ ...realtime, websocketUrl: event.target.value })} /></label><label>模型名称<input value={realtime.model} onChange={(event) => setRealtime({ ...realtime, model: event.target.value })} /></label><label>API Key {realtime.apiKeySet && <small className="key-preview">当前：{realtime.apiKeyPreview}（留空不修改）</small>}<input type="password" value={realtime.apiKey || ''} onChange={(event) => setRealtime({ ...realtime, apiKey: event.target.value })} placeholder="实时语音识别的 API Key" /></label><button className="modal-submit" disabled={saving} onClick={() => void saveRealtime()}>{saving ? '保存中…' : '保存实时转写配置'}</button></>}</section></div></section>;
}
