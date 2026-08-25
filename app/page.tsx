'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';

type Category = '专业问题' | '英语问答问题' | '综合面试问题';
type User = { id: number; username: string; displayName: string; role: 'admin' | 'student' };
type ManagedUser = User & { status: 'pending' | 'active' | 'rejected' };
type Question = { id: number; typeId: number; typeCode: string; category: Category; content: string; subcategory?: string | null; hasAnswer?: number };
type QuestionType = { id: number; code: string; name: string; description: string | null; sortOrder?: number };
type BankQuestion = { id: number; typeId: number; typeName: string; content: string; answer: string | null; subcategory: string | null; status: string; extra?: unknown };
type RecordItem = { id: number; userId: number; questionId: number | null; category: Category; question: string; answer: string; hasAudio: number; createdAt: string; username?: string; displayName?: string };
type RecordGroup = { key: string; userId: number; questionId: number | null; category: Category; question: string; username?: string; attempts: RecordItem[] };
type Page = 'home' | 'answer' | 'history' | 'settings' | 'users' | 'question-bank';

const cards = [
  { name: '专业问题' as Category, no: '01', en: 'ACADEMIC FOUNDATION', desc: '核心专业课、科研基础与学术思维', icon: '专', color: 'coral' },
  { name: '英语问答问题' as Category, no: '02', en: 'ENGLISH PROFICIENCY', desc: '英文自我介绍、专业表达与即兴问答', icon: 'EN', color: 'blue' },
  { name: '综合面试问题' as Category, no: '03', en: 'COMPREHENSIVE INTERVIEW', desc: '个人经历、热点观点与临场应变', icon: '综', color: 'green' },
];

async function jsonFetch(url: string, options?: RequestInit) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || '请求失败');
  return body;
}

