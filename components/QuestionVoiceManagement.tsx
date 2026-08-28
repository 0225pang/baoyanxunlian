// @ts-nocheck
'use client';

import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';

type Settings = { publicBaseUrl: string; cloneUrl: string; websocketUrl: string; synthesisUrl: string; apiKey?: string; apiKeySet?: boolean; apiKeyPreview?: string };
type Question = { id: number; content: string; typeName: string };
type Voice = { id: number; questionId: number | null; name: string; kind: 'custom' | 'generated'; status: 'processing' | 'ready' | 'failed'; model?: string; voiceId?: string; hasSource?: boolean; hasOutput: boolean; error?: string };
type VoiceData = { settings: Settings; questions: Question[]; voices: Voice[] };
type SourceMode = 'clone' | 'preset';

const PRESET_MODELS = [
  { model: 'sambert-zhida-v1', voice: 'zhida', label: '知达 · 男声（sambert-zhida-v1）' },
  { model: 'sambert-zhichu-v1', voice: 'zhichu', label: '知厨 · 男声（sambert-zhichu-v1）' },
] as const;

const VOICE_STYLES = [
  ['friendly', '友好面试', '温和亲切的面试老师语气，语速中等，吐字清晰，带有鼓励感。'],
  ['normal', '正常面试', '专业、沉稳的面试老师语气，语速中等，吐字清晰。'],
  ['pressure', '压力面试', '严肃、有力度的面试老师语气，语速偏快但吐字清晰。'],
] as const;

async function requestJson(url: string, options?: RequestInit) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '请求失败，请稍后重试。');
  return data;
}

function presetForModel(model: string) {
  const known = PRESET_MODELS.find((item) => item.model === model);
  if (known) return known.voice;
  // New Sambert models conventionally encode the speaker in their model name:
  // sambert-zhida-v1 -> zhida. No second “system voice” field is needed.
  return model.match(/^sambert-([a-z0-9_-]+)-v\d+$/i)?.[1] || '';
}

