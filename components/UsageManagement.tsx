'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

type UsageItem = { inputTokens?: number; outputTokens?: number; audioSeconds?: number; requestCount?: number };
type UsageUserOption = { id: number; username: string; displayName: string };
type ManagedUser = UsageUserOption & {
  aiEnabled: boolean; asrEnabled: boolean; realtimeAsrEnabled: boolean;
  aiTokenLimit: number; asrRequestLimit: number; realtimeSecondsLimit: number;
  usage: Record<string, UsageItem>;
};
type UsageDay = { label: string; aiTokens: number; asrRequests: number; realtimeSeconds: number };
type UsageModel = { model: string; tokens: number; requests: number };
type LeaderboardItem = { rank: number; userId: number; username: string; displayName: string; aiTokens: number; asrRequests: number; realtimeSeconds: number; totalRequests: number };
type UsageResponse = { totals: { aiTokens: number; asrRequests: number; realtimeSeconds: number }; daily: UsageDay[]; modelSeries: UsageModel[]; leaderboard: LeaderboardItem[]; users: UsageUserOption[]; selectedUser: ManagedUser | null };
type Period = '24h' | '7d' | 'all';

const periodLabels: Record<Period, string> = { '24h': '最近 24 小时', '7d': '最近 7 天', all: '全部时间' };
const barColors = ['#2f7d61', '#e58055', '#527cbc', '#9368b8', '#b88930', '#398b97', '#d06a8a', '#61738b'];

async function getJson(url: string, options?: RequestInit) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || '请求失败，请稍后重试。');
  return body;
}
function formatSeconds(value: number) { return value >= 60 ? `${Math.floor(value / 60)} 分 ${Math.round(value % 60)} 秒` : `${Math.round(value)} 秒`; }
function ratio(used: number, limit: number) { return limit > 0 ? Math.min(100, Math.round(used / limit * 100)) : 0; }
function userUsage(user: ManagedUser, kind: 'ai' | 'asr' | 'realtime_asr') {
  if (kind === 'ai') return Number(user.usage.ai?.inputTokens || 0) + Number(user.usage.ai?.outputTokens || 0);
  if (kind === 'asr') return Number(user.usage.asr?.requestCount || 0);
  return Number(user.usage.realtime_asr?.audioSeconds || 0);
}