function formatRecordDate(value: string) {
  const normalized = String(value).includes('T') ? String(value) : String(value).replace(' ', 'T');
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN');
}

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState<Page>('home');
  const [question, setQuestion] = useState<Question | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [answer, setAnswer] = useState('');
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [autoRecord, setAutoRecord] = useState(true);
  const [avoidRepeated, setAvoidRepeated] = useState(false);
  const [recording, setRecording] = useState(false);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [referenceAnswer, setReferenceAnswer] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const recorder = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const stopResolver = useRef<((blob: Blob | null) => void) | null>(null);

  const startRecording = useCallback(async () => {
    if (recorder.current?.state === 'recording') return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      chunks.current = []; streamRef.current = stream;
      mediaRecorder.ondataavailable = (event) => { if (event.data.size) chunks.current.push(event.data); };
      mediaRecorder.onstop = () => {
        const blob = chunks.current.length ? new Blob(chunks.current, { type: mediaRecorder.mimeType || 'audio/webm' }) : null;
        setAudioBlob(blob); setRecording(false); stream.getTracks().forEach((track) => track.stop());
        stopResolver.current?.(blob); stopResolver.current = null;
      };
      mediaRecorder.start(); recorder.current = mediaRecorder; setRecording(true);
    } catch { setMessage('无法使用麦克风，请在浏览器地址栏允许录音权限。'); }
  }, []);

  const loadRecords = useCallback(async (category = '', search = '') => {
    const data = await jsonFetch(`/api/records?category=${encodeURIComponent(category)}&q=${encodeURIComponent(search)}`);
    setRecords(data.records);
  }, []);

  useEffect(() => {
    Promise.all([jsonFetch('/api/auth/me'), jsonFetch('/api/settings')])
      .then(([me, settings]) => { setUser(me.user); setAutoRecord(settings.settings.autoRecord); setAvoidRepeated(Boolean(settings.settings.avoidRepeated)); return loadRecords(); })
      .catch(() => setUser(null)).finally(() => setLoading(false));
  }, [loadRecords]);

  useEffect(() => {
    if (countdown === null) return;
    const timer = window.setTimeout(() => {
      if (countdown === 1) {
        setCountdown(null);
        if (autoRecord) void startRecording();
      } else setCountdown(countdown - 1);
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [countdown, autoRecord, startRecording]);

  useEffect(() => {
    if (!audioBlob || !question?.hasAnswer) return;
    void jsonFetch('/api/questions/' + question.id + '/answer').then((data) => setReferenceAnswer(data.answer || null)).catch(() => setReferenceAnswer(null));
  }, [audioBlob, question]);
  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage('');
    const form = new FormData(event.currentTarget);
    try {
      const data = await jsonFetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: form.get('username'), password: form.get('password') }) });
      setUser(data.user);
      const settings = await jsonFetch('/api/settings'); setAutoRecord(settings.settings.autoRecord); setAvoidRepeated(Boolean(settings.settings.avoidRepeated));
      await loadRecords();
    } catch (error) { setMessage((error as Error).message); }
  }

  async function logout() {
    stopMedia(); await fetch('/api/auth/logout', { method: 'POST' });
    setUser(null); setRecords([]); setPage('home');
  }

  async function draw(category: Category) {
    stopMedia(); setMessage('');
    try {
      const data = await jsonFetch(`/api/questions/random?category=${encodeURIComponent(category)}`);
      setQuestion(data.question); setAnswer(''); setAudioBlob(null); setReferenceAnswer(null); setCountdown(3); setPage('answer'); window.scrollTo(0, 0);
    } catch (error) { setMessage((error as Error).message); }
  }

  function stopRecording() {
    if (!recorder.current || recorder.current.state !== 'recording') return Promise.resolve(audioBlob);
    return new Promise<Blob | null>((resolve) => { stopResolver.current = resolve; recorder.current?.stop(); });
  }

  function stopMedia() {
    if (recorder.current?.state === 'recording') recorder.current.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    setRecording(false);
  }

  async function save() {
    if (!question) return;
    setMessage('正在保存…');
    try {
      const blob = recording ? await stopRecording() : audioBlob;
      const form = new FormData();
      form.set('questionId', String(question.id)); form.set('category', question.category); form.set('question', question.content); form.set('answer', answer);
      if (blob) form.set('audio', new File([blob], 'answer.webm', { type: blob.type || 'audio/webm' }));
      await jsonFetch('/api/records', { method: 'POST', body: form });
      await loadRecords(); setMessage(''); setPage('history');
    } catch (error) { setMessage((error as Error).message); }
  }

  if (loading) return <div className="login-shell"><div className="login-card"><b className="login-mark">研</b><p>正在载入训练系统…</p></div></div>;
  if (!user) return <Login onSubmit={login} message={message} />;

  return <div className="app">
    <header>
      <button className="logo" onClick={() => setPage('home')}><b>研</b><span><strong>研路</strong><small>保研面试训练</small></span></button>
      <nav>
        <button className={page === 'home' || page === 'answer' ? 'active' : ''} onClick={() => setPage('home')}>题库训练</button>
        <button className={page === 'history' ? 'active' : ''} onClick={() => setPage('history')}>作答记录 <i>{records.length}</i></button>
        <button className={page === 'settings' ? 'active' : ''} onClick={() => setPage('settings')}>设置</button>
        {user.role === 'admin' && <><button className={page === 'users' ? 'active' : ''} onClick={() => setPage('users')}>用户管理</button><button className={page === 'question-bank' ? 'active' : ''} onClick={() => setPage('question-bank')}>题库管理</button></>}
      </nav>
      <button className="user-chip" onClick={logout}>{user.displayName}<small>退出</small></button>
    </header>
    {message && <div className="notice">{message}</div>}

    {page === 'home' && <main>
      <section className="hero"><div><p className="eyebrow">— 推免面试 · 模拟训练</p><h1>把每一次开口，<br />都练成<span>底气。</span></h1><p className="lead">从随机抽题到限时作答，提前适应真实面试节奏。<br />录音和练习记录安全保存在服务器。</p></div><aside><span>累计训练</span><strong>{String(records.length).padStart(2, '0')}</strong><small>次个人作答</small><div><i style={{ width: `${Math.min(records.length / 3 * 100, 100)}%` }} /></div><p>建议完成 3 道不同类别题目</p></aside></section>
      <section className="choose"><div className="title"><div><small>CHOOSE YOUR TOPIC</small><h2>选择一个训练类别</h2></div><span>三类题库 · 随机抽取 · 持久记录</span></div><div className="cards">{cards.map((card) => <article className={card.color} key={card.name}><div className="cardtop"><span>{card.no}</span><small>随机抽取</small></div><b className="symbol">{card.icon}</b><small className="en">{card.en}</small><h3>{card.name}</h3><p>{card.desc}</p><button onClick={() => draw(card.name)}>开始抽题 <span>→</span></button></article>)}</div></section>
      <section className="steps"><div><small>HOW IT WORKS</small><h2>四步完成一次高效练习</h2></div><ol><li><b>01</b>选择类别</li><li><b>02</b>3 秒准备</li><li><b>03</b>自动录音</li><li><b>04</b>复盘提升</li></ol></section>
    </main>}

    {page === 'answer' && question && <main className="answer-page"><button className="back" onClick={() => { stopMedia(); setPage('home'); }}>← 返回题库</button><div className="answer-head"><div><small>{question.category}</small><h1>模拟作答</h1></div><button className="again" onClick={() => draw(question.category)}>↻ 换一题</button></div><section className="question"><small>INTERVIEW QUESTION</small><b>Q</b><h2>{question.content}</h2>{question.subcategory && <span className="question-subcategory">{question.subcategory}</span>}<p>回答提示：观点明确 · 结构清晰 · 结合具体经历或案例</p>{countdown !== null && <div className="countdown"><div key={countdown}>{countdown}</div><strong>准备开始</strong><small>倒计时结束后{autoRecord ? '将自动录音' : '开始作答'}</small></div>}</section>{referenceAnswer && <section className="reference-answer"><span className="section-kicker">REFERENCE ANSWER</span><h3>参考答案</h3><p>{referenceAnswer}</p></section>}<section className="response"><label>作答提纲 <small>选填</small></label><textarea disabled={countdown !== null} value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="记录你的回答框架、关键词或复盘笔记……" /><div className={`recorder ${recording ? 'on' : ''}`}><span><b>{recording ? '● 正在录音' : audioBlob ? '✓ 录音已完成' : '◉ 录制作答'}</b><small>{recording ? '请保持自然语速' : autoRecord ? '倒计时后自动开始，也可手动控制' : '自动录音已在设置中关闭'}</small></span><button disabled={countdown !== null} onClick={() => recording ? void stopRecording() : void startRecording()}>{recording ? '结束录音' : audioBlob ? '重新录制' : '开始录音'}</button></div></section><div className="actions"><button onClick={() => { stopMedia(); setPage('home'); }}>退出练习</button><button onClick={save} disabled={countdown !== null}>完成并保存记录 →</button></div></main>}

    {page === 'history' && <History records={records} onFilter={loadRecords} onNew={() => setPage('home')} />}
    {page === 'settings' && <Settings autoRecord={autoRecord} avoidRepeated={avoidRepeated} onChange={(value, repeated) => { setAutoRecord(value); setAvoidRepeated(repeated); }} />}
    {page === 'users' && user.role === 'admin' && <Users />}
    {page === 'question-bank' && user.role === 'admin' && <QuestionBank />}
    <footer>研路 · 保研面试训练 <span>让准备看得见，让表达更从容。</span></footer>
  </div>;
}