export default function QuestionVoiceManagement() {
  const [data, setData] = useState<VoiceData | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [questionId, setQuestionId] = useState('');
  const [sourceMode, setSourceMode] = useState<SourceMode>('clone');
  const [cloneVoiceId, setCloneVoiceId] = useState('');
  const [presetModel, setPresetModel] = useState(PRESET_MODELS[0].model);
  const [customPresetModel, setCustomPresetModel] = useState('');
  const [styleIndex, setStyleIndex] = useState(0);
  const [instruction, setInstruction] = useState(VOICE_STYLES[0][2]);
  const [rate, setRate] = useState('1');
  const [pitch, setPitch] = useState('1');
  const [volume, setVolume] = useState('50');
  const [format, setFormat] = useState('mp3');
  const [extra, setExtra] = useState('{}');
  const [cloneName, setCloneName] = useState('我的复刻音色');
  const [clonePrefix, setClonePrefix] = useState('fishvoice');
  const [cloneModel, setCloneModel] = useState('qwen-audio-3.0-tts-flash');
  const [cloneFile, setCloneFile] = useState<File | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const cancelBatchRef = useRef(false);

  const load = async () => {
    const next = await requestJson('/api/question-voices') as VoiceData;
    setData(next);
    setSettings(next.settings);
    setQuestionId((value) => value || String(next.questions[0]?.id || ''));
  };

  useEffect(() => { void load().catch((error: Error) => setMessage(error.message)); }, []);

  const clonedVoices = useMemo(() => data?.voices.filter((voice) => voice.kind === 'custom' && voice.status === 'ready' && voice.voiceId) || [], [data]);
  const currentAudio = useMemo(() => data?.voices.filter((voice) => voice.kind === 'generated' && voice.questionId === Number(questionId)) || [], [data, questionId]);
  const characterCount = useMemo(() => data?.questions.reduce((total, question) => total + question.content.length, 0) || 0, [data]);
  const activePresetModel = presetModel === '__custom__' ? customPresetModel.trim() : presetModel;
  const automaticPresetVoice = presetForModel(activePresetModel);
  const selectedVoiceId = sourceMode === 'clone' ? cloneVoiceId : automaticPresetVoice;
  const selectedModel = sourceMode === 'clone' ? 'qwen-audio-3.0-tts-flash' : activePresetModel;
  const canGenerate = Boolean(questionId && selectedModel && selectedVoiceId && !busy);

  function buildPayload(id: number) {
    let additionalParameters: Record<string, unknown>;
    try {
      const parsed = JSON.parse(extra || '{}');
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error();
      additionalParameters = parsed;
    } catch { throw new Error('额外参数必须是合法的 JSON 对象。'); }

    const parameters: Record<string, unknown> = {
      ...additionalParameters,
      profileCode: VOICE_STYLES[styleIndex][0], profileName: VOICE_STYLES[styleIndex][1],
      speech_rate: Number(rate) || 1, pitch_rate: Number(pitch) || 1, volume: Number(volume) || 50, format,
    };
    // Instruction is a Qwen-Audio-TTS feature. Do not send it to Sambert.
    if (sourceMode === 'clone' && instruction.trim()) parameters.instruction = instruction.trim();
    return { action: 'synthesize', questionId: id, name: `${VOICE_STYLES[styleIndex][1]} · 题目朗读`, model: selectedModel, voiceId: selectedVoiceId, parameters };
  }

  async function synthesize(id: number) {
    return requestJson('/api/question-voices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildPayload(id)) });
  }

  async function generateCurrent() {
    setBusy(true);
    try { const result = await synthesize(Number(questionId)); setData(result.state); setMessage(result.skipped ? '已有同一风格的配音，已跳过。' : '题目配音已生成。'); }
    catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }

  async function generateAll() {
    if (!data || !selectedVoiceId) return;
    if (!confirm(`将处理 ${data.questions.length} 道题，约 ${characterCount} 字，预估约 ¥${(characterCount / 10000).toFixed(2)}。已有相同风格配音会自动跳过。`)) return;
    cancelBatchRef.current = false; setBusy(true);
    try {
      for (let index = 0; index < data.questions.length && !cancelBatchRef.current; index += 1) {
        setMessage(`正在生成 ${index + 1}/${data.questions.length}，可点击“取消批量配音”。`);
        const result = await synthesize(data.questions[index].id); setData(result.state);
      }
      setMessage(cancelBatchRef.current ? '已请求取消；当前题完成后已停止，已生成音频会保留。' : '批量配音完成。');
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }

  async function deleteVoice(id: number) {
    if (!confirm('确定删除这条语音记录及其本地音频文件吗？')) return;
    try { const result = await requestJson(`/api/question-voices?id=${id}`, { method: 'DELETE' }); setData(result); setMessage('已删除。'); }
    catch (error) { setMessage((error as Error).message); }
  }

  async function retryClone(id: number) {
    setBusy(true);
    try {
      const result = await requestJson('/api/question-voices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'retry-clone', id }) });
      setData(result.state); setMessage('已重新创建复刻音色。');
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }

  async function uploadClone() {
    if (!cloneFile) { setMessage('请先选择用于复刻的声音样本。'); return; }
    setBusy(true);
    try {
      const form = new FormData();
      form.set('action', 'clone'); form.set('name', cloneName); form.set('prefix', clonePrefix); form.set('targetModel', cloneModel); form.set('audio', cloneFile);
      const response = await fetch('/api/question-voices', { method: 'POST', body: form }); const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || '上传或复刻失败。');
      setData(result.state); setCloneFile(null); setMessage(`复刻音色创建成功：${result.voiceId}`);
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }

  async function saveSettings() {
    if (!settings) return;
    setBusy(true);
    try {
      const result = await requestJson('/api/question-voices', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings }) });
      setData(result); setSettings(result.settings); setMessage('语音服务配置已保存。');
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }

  if (!data || !settings) return <div className="voice-loading">加载题目语音管理…</div>;

  return <section className="voice-management">
    <header><h2>题目语音管理</h2><p>复刻音色和 Sambert 预设音色分开管理。题目配音仅保存在本机挂载卷，不会改变现有浏览器朗读功能。</p></header>
    {message && <div className="management-message">{message}</div>}

    <details className="voice-service-details">
      <summary>展开百炼语音服务配置 <small>Qwen 复刻与 Sambert 合成共用 Workspace WebSocket</small></summary>
      <section className="voice-settings-card"><div className="voice-settings-grid">
        <label>公网访问地址<input value={settings.publicBaseUrl} onChange={(event) => setSettings({ ...settings, publicBaseUrl: event.target.value })} placeholder="http://服务器IP:端口" /></label>
        <label>声音复刻 REST API<input value={settings.cloneUrl} onChange={(event) => setSettings({ ...settings, cloneUrl: event.target.value })} placeholder="https://{WorkspaceId}.cn-beijing.../customization" /></label>
        <label className="wide">百炼 Workspace WebSocket（Qwen 与 Sambert 均使用）<input value={settings.websocketUrl} onChange={(event) => setSettings({ ...settings, websocketUrl: event.target.value })} placeholder="wss://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference" /></label>
        <label className="wide">旧版 HTTP 合成地址（可留空，当前优先使用上方 WebSocket）<input value={settings.synthesisUrl} onChange={(event) => setSettings({ ...settings, synthesisUrl: event.target.value })} /></label>
        <label>百炼 API Key<input type="password" value={settings.apiKey || ''} placeholder={settings.apiKeySet ? `已保存：${settings.apiKeyPreview || '已隐藏'}` : '输入后保存'} onChange={(event) => setSettings({ ...settings, apiKey: event.target.value })} /></label>
      </div><button className="voice-save" onClick={() => void saveSettings()} disabled={busy}>保存配置</button></section>
    </details>

    <section className="voice-workbench">
      <section className="voice-action-card clone"><h3>声音来源</h3><div className="voice-mode-tabs">
        <button type="button" className={sourceMode === 'clone' ? 'active' : ''} onClick={() => setSourceMode('clone')}>复刻音色</button>
        <button type="button" className={sourceMode === 'preset' ? 'active' : ''} onClick={() => setSourceMode('preset')}>预设音色</button>
      </div>
      {sourceMode === 'clone' ? <label>选择已复刻的 voice ID<select value={cloneVoiceId} onChange={(event) => setCloneVoiceId(event.target.value)}><option value="">请选择复刻音色</option>{clonedVoices.map((voice) => <option key={voice.id} value={voice.voiceId}>{voice.name} · {voice.voiceId}</option>)}</select></label> : <>
        <label>Sambert 预设模型<select value={presetModel} onChange={(event) => setPresetModel(event.target.value)}>{PRESET_MODELS.map((preset) => <option key={preset.model} value={preset.model}>{preset.label}</option>)}<option value="__custom__">其他已开通的 Sambert 模型…</option></select></label>
        {presetModel === '__custom__' && <label>Sambert 模型名称<input value={customPresetModel} onChange={(event) => setCustomPresetModel(event.target.value)} placeholder="例如 sambert-xxx-v1" /></label>}
        <small className="voice-helper">系统自动映射音色：<code>{activePresetModel || 'sambert-xxx-v1'}</code> → <code>{automaticPresetVoice || 'xxx'}</code>。不需要，也不能填写复刻 voice ID。</small>
      </>}
      </section>

      <section className="voice-action-card"><h3>声音参数</h3>
        <label>风格<select value={styleIndex} onChange={(event) => { const index = Number(event.target.value); setStyleIndex(index); setInstruction(VOICE_STYLES[index][2]); }}>{VOICE_STYLES.map((style, index) => <option key={style[0]} value={index}>{style[1]}</option>)}</select></label>
        {sourceMode === 'clone' ? <label>Qwen 指令 instruction<textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} /></label> : <p>Sambert 是预定义音色模型，不发送 Qwen 的自然语言 instruction；仅使用下列音频参数。</p>}
        <div className="voice-parameters"><label>语速<input type="number" min="0.5" max="2" step="0.05" value={rate} onChange={(event) => setRate(event.target.value)} /></label><label>音调<input type="number" min="0.5" max="2" step="0.05" value={pitch} onChange={(event) => setPitch(event.target.value)} /></label><label>音量<input type="number" min="0" max="100" value={volume} onChange={(event) => setVolume(event.target.value)} /></label><label>格式<select value={format} onChange={(event) => setFormat(event.target.value)}><option value="mp3">MP3</option><option value="wav">WAV</option></select></label></div>
        <label>额外参数 JSON<textarea value={extra} onChange={(event) => setExtra(event.target.value)} placeholder='例如 {"bit_rate":128}' /></label>
      </section>

      <section className="voice-action-card generate"><h3>生成配音</h3>
        <label>题目<select value={questionId} onChange={(event) => setQuestionId(event.target.value)}>{data.questions.map((question) => <option key={question.id} value={question.id}>{question.typeName} · {question.content.slice(0, 42)}</option>)}</select></label>
        <button type="button" disabled={!canGenerate} onClick={() => void generateCurrent()}>为当前题目生成</button>
        {busy ? <button type="button" className="voice-batch" onClick={() => { cancelBatchRef.current = true; setMessage('将在当前题完成后取消批量任务。'); }}>取消批量配音</button> : <button type="button" className="voice-batch" disabled={!selectedVoiceId} onClick={() => void generateAll()}>一键为全部题目配音</button>}
        <small>{data.questions.length} 道题，约 {characterCount} 字；按 ¥1 / 1 万字估算约 ¥{(characterCount / 10000).toFixed(2)}。</small>
      </section>
    </section>

    <section className="voice-workbench"><section className="voice-action-card clone"><h3>创建复刻音色</h3><p>仅需创建一次。样本会保存在服务器本地，并通过当前公网地址暂时提供给百炼读取。</p>
      <label>名称<input value={cloneName} onChange={(event) => setCloneName(event.target.value)} /></label><label>音色前缀<input value={clonePrefix} onChange={(event) => setClonePrefix(event.target.value)} /></label><label>目标 Qwen 模型<input value={cloneModel} onChange={(event) => setCloneModel(event.target.value)} /></label><label>声音样本<input type="file" accept="audio/*" onChange={(event: ChangeEvent<HTMLInputElement>) => setCloneFile(event.target.files?.[0] || null)} /></label><button type="button" disabled={busy || !cloneFile} onClick={() => void uploadClone()}>上传并创建复刻音色</button>
    </section></section>

    <VoiceLibrary title="当前题目的配音" count={currentAudio.length}>{currentAudio.length === 0 ? <p className="voice-helper">当前题目还没有生成配音。</p> : currentAudio.map((voice) => <VoiceCard key={voice.id} voice={voice} onDelete={deleteVoice} />)}</VoiceLibrary>
    <VoiceLibrary title="复刻音色库" count={data.voices.filter((voice) => voice.kind === 'custom').length}>{data.voices.filter((voice) => voice.kind === 'custom').map((voice) => <VoiceCard key={voice.id} voice={voice} onDelete={deleteVoice} onRetry={retryClone} busy={busy} />)}</VoiceLibrary>
  </section>;
}

function VoiceLibrary({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return <section className="voice-library"><div className="voice-library-head"><h3>{title}</h3><small>{count} 条</small></div><div className="voice-list">{children}</div></section>;
}

function VoiceCard({ voice, onDelete, onRetry, busy }: { voice: Voice; onDelete: (id: number) => void; onRetry?: (id: number) => void; busy?: boolean }) {
  const status = voice.status === 'ready' ? '可播放' : voice.status === 'failed' ? '失败' : '生成中';
  const audioKind = voice.kind === 'custom' ? 'source' : 'output';
  return <article><header><div><strong>{voice.name}</strong><span className={`voice-status ${voice.status}`}>{status}</span></div><button type="button" className="voice-delete" onClick={() => onDelete(voice.id)}>删除</button></header>
    <dl><div><dt>模型</dt><dd>{voice.model || '—'}</dd></div><div><dt>{voice.kind === 'custom' ? 'voice ID' : '音色'}</dt><dd><code>{voice.voiceId || '等待返回'}</code></dd></div></dl>
    {((voice.kind === 'custom' && voice.hasSource) || (voice.kind === 'generated' && voice.hasOutput)) && <div className="voice-preview"><span>{voice.kind === 'custom' ? '原始样本' : '试听'}</span><audio controls src={`/api/question-voices/${voice.id}/audio?kind=${audioKind}`} /></div>}
    {voice.status === 'failed' && voice.kind === 'custom' && voice.hasSource && onRetry && <button type="button" className="voice-batch" disabled={busy} onClick={() => onRetry(voice.id)}>使用原样本重试</button>}
    {voice.error && <p className="voice-error">{voice.error}</p>}
  </article>;
}