function TokenTrend({ days, period }: { days: UsageDay[]; period: Period }) {
  const width = 620; const height = 230; const padX = 34; const padY = 24;
  const max = Math.max(1, ...days.map((item) => item.aiTokens));
  const points = days.map((item, index) => `${padX + index * ((width - padX * 2) / Math.max(1, days.length - 1))},${height - padY - item.aiTokens / max * (height - padY * 2)}`).join(' ');
  const total = days.reduce((sum, item) => sum + item.aiTokens, 0);
  return <figure className="usage-chart-card usage-token-chart"><figcaption><div><span>大模型 Token 趋势</span><small>{periodLabels[period]} · 对话、评估和追问</small></div><strong>{total.toLocaleString()} <em>token</em></strong></figcaption><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${periodLabels[period]}大模型 Token 用量折线图`}><title>{periodLabels[period]}合计 {total.toLocaleString()} token</title><line x1={padX} x2={width - padX} y1={padY} y2={padY} /><line x1={padX} x2={width - padX} y1={height / 2} y2={height / 2} /><line x1={padX} x2={width - padX} y1={height - padY} y2={height - padY} /><polyline className="usage-line-fill" points={`${padX},${height - padY} ${points} ${width - padX},${height - padY}`} /><polyline className="usage-line" points={points} />{days.map((item, index) => { const x = padX + index * ((width - padX * 2) / Math.max(1, days.length - 1)); const y = height - padY - item.aiTokens / max * (height - padY * 2); const visibleLabel = days.length <= 8 || index === 0 || index === days.length - 1 || index % Math.ceil(days.length / 6) === 0; return <g key={item.label}><circle cx={x} cy={y} r="3.8"><title>{item.label}：{item.aiTokens.toLocaleString()} token</title></circle>{visibleLabel && <text x={x} y={height - 7} textAnchor="middle">{item.label.slice(-5)}</text>}</g>; })}</svg></figure>;
}

function ModelBars({ models, period }: { models: UsageModel[]; period: Period }) {
  const maximum = Math.max(1, ...models.map((item) => item.tokens));
  return <figure className="usage-chart-card usage-model-chart"><figcaption><div><span>模型用量分布</span><small>{periodLabels[period]} · 仅大模型调用</small></div><strong>{models.length} <em>个模型</em></strong></figcaption>{models.length ? <div className="model-bars" role="img" aria-label={`${periodLabels[period]}各模型 token 使用量柱状图`}>{models.map((item, index) => <div className="model-bar-row" key={item.model}><div className="model-bar-label" title={item.model}>{item.model}</div><div className="model-bar-track"><i style={{ width: `${item.tokens / maximum * 100}%`, backgroundColor: barColors[index % barColors.length] }} /></div><strong>{item.tokens.toLocaleString()}</strong></div>)}</div> : <div className="usage-chart-empty">这个时间范围还没有大模型调用。</div>}</figure>;
}

function Leaderboard({ rows, period }: { rows: LeaderboardItem[]; period: Period }) {
  const [metric, setMetric] = useState<'aiTokens' | 'asrRequests' | 'realtimeSeconds'>('aiTokens');
  const config = metric === 'aiTokens' ? { label: 'Token', unit: 'token' } : metric === 'asrRequests' ? { label: '普通转写', unit: '次' } : { label: '实时转写', unit: '秒' };
  const ranked = useMemo(() => [...rows].sort((a, b) => b[metric] - a[metric] || a.userId - b.userId), [rows, metric]);
  return <section className="usage-leaderboard"><header><div><span className="section-kicker">USAGE LEADERBOARD</span><h3>使用量排行榜</h3><p>{periodLabels[period]}内按 {config.label} 排序</p></div><label>统计指标<select value={metric} onChange={(event) => setMetric(event.target.value as typeof metric)}><option value="aiTokens">Token</option><option value="asrRequests">普通转写</option><option value="realtimeSeconds">实时转写</option></select></label></header><div className="usage-leaderboard-table" role="table" aria-label="API 使用量排行榜"><div className="usage-leaderboard-row usage-leaderboard-labels" role="row"><span>排名</span><span>学员</span><span>{config.label}</span></div>{ranked.length ? ranked.map((item, index) => <div className="usage-leaderboard-row" role="row" key={item.userId}><span className={`usage-rank rank-${Math.min(index + 1, 4)}`}>{index + 1}</span><span><b>{item.displayName}</b><small>@{item.username}</small></span><strong>{metric === 'realtimeSeconds' ? formatSeconds(item[metric]) : item[metric].toLocaleString()} <em>{metric === 'realtimeSeconds' ? '' : config.unit}</em></strong></div>) : <div className="usage-chart-empty">暂无可排行的数据。</div>}</div></section>;
}

function LimitEditor({ user, onChange, onSave, saving }: { user: ManagedUser; onChange: (patch: Partial<ManagedUser>) => void; onSave: () => void; saving: boolean }) {
  const ai = userUsage(user, 'ai'); const asr = userUsage(user, 'asr'); const realtime = userUsage(user, 'realtime_asr');
  const Meter = ({ title, used, limit, unit, tone }: { title: string; used: number; limit: number; unit: string; tone: string }) => <div className="usage-meter"><div><strong>{title}</strong><span>{unit === '秒' ? formatSeconds(used) : used.toLocaleString()} / {limit ? (unit === '秒' ? formatSeconds(limit) : limit.toLocaleString()) : '不限额'} {limit ? unit : ''}</span></div><div className={`usage-bar ${tone}`}><i style={{ width: `${ratio(used, limit)}%` }} /></div></div>;
  return <section className="usage-limit-editor"><header><div><span className="section-kicker">SELECTED USER</span><h3>{user.displayName}</h3><p>@{user.username} · 以下额度按自然月统计</p></div><button className="modal-submit usage-save" disabled={saving} onClick={onSave}>{saving ? '保存中…' : '保存配置'}</button></header><div className="usage-meters"><Meter title="大模型" used={ai} limit={user.aiTokenLimit} unit="token" tone="" /><Meter title="录音转写" used={asr} limit={user.asrRequestLimit} unit="次" tone="amber" /><Meter title="实时转写" used={realtime} limit={user.realtimeSecondsLimit} unit="秒" tone="violet" /></div><div className="usage-controls usage-controls-compact"><label className="usage-toggle"><input type="checkbox" checked={user.aiEnabled} onChange={(event) => onChange({ aiEnabled: event.target.checked })} /><span><b>AI 对话与评估</b><small>关闭后不可使用对话、评估、追问</small></span></label><label>每月 Token 额度<input type="number" min="0" value={user.aiTokenLimit} onChange={(event) => onChange({ aiTokenLimit: Math.max(0, Number(event.target.value) || 0) })} /><small>填 0 表示不限额</small></label><label className="usage-toggle"><input type="checkbox" checked={user.asrEnabled} onChange={(event) => onChange({ asrEnabled: event.target.checked })} /><span><b>录音转文字</b><small>关闭后普通录音不再自动或手动转写</small></span></label><label>每月普通转写额度<input type="number" min="0" value={user.asrRequestLimit} onChange={(event) => onChange({ asrRequestLimit: Math.max(0, Number(event.target.value) || 0) })} /><small>填 0 表示不限额</small></label><label className="usage-toggle"><input type="checkbox" checked={user.realtimeAsrEnabled} onChange={(event) => onChange({ realtimeAsrEnabled: event.target.checked })} /><span><b>实时语音识别</b><small>关闭后真实模拟不可连接实时识别</small></span></label><label>每月实时转写秒数<input type="number" min="0" value={user.realtimeSecondsLimit} onChange={(event) => onChange({ realtimeSecondsLimit: Math.max(0, Number(event.target.value) || 0) })} /><small>填 0 表示不限额</small></label></div></section>;
}

export default function UsageManagement() {
  const [users, setUsers] = useState<UsageUserOption[]>([]); const [selectedUserId, setSelectedUserId] = useState('all'); const [period, setPeriod] = useState<Period>('7d');
  const [data, setData] = useState<UsageResponse | null>(null); const [draft, setDraft] = useState<ManagedUser | null>(null); const [message, setMessage] = useState(''); const [saving, setSaving] = useState(false); const [loading, setLoading] = useState(true);
  const load = useCallback(async () => { setLoading(true); try { const response = await getJson(`/api/usage?userId=${encodeURIComponent(selectedUserId)}&period=${period}`) as UsageResponse; setData(response); setUsers(response.users || []); setDraft(response.selectedUser); } catch (error) { setMessage((error as Error).message); } finally { setLoading(false); } }, [period, selectedUserId]);
  useEffect(() => { void load(); }, [load]);
  async function save() { if (!draft) return; setSaving(true); setMessage(''); try { await getJson('/api/usage', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: draft.id, aiEnabled: draft.aiEnabled, asrEnabled: draft.asrEnabled, realtimeAsrEnabled: draft.realtimeAsrEnabled, aiTokenLimit: draft.aiTokenLimit, asrRequestLimit: draft.asrRequestLimit, realtimeSecondsLimit: draft.realtimeSecondsLimit }) }); setMessage(`已保存 ${draft.displayName} 的 API 权限与额度。`); await load(); } catch (error) { setMessage((error as Error).message); } finally { setSaving(false); } }
  const totals = data?.totals || { aiTokens: 0, asrRequests: 0, realtimeSeconds: 0 };
  return <section className="usage-management"><header className="usage-head"><div><span className="section-kicker">API USAGE & LIMITS</span><h2>用量与额度</h2><p>先按学员和时间范围查看消耗；选择具体学员后，再调整其权限与月度额度。</p></div><div className="usage-toolbar"><label>查看对象<select value={selectedUserId} onChange={(event) => setSelectedUserId(event.target.value)}><option value="all">全部学员</option>{users.map((user) => <option key={user.id} value={user.id}>{user.displayName}（@{user.username}）</option>)}</select></label><div className="usage-periods" role="group" aria-label="统计时间范围">{(Object.keys(periodLabels) as Period[]).map((key) => <button key={key} className={period === key ? 'active' : ''} onClick={() => setPeriod(key)}>{periodLabels[key]}</button>)}</div><button className="secondary-action usage-refresh" disabled={loading} onClick={() => void load()}>{loading ? '读取中…' : '刷新'}</button></div></header>{message && <div className="management-message" role="status">{message}</div>}<div className="usage-overview"><article><span>大模型 Token</span><strong>{totals.aiTokens.toLocaleString()}</strong><small>{periodLabels[period]}内的合计</small></article><article><span>普通语音转写</span><strong>{totals.asrRequests.toLocaleString()}</strong><small>已提交的转写任务数</small></article><article><span>实时语音识别</span><strong>{formatSeconds(totals.realtimeSeconds)}</strong><small>按实际音频时长累计</small></article></div><div className="usage-charts"><TokenTrend days={data?.daily || []} period={period} /><ModelBars models={data?.modelSeries || []} period={period} /></div><div className="usage-lower-grid"><Leaderboard rows={data?.leaderboard || []} period={period} />{draft ? <LimitEditor user={draft} saving={saving} onChange={(patch) => setDraft((current) => current ? { ...current, ...patch } : current)} onSave={() => void save()} /> : <section className="usage-select-hint"><span className="section-kicker">USER SETTINGS</span><h3>选择一位学员后管理额度</h3><p>上方下拉框选择具体学员，即可查看其本月消耗并设置 AI、普通转写和实时转写的开关与额度。</p></section>}</div></section>;
}