function QuestionBank() {
  const [types, setTypes] = useState<QuestionType[]>([]);
  const [questions, setQuestions] = useState<BankQuestion[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [typeFilter, setTypeFilter] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [jumpPage, setJumpPage] = useState('1');
  const [total, setTotal] = useState(0);
  const [message, setMessage] = useState('');
  const [editor, setEditor] = useState<{ id?: number; typeId: number; content: string; answer: string; subcategory: string; status: string } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const pageSize = 8;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const allSelected = questions.length > 0 && questions.every((item) => selected.includes(item.id));

  const loadTypes = useCallback(async () => {
    const data = await jsonFetch('/api/question-types');
    setTypes(data.types);
  }, []);
  const load = useCallback(async (targetPage = 1) => {
    const params = new URLSearchParams({ page: String(targetPage), pageSize: String(pageSize) });
    if (typeFilter) params.set('typeId', typeFilter);
    if (search.trim()) params.set('q', search.trim());
    const data = await jsonFetch('/api/question-bank?' + params.toString());
    setQuestions(data.questions); setTotal(data.total); setPage(data.page); setJumpPage(String(data.page)); setSelected([]);
  }, [search, typeFilter]);
  useEffect(() => { void loadTypes(); }, [loadTypes]);
  useEffect(() => { void load(1); }, [load]);

  function openCreate() {
    setEditor({ typeId: Number(typeFilter || types[0]?.id || 0), content: '', answer: '', subcategory: '', status: 'active' });
  }
  function openEdit(item: BankQuestion) {
    setEditor({ id: item.id, typeId: item.typeId, content: item.content, answer: item.answer || '', subcategory: item.subcategory || '', status: item.status });
  }
  function toggleSelected(id: number, checked: boolean) {
    setSelected((current) => checked ? Array.from(new Set([...current, id])) : current.filter((item) => item !== id));
  }
  function toggleAll(checked: boolean) {
    setSelected(checked ? questions.map((item) => item.id) : []);
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!editor) return;
    try {
      await jsonFetch('/api/question-bank', { method: editor.id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(editor) });
      setEditor(null); setMessage('题目已保存'); await load(page);
    } catch (error) { setMessage((error as Error).message); }
  }
  async function remove(ids: number[]) {
    if (!ids.length || !window.confirm('确定删除选中的题目吗？已有作答记录会保留。')) return;
    try {
      const result = await jsonFetch('/api/question-bank', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
      setMessage('已删除 ' + result.deleted + ' 道题目'); await load(Math.min(page, totalPages));
    } catch (error) { setMessage((error as Error).message); }
  }
  async function importExcel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    try {
      const result = await jsonFetch('/api/question-bank', { method: 'PUT', body: form });
      setImportOpen(false); setMessage('已导入 ' + result.imported + ' 条题目' + (result.skipped ? '，跳过 ' + result.skipped + ' 行' : '')); await load(1);
    } catch (error) { setMessage((error as Error).message); }
  }
  function jump(event: FormEvent) {
    event.preventDefault();
    const target = Math.min(totalPages, Math.max(1, Number(jumpPage) || 1));
    void load(target);
  }

  return <main className="panel-page bank-page">
    <div className="users-heading"><div><p className="eyebrow">— QUESTION BANK</p><h1>题库管理</h1><p>维护题目、答案和具体分类，也可以批量导入 Excel。</p></div><div className="bank-actions"><button className="secondary-action" onClick={() => setImportOpen(true)}>↑ 导入 Excel</button><button className="create-trigger" onClick={openCreate}>＋ 新增题目</button></div></div>
    {message && <div className="management-message">{message}</div>}
    <section className="bank-toolbar"><select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}><option value="">全部题型</option>{types.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索题目、答案或具体分类" /><button onClick={() => void load(1)}>筛选</button><span>共 {total} 道题目</span></section>
    <div className="bulk-toolbar"><label><input type="checkbox" checked={allSelected} onChange={(event) => toggleAll(event.target.checked)} /> 全选本页</label><span>已选 {selected.length} 道</span><button className="danger-text" disabled={!selected.length} onClick={() => void remove(selected)}>批量删除</button></div>
    <section className="bank-list">{questions.length ? questions.map((item) => <article className="bank-item" key={item.id}><div className="bank-item-head"><label className="question-check"><input type="checkbox" checked={selected.includes(item.id)} onChange={(event) => toggleSelected(item.id, event.target.checked)} /></label><div><span className="section-kicker">{item.typeName}</span><h2>{item.content}</h2></div><div className="bank-item-actions"><button onClick={() => openEdit(item)}>编辑</button><button className="danger-text" onClick={() => void remove([item.id])}>删除</button></div></div><div className="bank-meta">{item.subcategory && <span className="tag-chip">{item.subcategory}</span>}<span className={'question-status status-' + item.status}>{item.status === 'active' ? '启用' : item.status === 'draft' ? '草稿' : '归档'}</span>{item.answer ? <span className="answer-state has-answer">有参考答案</span> : <span className="answer-state">暂无参考答案</span>}</div>{item.answer && <p className="bank-answer">{item.answer}</p>}</article>) : <div className="empty"><b>题</b><h3>暂无题目</h3><p>可以新增题目，或导入整理好的 Excel。</p></div>}</section>
    <div className="pagination"><button disabled={page <= 1} onClick={() => void load(page - 1)}>← 上一页</button><span>第 {page} / {totalPages} 页</span><button disabled={page >= totalPages} onClick={() => void load(page + 1)}>下一页 →</button><form className="page-jump" onSubmit={jump}><input aria-label="跳转页码" type="number" min="1" max={totalPages} value={jumpPage} onChange={(event) => setJumpPage(event.target.value)} /><button>跳转</button></form></div>
    {editor && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditor(null); }}><form className="create-modal bank-editor" onSubmit={save}><button type="button" className="modal-close" onClick={() => setEditor(null)}>×</button><span className="section-kicker">{editor.id ? 'EDIT QUESTION' : 'NEW QUESTION'}</span><h2>{editor.id ? '编辑题目' : '新增题目'}</h2><label>题目类型<select value={editor.typeId} onChange={(event) => setEditor({ ...editor, typeId: Number(event.target.value) })}>{types.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></label><label>题目内容<textarea required value={editor.content} onChange={(event) => setEditor({ ...editor, content: event.target.value })} /></label><label>参考答案（可选）<textarea value={editor.answer} onChange={(event) => setEditor({ ...editor, answer: event.target.value })} /></label><label>具体分类（可选）<input value={editor.subcategory} onChange={(event) => setEditor({ ...editor, subcategory: event.target.value })} /></label><label>状态<select value={editor.status} onChange={(event) => setEditor({ ...editor, status: event.target.value })}><option value="active">启用</option><option value="draft">草稿</option><option value="archived">归档</option></select></label><button className="modal-submit">保存题目</button></form></div>}
    {importOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setImportOpen(false); }}><form className="create-modal import-modal" onSubmit={importExcel}><button type="button" className="modal-close" onClick={() => setImportOpen(false)}>×</button><span className="section-kicker">EXCEL IMPORT</span><h2>导入题库 Excel</h2><p>Excel 需要包含“题目内容”列；“参考答案”“具体分类”“来源”“备注”均可选。</p><label>导入到题型<select name="typeId" defaultValue={typeFilter || types[0]?.id || ''} required>{types.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></label><label>Excel 文件<input name="file" type="file" accept=".xlsx,.xls,.csv" required /></label><button className="modal-submit">开始导入</button></form></div>}
  </main>;
}

function Login({ onSubmit, message }: { onSubmit: (event: FormEvent<HTMLFormElement>) => void; message: string }) {
  const [registering, setRegistering] = useState(false); const [registerMessage, setRegisterMessage] = useState('');
  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); setRegisterMessage('');
    try { const result = await jsonFetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(data)) }); setRegisterMessage(result.message); form.reset(); }
    catch (error) { setRegisterMessage((error as Error).message); }
  }
  return <div className="login-shell"><form className="login-card" onSubmit={registering ? register : onSubmit}><b className="login-mark">研</b><small>YANLU INTERVIEW TRAINER</small><h1>{registering ? '申请注册' : '欢迎回来'}</h1><p>{registering ? '提交后需管理员审核通过才能登录' : '登录后开始你的保研面试训练'}</p>{registering && <label>姓名<input name="displayName" autoComplete="name" required /></label>}<label>账号<input name="username" autoComplete="username" required /></label><label>密码<input name="password" type="password" minLength={registering ? 8 : undefined} autoComplete={registering ? 'new-password' : 'current-password'} required /></label>{(registering ? registerMessage : message) && <div className={registerMessage.includes('已提交') ? 'form-success' : 'form-error'}>{registering ? registerMessage : message}</div>}<button type="submit">{registering ? '提交注册申请 →' : '登录系统 →'}</button><button type="button" className="login-switch" onClick={() => { setRegistering(!registering); setRegisterMessage(''); }}>{registering ? '已有账号？返回登录' : '没有账号？申请注册'}</button></form></div>;
}

function History({ records, onFilter, onNew }: { records: RecordItem[]; onFilter: (category?: string, search?: string) => Promise<void>; onNew: () => void }) {
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [jumpPage, setJumpPage] = useState('1');
  const pageSize = 8;
  const groups: RecordGroup[] = [];
  for (const item of records) {
    const key = String(item.userId) + ':' + (item.questionId || 'record-' + item.id);
    let group = groups.find((candidate) => candidate.key === key);
    if (!group) {
      group = { key, userId: item.userId, questionId: item.questionId, category: item.category, question: item.question, username: item.username, attempts: [] };
      groups.push(group);
    }
    group.attempts.push(item);
  }
  const totalPages = Math.max(1, Math.ceil(groups.length / pageSize));
  const visibleGroups = groups.slice((page - 1) * pageSize, page * pageSize);
  function applyFilter(event: FormEvent) {
    event.preventDefault(); setPage(1); setJumpPage('1'); void onFilter(category, search);
  }
  function jump(event: FormEvent) {
    event.preventDefault();
    const target = Math.min(totalPages, Math.max(1, Number(jumpPage) || 1));
    setPage(target); setJumpPage(String(target));
  }
  return <main className="history-page"><div className="history-head"><div><p className="eyebrow">— PRACTICE ARCHIVE</p><h1>作答记录</h1><p>相同题目会合并展示，展开后可以查看每次具体作答。</p></div><button onClick={onNew}>＋ 新的练习</button></div><div className="stats"><div><span>题目记录</span><strong>{groups.length}<small> 题</small></strong></div><div><span>累计作答</span><strong>{records.length}<small> 次</small></strong></div><div><span>保存录音</span><strong>{records.filter((r) => r.hasAudio).length}<small> 条</small></strong></div></div><form className="filters" onSubmit={applyFilter}><select value={category} onChange={(event) => { setCategory(event.target.value); setPage(1); }}><option value="">全部类别</option>{cards.map((card) => <option key={card.name}>{card.name}</option>)}</select><input value={search} onChange={(event) => setSearch(event.target.value)} /><button>筛选记录</button></form><section className="records">{visibleGroups.map((group, index) => <article className="record-group" key={group.key}><b>{String((page - 1) * pageSize + index + 1).padStart(2, '0')}</b><div><small>{group.username ? '学员：' + group.username + ' · ' : ''}{group.category} · {group.attempts.length} 次作答</small><h3>{group.question}</h3><details><summary>查看每次作答</summary><div className="attempt-list">{group.attempts.map((item) => <div className="attempt" key={item.id}><small>{formatRecordDate(item.createdAt)}</small><p>{item.answer}</p>{Boolean(item.hasAudio) && <audio controls preload="none" src={'/api/records/' + item.id + '/audio'} />}</div>)}</div></details></div></article>)}</section><div className="pagination"><button disabled={page <= 1} onClick={() => setPage(page - 1)}>← 上一页</button><span>第 {page} / {totalPages} 页</span><button disabled={page >= totalPages} onClick={() => setPage(page + 1)}>下一页 →</button><form className="page-jump" onSubmit={jump}><input type="number" min="1" max={totalPages} value={jumpPage} onChange={(event) => setJumpPage(event.target.value)} /><button>跳转</button></form></div></main>;
}

function Settings({ autoRecord, avoidRepeated, onChange }: { autoRecord: boolean; avoidRepeated: boolean; onChange: (value: boolean, avoidRepeated: boolean) => void }) {
  const [saved, setSaved] = useState('');
  const [guideOpen, setGuideOpen] = useState(false);
  const [origin, setOrigin] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => { setOrigin(window.location.origin); }, []);
  useEffect(() => {
    if (!guideOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setGuideOpen(false); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [guideOpen]);

  async function update(nextAutoRecord: boolean, nextAvoidRepeated: boolean) { await jsonFetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoRecord: nextAutoRecord, avoidRepeated: nextAvoidRepeated }) }); onChange(nextAutoRecord, nextAvoidRepeated); setSaved('设置已保存'); }
  async function copyOrigin() {
    if (!origin) return;
    try {
      await navigator.clipboard.writeText(origin);
    } catch {
      const input = document.createElement('textarea');
      input.value = origin; input.style.position = 'fixed'; input.style.opacity = '0';
      document.body.appendChild(input); input.select(); document.execCommand('copy'); input.remove();
    }
    setCopied(true); window.setTimeout(() => setCopied(false), 2200);
  }

  return <main className="panel-page"><p className="eyebrow">— PERSONAL SETTINGS</p><h1>系统设置</h1><section className="setting-card"><div><h2>题目显示后自动录音</h2><p>开启后，3 秒准备倒计时结束时自动请求麦克风并开始录制。</p></div><button className={`switch ${autoRecord ? 'on' : ''}`} onClick={() => void update(!autoRecord, avoidRepeated)} aria-label="切换自动录音"><i /></button></section><section className="setting-card"><div><h2>抽题时避开已练习题目</h2><p>开启后，系统会优先抽取你还没有练习过的题目。</p></div><button className={avoidRepeated ? 'switch on' : 'switch'} onClick={() => void update(autoRecord, !avoidRepeated)} aria-label="切换重复题目设置"><i /></button></section>{saved && <p className="saved">✓ {saved}</p>}<section className="permission-card"><div><span className="section-kicker">BROWSER PERMISSION</span><h2>HTTP 环境录音权限</h2><p>当前使用 IP + HTTP 时，浏览器默认不会开放麦克风。打开配置指引，可复制当前网址并快速进入 Chrome / Edge 的安全设置。</p></div><button className="permission-guide-trigger" onClick={() => setGuideOpen(true)}>查看配置指引 <span>→</span></button></section><div className="security-note"><b>数据存储说明</b><p>账号、题库、设置、作答记录和录音都保存在服务器 MySQL 数据库中。</p></div>{guideOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setGuideOpen(false); }}><div className="permission-modal" role="dialog" aria-modal="true" aria-labelledby="permission-guide-title"><button type="button" className="modal-close" aria-label="关闭录音权限指引" onClick={() => setGuideOpen(false)}>×</button><span className="section-kicker">MICROPHONE ACCESS</span><h2 id="permission-guide-title">开启 HTTP 录音权限</h2><p className="permission-intro">网页不能直接修改浏览器实验性开关，但可以帮你准备好要加入白名单的地址。</p><ol className="permission-steps"><li><b>01</b><div><strong>复制当前网址</strong><small>将下面的地址加入浏览器的安全来源列表。</small></div></li><li><b>02</b><div><strong>打开浏览器实验设置</strong><small>Chrome 或 Edge 中搜索 <code>unsafely-treat-insecure-origin-as-secure</code>。</small></div></li><li><b>03</b><div><strong>启用并重启浏览器</strong><small>把地址粘贴到白名单后，将开关设为 Enabled，再重启浏览器。</small></div></li></ol><div className="permission-origin"><code>{origin || '正在读取当前网址…'}</code><button type="button" onClick={() => void copyOrigin()} disabled={!origin}>{copied ? '已复制' : '复制地址'}</button></div><div className="permission-links"><a href="chrome://flags/#unsafely-treat-insecure-origin-as-secure" target="_blank" rel="noreferrer">打开 Chrome 设置</a><a href="edge://flags/#unsafely-treat-insecure-origin-as-secure" target="_blank" rel="noreferrer">打开 Edge 设置</a></div><p className="permission-warning">提示：这是浏览器临时兼容方案，仅建议本机开发使用。正式上线请使用 HTTPS。</p></div></div>}</main>;
}

function Users() {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [message, setMessage] = useState('');
  const [page, setPage] = useState(1);
  const [jumpPage, setJumpPage] = useState('1');
  const [total, setTotal] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ManagedUser | null>(null);
  const [deleteRecords, setDeleteRecords] = useState(false);
  const pageSize = 8;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const load = useCallback(async (targetPage = 1) => {
    const data = await jsonFetch(`/api/users?page=${targetPage}&pageSize=${pageSize}`);
    setUsers(data.users); setTotal(data.total); setPage(data.page); setJumpPage(String(data.page));
  }, []);
  useEffect(() => { void load(1); }, [load]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
    try { await jsonFetch('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(data)) }); form.reset(); setCreateOpen(false); setMessage('用户创建成功'); await load(1); }
    catch (error) { setMessage((error as Error).message); }
  }
  async function review(userId: number, action: 'approve' | 'reject') {
    try { await jsonFetch('/api/users', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId, action }) }); setMessage(action === 'approve' ? '申请已通过' : '申请已拒绝'); await load(page); }
    catch (error) { setMessage((error as Error).message); }
  }
  async function remove() {
    if (!pendingDelete) return;
    try { await jsonFetch('/api/users', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: pendingDelete.id, deleteRecords }) }); setMessage(deleteRecords ? '用户及其记录已删除' : '用户已删除，作答记录已保留'); setPendingDelete(null); setDeleteRecords(false); await load(page); }
    catch (error) { setMessage((error as Error).message); }
  }
  function jump(event: FormEvent) {
    event.preventDefault();
    const target = Math.min(totalPages, Math.max(1, Number(jumpPage) || 1));
    void load(target);
  }  const pending = users.filter((item) => item.status === 'pending');
  return <main className="panel-page"><div className="users-heading"><div><p className="eyebrow">— USER MANAGEMENT</p><h1>用户管理</h1><p>管理账号、审核注册申请，并维护用户权限。</p></div><button className="create-trigger" onClick={() => setCreateOpen(true)}>＋ 创建用户</button></div>
    {message && <div className="management-message">{message}</div>}
    <section className="approval-list"><div className="section-heading"><div><span className="section-kicker">PENDING REVIEW</span><h2>注册申请</h2></div><em>{pending.length ? `${pending.length} 条待处理` : '当前没有待处理申请'}</em></div><div className="approval-cards">{pending.length ? pending.map((item) => <article key={item.id}><div className="approval-avatar">{item.displayName.slice(0, 1)}</div><div className="approval-info"><strong>{item.displayName}</strong><span>@{item.username}</span><small>申请成为普通用户</small></div><div className="approval-actions"><button onClick={() => void review(item.id, 'reject')}>拒绝</button><button onClick={() => void review(item.id, 'approve')}>通过申请</button></div></article>) : <div className="approval-empty"><span>✓</span><div><strong>暂无待审核申请</strong><small>新用户注册后会出现在这里。</small></div></div>}</div></section>
    <section className="user-list"><div className="section-heading"><div><span className="section-kicker">ACCOUNT DIRECTORY</span><h2>已有用户</h2></div><em>共 {total} 个账号</em></div><div className="user-table"><div className="user-table-head"><span>用户</span><span>登录账号</span><span>角色</span><span>状态</span><span>操作</span></div>{users.map((item) => <article className="user-row" key={item.id}><div className="user-name"><span className="user-avatar">{item.displayName.slice(0, 1)}</span><strong>{item.displayName}</strong></div><span className="user-username">@{item.username}</span><span>{item.role === 'admin' ? '管理员' : '普通用户'}</span><small className={`status-${item.status}`}>{item.status === 'active' ? '正常' : item.status === 'pending' ? '待审核' : '已拒绝'}</small><div className="user-actions">{item.role !== 'admin' && <button className="delete-user" onClick={() => { setPendingDelete(item); setDeleteRecords(false); }}>删除</button>}</div>{pendingDelete?.id === item.id && <div className="delete-modal"><strong>确定删除 {item.username}？</strong><label><input type="checkbox" checked={deleteRecords} onChange={(event) => setDeleteRecords(event.target.checked)} /> 同时删除该用户的作答记录和录音</label><div><button onClick={() => { setPendingDelete(null); setDeleteRecords(false); }}>取消</button><button className="danger" onClick={() => void remove()}>确定删除</button></div></div>}</article>)}</div><div className="pagination"><button disabled={page <= 1} onClick={() => void load(page - 1)}>← 上一页</button><span>第 {page} / {totalPages} 页</span><button disabled={page >= totalPages} onClick={() => void load(page + 1)}>下一页 →</button><form className="page-jump" onSubmit={jump}><input aria-label="跳转页码" type="number" min="1" max={totalPages} value={jumpPage} onChange={(event) => setJumpPage(event.target.value)} /><button>跳转</button></form></div></section>
    {createOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setCreateOpen(false); }}><form className="create-modal" role="dialog" aria-modal="true" aria-labelledby="create-user-title" onSubmit={create}><button type="button" className="modal-close" aria-label="关闭创建用户弹窗" onClick={() => setCreateOpen(false)}>×</button><span className="section-kicker">NEW ACCOUNT</span><h2 id="create-user-title">创建用户</h2><p>管理员创建的账号会立即生效。</p><label>登录账号<input name="username" autoComplete="username" required /></label><label>显示姓名<input name="displayName" autoComplete="name" required /></label><label>初始密码<input name="password" type="password" autoComplete="new-password" minLength={8} required /></label><label>角色<select name="role"><option value="student">普通用户</option><option value="admin">管理员</option></select></label><button className="modal-submit">创建用户</button></form></div>}
  </main>;
}