'use client';

import fixWebmDuration from 'fix-webm-duration';

import { FormEvent, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

type Category = string;
type User = { id: number; username: string; displayName: string; role: 'admin' | 'student' };
type ManagedUser = User & { status: 'pending' | 'active' | 'rejected' };
type Question = { id: number; typeId: number; typeCode: string; category: Category; content: string; subcategory?: string | null; hasAnswer?: number };
type QuestionType = { id: number; code: string; name: string; description: string | null; sortOrder?: number };
type BankQuestion = { id: number; typeId: number; typeName: string; content: string; answer: string | null; subcategory: string | null; status: string; extra?: unknown };
type TranscriptSegment = { startMs: number; endMs: number; text: string };
type RecordItem = { id: number; userId: number; questionId: number | null; typeId?: number | null; category: Category; question: string; answer: string; subcategory?: string | null; referenceAnswer?: string | null; hasReferenceAnswer?: number; hasAudio: number; transcript?: string | null; transcriptSegments?: TranscriptSegment[] | string | null; transcriptStatus?: string; transcriptError?: string | null; transcribedAt?: string | null; createdAt: string; username?: string; displayName?: string };
type RecordGroup = { key: string; userId: number; questionId: number | null; category: Category; question: string; username?: string; attempts: RecordItem[] };
type Page = 'home' | 'answer' | 'history' | 'settings' | 'management' | 'review' | 'picker' | 'simulation';

type HomeCard = QuestionType & { no: string; en: string; desc: string; icon: string; color: string };
const cardColors = ['coral', 'blue', 'green'];

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

function parseTranscriptSegments(value: unknown): TranscriptSegment[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is TranscriptSegment => {
      if (!item || typeof item !== 'object') return false;
      const candidate = item as Partial<TranscriptSegment>;
      return Number.isFinite(Number(candidate.startMs)) && Number.isFinite(Number(candidate.endMs)) && typeof candidate.text === 'string';
    }).map((item) => ({
      startMs: Number(item.startMs),
      endMs: Number(item.endMs),
      text: item.text,
    }));
  }
  if (typeof value === 'string') {
    try {
      return parseTranscriptSegments(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return [];
}

function formatTranscriptTime(milliseconds: number) {
  const seconds = Math.max(0, milliseconds) / 1000;
  if (seconds < 60) return seconds.toFixed(1) + 's';
  const minutes = Math.floor(seconds / 60);
  return String(minutes).padStart(2, '0') + ':' + (seconds % 60).toFixed(1).padStart(4, '0');
}

function markdownInline(value: string): ReactNode[] {
  // AI responses may contain escaped asterisks, full-width asterisks, or
  // zero-width characters between asterisks. Normalize them before parsing.
  const normalized = String(value)
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\\+(\*)/g, '$1');
  const nodes: ReactNode[] = [];
  const tokens = normalized.split(/(`[^`]+`|\[[^\]]+\]\([^\)]+\))/g).filter(Boolean);
  let key = 0;
  for (const token of tokens) {
    if (token.startsWith('`') && token.endsWith('`')) { nodes.push(<code key={key++}>{token.slice(1, -1)}</code>); continue; }
    const link = token.match(/^\[([^\]]+)\]\(([^\)]+)\)$/);
    if (link) { nodes.push(<a key={key++} href={link[2]} target={'_blank'} rel={'noreferrer'}>{link[1]}</a>); continue; }
    const parts = token.split(/(\*{2,3}[\s\S]+?\*{2,3})/g).filter(Boolean);
    for (const part of parts) {
      const bold = part.match(/^\*{2,3}([\s\S]*?)\*{2,3}$/);
      nodes.push(bold ? <strong key={key++}>{bold[1]}</strong> : <span key={key++}>{part}</span>);
    }
  }
  return nodes;
}

function MarkdownContent({ value, className = '' }: { value: string; className?: string }) {
  const lines = String(value || '').replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let code: string[] | null = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(<p key={'p-' + blocks.length}>{paragraph.join(' ')}</p>);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const Tag = list.ordered ? 'ol' : 'ul';
    blocks.push(<Tag key={'list-' + blocks.length}>{list.items.map((item, index) => <li key={index}>{markdownInline(item)}</li>)}</Tag>);
    list = null;
  };
  const flushCode = () => {
    if (!code) return;
    blocks.push(<pre key={'code-' + blocks.length}><code>{code.join('\n')}</code></pre>);
    code = null;
  };

  lines.forEach((line) => {
    if (line.trim().startsWith('```')) {
      flushParagraph(); flushList();
      if (code) flushCode(); else code = [];
      return;
    }
    if (code) { code.push(line); return; }
    if (!line.trim()) { flushParagraph(); flushList(); return; }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph(); flushList(); blocks.push(<hr key={'hr-' + blocks.length} />); return;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) { flushParagraph(); flushList(); blocks.push(<h3 key={'h-' + blocks.length} data-level={heading[1].length}>{markdownInline(heading[2])}</h3>); return; }
    const boldOnly = line.trim().match(/^\*\*([\s\S]+?)\*\*$/);
    if (boldOnly) { flushParagraph(); flushList(); blocks.push(<h4 key={'h4-' + blocks.length}>{markdownInline(boldOnly[1])}</h4>); return; }
    const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (bullet || ordered) {
      flushParagraph();
      const isOrdered = Boolean(ordered);
      if (!list || list.ordered !== isOrdered) { flushList(); list = { ordered: isOrdered, items: [] }; }
      list.items.push((bullet || ordered)![1]);
      return;
    }
    if (line.startsWith('>')) { flushParagraph(); flushList(); blocks.push(<blockquote key={'q-' + blocks.length}>{markdownInline(line.replace(/^>\s?/, ''))}</blockquote>); return; }
    paragraph.push(line.trim());
  });
  flushParagraph(); flushList(); flushCode();
  return <div className={'markdown-content ' + className}>{blocks}</div>;
}

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState<Page>('home');
  const [question, setQuestion] = useState<Question | null>(null);
  const [reviewGroup, setReviewGroup] = useState<RecordGroup | null>(null);
  const [questionTypes, setQuestionTypes] = useState<QuestionType[]>([]);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [answer, setAnswer] = useState('');
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [autoRecord, setAutoRecord] = useState(true);
  const [autoTranscribe, setAutoTranscribe] = useState(false);
  const [avoidRepeated, setAvoidRepeated] = useState(false);
  const [readQuestion, setReadQuestion] = useState(false);
  const [recording, setRecording] = useState(false);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [referenceAnswer, setReferenceAnswer] = useState<string | null>(null);
  const homeCards: HomeCard[] = questionTypes.map((type, index) => ({ ...type, no: String(index + 1).padStart(2, '0'), en: type.code.toUpperCase(), desc: type.description || '暂无介绍', icon: type.name.slice(0, 1), color: cardColors[index % cardColors.length] }));
  const [message, setMessage] = useState('');
  const recorder = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const stopResolver = useRef<((blob: Blob | null) => void) | null>(null);
  const recordingStartedAt = useRef<number | null>(null);
  const speechRunId = useRef(0);
  const audioContext = useRef<AudioContext | null>(null);

  const playCue = useCallback((kind: 'countdown' | 'recording', value = 0) => {
    try {
      const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) return;
      audioContext.current ??= new AudioContextCtor();
      const context = audioContext.current;
      void context.resume();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = context.currentTime;
      const duration = kind === 'recording' ? 0.22 : 0.12;
      oscillator.type = 'sine';
      oscillator.frequency.value = kind === 'recording' ? 880 : 520 + Math.max(0, value) * 70;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.08, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      oscillator.connect(gain); gain.connect(context.destination);
      oscillator.start(start); oscillator.stop(start + duration + 0.02);
    } catch {
      // The browser may block Web Audio until the first user gesture.
    }
  }, []);

  const startRecording = useCallback(async () => {
    if (recorder.current?.state === 'recording') return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      chunks.current = []; streamRef.current = stream;
      mediaRecorder.ondataavailable = (event) => { if (event.data.size) chunks.current.push(event.data); };
      mediaRecorder.onstop = async () => {
        const rawBlob = chunks.current.length ? new Blob(chunks.current, { type: mediaRecorder.mimeType || 'audio/webm' }) : null;
        const elapsed = recordingStartedAt.current ? Math.max(0, Date.now() - recordingStartedAt.current) : 0;
        const blob = rawBlob && elapsed > 0 ? await fixWebmDuration(rawBlob, elapsed, { logger: false }) : rawBlob;
        setAudioBlob(blob); setRecording(false); stream.getTracks().forEach((track) => track.stop());
        stopResolver.current?.(blob); stopResolver.current = null;
      };
      recordingStartedAt.current = Date.now(); mediaRecorder.start(); recorder.current = mediaRecorder; setRecording(true); playCue('recording');
    } catch { setMessage('无法使用麦克风，请在浏览器地址栏允许录音权限。'); }
  }, [playCue]);

  const loadRecords = useCallback(async (category = '', search = '') => {
    const data = await jsonFetch(`/api/records?category=${encodeURIComponent(category)}&q=${encodeURIComponent(search)}`);
    setRecords(data.records);
  }, []);

  useEffect(() => {
    Promise.all([jsonFetch('/api/auth/me'), jsonFetch('/api/settings'), jsonFetch('/api/question-types')])
      .then(([me, settings, typeData]) => { setUser(me.user); setAutoRecord(settings.settings.autoRecord); setAutoTranscribe(Boolean(settings.settings.autoTranscribe)); setAvoidRepeated(Boolean(settings.settings.avoidRepeated)); setReadQuestion(Boolean(settings.settings.readQuestion)); setQuestionTypes(typeData.types); return loadRecords(); })
      .catch(() => setUser(null)).finally(() => setLoading(false));
  }, [loadRecords]);

  useEffect(() => {
    if (countdown === null) return;
    playCue('countdown', countdown);
    const timer = window.setTimeout(() => {
      if (countdown === 1) {
        setCountdown(null);
        if (readQuestion && question) {
          const runId = ++speechRunId.current;
          if (!('speechSynthesis' in window)) {
            setMessage('当前浏览器不支持题目朗读');
            if (autoRecord) void startRecording();
            return;
          }
          window.speechSynthesis.cancel();
          const utterance = new SpeechSynthesisUtterance(question.content);
          utterance.lang = /[\u4e00-\u9fff]/.test(question.content) ? 'zh-CN' : 'en-US';
          let completed = false;
          const finishReading = () => {
            if (completed || speechRunId.current !== runId) return;
            completed = true;
            if (autoRecord) void startRecording();
          };
          utterance.onend = finishReading;
          utterance.onerror = finishReading;
          window.speechSynthesis.speak(utterance);
        } else if (autoRecord) void startRecording();
      } else setCountdown(countdown - 1);
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [countdown, autoRecord, question, readQuestion, startRecording, playCue]);
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
      const settings = await jsonFetch('/api/settings'); setAutoRecord(settings.settings.autoRecord); setAutoTranscribe(Boolean(settings.settings.autoTranscribe)); setAvoidRepeated(Boolean(settings.settings.avoidRepeated)); setReadQuestion(Boolean(settings.settings.readQuestion)); const typeData = await jsonFetch('/api/question-types'); setQuestionTypes(typeData.types);
      await loadRecords();
    } catch (error) { setMessage((error as Error).message); }
  }

  async function logout() {
    stopMedia(); await fetch('/api/auth/logout', { method: 'POST' });
    setUser(null); setRecords([]); setPage('home');
  }

  async function draw(typeId: number) {
    stopMedia(); setMessage('');
    try {
      const data = await jsonFetch('/api/questions/random?typeId=' + encodeURIComponent(String(typeId)));
      setQuestion(data.question); setAnswer(''); setAudioBlob(null); setReferenceAnswer(null); setCountdown(3); setPage('answer'); window.scrollTo(0, 0);
    } catch (error) { setMessage((error as Error).message); }
  }

  function startSelectedQuestion(selected: Question) {
    stopMedia();
    setQuestion(selected);
    setAnswer('');
    setAudioBlob(null);
    setReferenceAnswer(null);
    setCountdown(3);
    setPage('answer');
    window.scrollTo(0, 0);
  }

  function stopRecording() {
    if (!recorder.current || recorder.current.state !== 'recording') return Promise.resolve(audioBlob);
    return new Promise<Blob | null>((resolve) => { stopResolver.current = resolve; recorder.current?.stop(); });
  }

  function stopMedia() {
    speechRunId.current += 1;
    window.speechSynthesis?.cancel();
    if (recorder.current?.state === 'recording') recorder.current.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    setRecording(false);
  }

  function continueFromRecord(item: RecordItem) {
    if (!item.questionId || !item.typeId) {
      setMessage('原题已不存在，无法继续作答。');
      return;
    }
    stopMedia();
    setQuestion({ id: item.questionId, typeId: item.typeId, typeCode: '', category: item.category, content: item.question, subcategory: item.subcategory, hasAnswer: item.hasReferenceAnswer });
    setAnswer('');
    setAudioBlob(null);
    setReferenceAnswer(item.referenceAnswer || null);
    setCountdown(3);
    setPage('answer');
    window.scrollTo(0, 0);
  }
  async function save() {
    if (!question) return;
    setMessage('正在保存…');
    try {
      const blob = recording ? await stopRecording() : audioBlob;
      const form = new FormData();
      form.set('questionId', String(question.id)); form.set('category', question.category); form.set('question', question.content); form.set('answer', answer);
      if (blob) form.set('audio', new File([blob], 'answer.webm', { type: blob.type || 'audio/webm' }));
      const saved = await jsonFetch('/api/records', { method: 'POST', body: form });
      if (autoTranscribe && blob && saved.id) await jsonFetch('/api/records/' + saved.id + '/transcription', { method: 'POST' }).catch(() => undefined);
      await loadRecords(); setMessage(''); setPage('history');
    } catch (error) { setMessage((error as Error).message); }
  }

  if (loading) return <div className="login-shell"><div className="login-card"><b className="login-mark">研</b><p>正在载入训练系统…</p></div></div>;
  if (!user) return <Login onSubmit={login} message={message} />;

  return <div className="app">
    <header>
      <button className="logo" onClick={() => setPage('home')}><img className="logo-image" src="/logo.svg?v=3" alt="小鱼食品保研" loading="eager" /><span className="logo-training"><strong>保研面试训练</strong><small>INTERVIEW TRAINING</small></span></button>
      <nav>
        <button className={page === 'home' || page === 'answer' ? 'active' : ''} onClick={() => setPage('home')}>题库训练</button>
        <button className={page === 'history' ? 'active' : ''} onClick={() => setPage('history')}>作答记录 <i>{records.length}</i></button>
        <button className={page === 'settings' ? 'active' : ''} onClick={() => setPage('settings')}>设置</button>
        {user.role === 'admin' && <button className={page === 'management' ? 'active' : ''} onClick={() => setPage('management')}>管理后台</button>}
      </nav>
      <button className="user-chip" onClick={logout}>{user.displayName}<small>退出</small></button>
    </header>
    {message && <div className="notice">{message}</div>}

    {page === 'home' && <main>
      <section className="hero"><div><p className="eyebrow">— 推免面试 · 模拟训练</p><h1>把每一次开口，<br />都练成<span>底气。</span></h1><p className="lead">从随机抽题到限时作答，提前适应真实面试节奏。<br />录音和练习记录安全保存在服务器。</p></div><aside><span>累计训练</span><strong>{String(records.length).padStart(2, '0')}</strong><small>次个人作答</small><div><i style={{ width: `${Math.min(records.length / 3 * 100, 100)}%` }} /></div><p>建议完成 3 道不同类别题目</p></aside></section>
      <section className="practice-modes"><div className="title"><div><small>PRACTICE MODES</small><h2>选择练习方式</h2></div><span>随机练习 · 自主选题 · 完整面试模拟</span></div><div className="practice-mode-grid"><article><span>01</span><h3>随机抽题</h3><p>从指定类别随机抽一题，快速进入日常训练。</p><button onClick={() => document.getElementById('random-topic')?.scrollIntoView({ behavior: 'smooth' })}>开始随机练习</button></article><article><span>02</span><h3>从题库选题</h3><p>按题型和关键词筛选，自主选择想要练习的题目。</p><button onClick={() => setPage('picker')}>进入题库选题</button></article><article className="simulation-mode"><span>03</span><h3>真实场景模拟</h3><p>按完整面试流程连续作答，保留分段和全程录音。</p><button onClick={() => setPage('simulation')}>开始完整模拟</button></article></div></section>
      <section className="choose" id="random-topic"><div className="title"><div><small>RANDOM QUESTION</small><h2>随机抽取一个训练类别</h2></div><span>数据库题型 · 随机抽取 · 持久记录</span></div><div className="cards">{homeCards.map((card) => <article className={card.color} key={card.id}><div className="cardtop"><span>{card.no}</span><small>随机抽取</small></div><b className="symbol">{card.icon}</b><small className="en">{card.en}</small><h3>{card.name}</h3><p>{card.desc}</p><button onClick={() => draw(card.id)}>开始抽题 <span>→</span></button></article>)}</div></section>
      <section className="steps"><div><small>HOW IT WORKS</small><h2>四步完成一次高效练习</h2></div><ol><li><b>01</b>选择类别</li><li><b>02</b>3 秒准备</li><li><b>03</b>自动录音</li><li><b>04</b>复盘提升</li></ol></section>
    </main>}

    {page === 'answer' && question && <main className="answer-page"><button className="back" onClick={() => { stopMedia(); setPage('home'); }}>← 返回题库</button><div className="answer-head"><div><small>{question.category}</small><h1>模拟作答</h1></div><button className="again" onClick={() => draw(question.typeId)}>↻ 换一题</button></div><section className="question"><small>INTERVIEW QUESTION</small><b>Q</b><h2>{question.content}</h2>{question.subcategory && <span className="question-subcategory">{question.subcategory}</span>}<p>回答提示：观点明确 · 结构清晰 · 结合具体经历或案例</p>{countdown !== null && <div className="countdown"><div key={countdown}>{countdown}</div><strong>准备开始</strong><small>{readQuestion ? (autoRecord ? '朗读题目，朗读结束后自动录音' : '朗读题目后开始作答') : (autoRecord ? '倒计时结束后将自动录音' : '倒计时结束后开始作答')}</small></div>}</section>{referenceAnswer && <section className="reference-answer"><span className="section-kicker">REFERENCE ANSWER</span><h3>参考答案</h3><p>{referenceAnswer}</p></section>}<section className="response"><label>作答提纲 <small>选填</small></label><textarea disabled={countdown !== null} value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="记录你的回答框架、关键词或复盘笔记……" /><div className={`recorder ${recording ? 'on' : ''}`}><span><b>{recording ? '● 正在录音' : audioBlob ? '✓ 录音已完成' : '◉ 录制作答'}</b><small>{recording ? '请保持自然语速' : autoRecord ? '倒计时后自动开始，也可手动控制' : '自动录音已在设置中关闭'}</small></span><button disabled={countdown !== null} onClick={() => recording ? void stopRecording() : void startRecording()}>{recording ? '结束录音' : audioBlob ? '重新录制' : '开始录音'}</button></div></section><div className="actions"><button onClick={() => { stopMedia(); setPage('home'); }}>退出练习</button><button onClick={save} disabled={countdown !== null}>完成并保存记录 →</button></div></main>}
    {page === 'picker' && <QuestionPicker types={questionTypes} onBack={() => setPage('home')} onPick={startSelectedQuestion} />}
    {page === 'simulation' && <Simulation onBack={() => setPage('home')} />}

    {page === 'history' && <History records={records} cards={homeCards} autoTranscribe={autoTranscribe} onFilter={loadRecords} onNew={() => setPage('home')} onContinue={continueFromRecord} onReview={(group) => { setReviewGroup(group); setPage('review'); }} />}
    {page === 'settings' && <Settings autoRecord={autoRecord} avoidRepeated={avoidRepeated} readQuestion={readQuestion} onChange={(value, repeated, read) => { setAutoRecord(value); setAvoidRepeated(repeated); setReadQuestion(read); }} />}
    {page === 'review' && reviewGroup && <ReviewPage group={reviewGroup} autoTranscribe={autoTranscribe} onBack={() => { setPage('history'); void loadRecords(); }} />}
    {page === 'management' && user.role === 'admin' && <Management />}
    <footer><span>小鱼食品保研 · 保研面试训练</span><span>让准备看得见，让表达更从容。</span></footer>
  </div>;
}


function QuestionPicker({ types, onBack, onPick }: { types: QuestionType[]; onBack: () => void; onPick: (question: Question) => void }) {
  const [questions, setQuestions] = useState<Question[]>([]); const [typeId, setTypeId] = useState(''); const [search, setSearch] = useState(''); const [page, setPage] = useState(1); const [totalPages, setTotalPages] = useState(1); const [message, setMessage] = useState('');
  const load = useCallback(async (target = 1) => { try { const params = new URLSearchParams({ page: String(target), pageSize: '12' }); if (typeId) params.set('typeId', typeId); if (search.trim()) params.set('q', search.trim()); const data = await jsonFetch('/api/practice-questions?' + params); setQuestions(data.questions || []); setPage(data.page); setTotalPages(data.totalPages); } catch (error) { setMessage((error as Error).message); } }, [typeId, search]);
  useEffect(() => { void load(1); }, [load]);
  return <main className="picker-page"><button className="back" onClick={onBack}>← 返回练习方式</button><header><span className="section-kicker">PICK A QUESTION</span><h1>从题库选题</h1><p>筛选后直接选择一题练习，作答方式、录音和复盘与随机抽题完全一致。</p></header><form className="picker-filters" onSubmit={(event) => { event.preventDefault(); void load(1); }}><select value={typeId} onChange={(event) => setTypeId(event.target.value)}><option value="">全部题型</option>{types.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索题目或具体分类" /><button>筛选题目</button></form>{message && <div className="management-message">{message}</div>}<section className="picker-list">{questions.map((item) => <article key={item.id}><div><span className="tag-chip">{item.category}</span>{item.subcategory && <span className="tag-chip">{item.subcategory}</span>}<h2>{item.content}</h2><small>{item.hasAnswer ? '已配置参考答案' : '暂无参考答案'}</small></div><button onClick={() => onPick(item)}>练习这道题</button></article>)}{!questions.length && <div className="empty"><h3>没有符合条件的题目</h3><p>换一个筛选条件，或请管理员补充题库。</p></div>}</section><div className="pagination"><button disabled={page <= 1} onClick={() => void load(page - 1)}>← 上一页</button><span>第 {page} / {totalPages} 页</span><button disabled={page >= totalPages} onClick={() => void load(page + 1)}>下一页 →</button></div></main>;
}

type SimulationStep = { id: string; title: string; kind: 'intro' | 'question'; typeCode?: string; count?: number; timeSeconds?: number; allowFollowup?: boolean; prompt?: string; questionId?: number; question?: string; category?: string; subcategory?: string | null };
type SimulationTemplate = { id: number; name: string; description: string; totalSeconds: number; modules: SimulationStep[] | string; followupPrompt?: string; isActive?: boolean };
type SimulationAnswerDraft = { moduleIndex: number; moduleTitle: string; questionId?: number; question: string; answer: string; transcript: string; transcriptSegments?: TranscriptSegment[]; elapsedSeconds: number; audio?: Blob; followupQuestion?: string };

function Simulation({ onBack }: { onBack: () => void }) {
  const [templates, setTemplates] = useState<SimulationTemplate[]>([]); const [templateId, setTemplateId] = useState(''); const [sessionId, setSessionId] = useState(0); const [steps, setSteps] = useState<SimulationStep[]>([]); const [stepIndex, setStepIndex] = useState(0); const [answer, setAnswer] = useState(''); const [recording, setRecording] = useState(false); const [segmentBlob, setSegmentBlob] = useState<Blob | null>(null); const [drafts, setDrafts] = useState<SimulationAnswerDraft[]>([]); const [elapsed, setElapsed] = useState(0); const [stepStartedAt, setStepStartedAt] = useState(0); const [message, setMessage] = useState(''); const [followup, setFollowup] = useState<string | null>(null); const [fullAudio, setFullAudio] = useState<Blob | null>(null); const [autoRecord, setAutoRecord] = useState(true); const [readQuestion, setReadQuestion] = useState(false); const [countdown, setCountdown] = useState<number | null>(null); const [reading, setReading] = useState(false); const recorder = useRef<MediaRecorder | null>(null); const chunks = useRef<Blob[]>([]); const stream = useRef<MediaStream | null>(null); const fullRecorder = useRef<MediaRecorder | null>(null); const fullChunks = useRef<Blob[]>([]); const fullAudioRef = useRef<Blob | null>(null); const finishedRef = useRef(false); const speechRunId = useRef(0); const audioContext = useRef<AudioContext | null>(null); const realtimeSocket = useRef<WebSocket | null>(null); const realtimeContext = useRef<AudioContext | null>(null); const realtimeProcessor = useRef<ScriptProcessorNode | null>(null); const realtimeSource = useRef<MediaStreamAudioSourceNode | null>(null); const segmentTranscriptRef = useRef(''); const segmentTranscriptSegmentsRef = useRef<TranscriptSegment[]>([]);
  const playCue = useCallback((kind: 'countdown' | 'recording', value = 0) => {
    try {
      const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) return;
      audioContext.current ??= new AudioContextCtor(); const context = audioContext.current; void context.resume();
      const oscillator = context.createOscillator(); const gain = context.createGain(); const start = context.currentTime;
      const duration = kind === 'recording' ? 0.22 : 0.12; oscillator.type = 'sine'; oscillator.frequency.value = kind === 'recording' ? 880 : 520 + Math.max(0, value) * 70;
      gain.gain.setValueAtTime(0.0001, start); gain.gain.exponentialRampToValueAtTime(0.08, start + 0.015); gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      oscillator.connect(gain); gain.connect(context.destination); oscillator.start(start); oscillator.stop(start + duration + 0.02);
    } catch { /* Web Audio may wait for a user gesture. */ }
  }, []);
  useEffect(() => { jsonFetch('/api/simulations').then((data) => { setTemplates(data.templates || []); if (data.templates?.[0]) setTemplateId(String(data.templates[0].id)); }).catch((error) => setMessage((error as Error).message)); }, []);
  useEffect(() => { jsonFetch('/api/settings').then((data) => { setAutoRecord(Boolean(data.settings?.autoRecord)); setReadQuestion(Boolean(data.settings?.readQuestion)); }).catch(() => undefined); }, []);
  useEffect(() => { if (!sessionId) return; const timer = window.setInterval(() => setElapsed((value) => value + 1), 1000); return () => window.clearInterval(timer); }, [sessionId]);
  useEffect(() => () => { speechRunId.current += 1; window.speechSynthesis?.cancel(); stopRealtime(); if (recorder.current?.state === 'recording') recorder.current.stop(); if (fullRecorder.current?.state === 'recording') fullRecorder.current.stop(); stream.current?.getTracks().forEach((track) => track.stop()); }, []);
  const current = steps[stepIndex]; const totalSeconds = templates.find((item) => item.id === Number(templateId))?.totalSeconds || 0; const stepElapsed = stepStartedAt ? Math.max(0, Math.floor((Date.now() - stepStartedAt) / 1000)) : 0;
  const format = (seconds: number) => String(Math.floor(Math.max(0, seconds) / 60)).padStart(2, '0') + ':' + String(Math.max(0, seconds) % 60).padStart(2, '0');
  useEffect(() => {
    if (!sessionId || !totalSeconds || elapsed < totalSeconds || finishedRef.current) return;
    finishedRef.current = true;
    if (recorder.current?.state === 'recording') recorder.current.stop();
    const timeoutDrafts = current && (answer.trim() || segmentBlob) ? [...drafts, { moduleIndex: stepIndex, moduleTitle: followup ? current.title + ' · 老师追问' : current.title, questionId: current.questionId, question: followup || current.question || current.prompt || '', answer, transcript: answer, elapsedSeconds: Math.max(0, Math.floor((Date.now() - stepStartedAt) / 1000)), audio: segmentBlob || undefined, followupQuestion: followup || undefined }] : drafts;
    setMessage('总时长已到，系统正在自动保存本场模拟。');
    void finish(timeoutDrafts);
  }, [elapsed, totalSeconds, sessionId, current, answer, segmentBlob, drafts, stepIndex, followup, stepStartedAt]);
  async function startFullRecording() {
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.current = media; fullChunks.current = [];
      const value = new MediaRecorder(media);
      value.ondataavailable = (event) => { if (event.data.size) fullChunks.current.push(event.data); };
      value.onstop = () => { const blob = new Blob(fullChunks.current, { type: value.mimeType || 'audio/webm' }); fullAudioRef.current = blob; setFullAudio(blob); };
      fullRecorder.current = value; value.start(1000);
    } catch { setMessage('完整录音未开启：请允许浏览器使用麦克风。仍可继续用文字完成模拟。'); }
  }
  function stopRealtime() {
    try { if (realtimeSocket.current?.readyState === WebSocket.OPEN) realtimeSocket.current.send(JSON.stringify({ action: 'finish' })); } catch { /* ignore */ }
    realtimeProcessor.current?.disconnect(); realtimeSource.current?.disconnect(); realtimeProcessor.current = null; realtimeSource.current = null;
    if (realtimeContext.current) { void realtimeContext.current.close(); realtimeContext.current = null; }
    if (realtimeSocket.current && realtimeSocket.current.readyState < WebSocket.CLOSING) realtimeSocket.current.close(); realtimeSocket.current = null;
  }
  async function startRealtime() {
    const media = stream.current; if (!media || typeof WebSocket === 'undefined') return;
    stopRealtime();
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'; const socket = new WebSocket(`${protocol}://${window.location.host}/ws/realtime-asr`); socket.binaryType = 'arraybuffer'; realtimeSocket.current = socket;
    socket.onmessage = async (event) => {
      try {
        const raw = typeof event.data === 'string' ? event.data : event.data instanceof Blob ? await event.data.text() : new TextDecoder().decode(event.data);
        const payload = JSON.parse(raw); const sentence = payload?.payload?.output?.sentence; if (sentence?.text) { segmentTranscriptRef.current = (segmentTranscriptRef.current ? segmentTranscriptRef.current + ' ' : '') + String(sentence.text); segmentTranscriptSegmentsRef.current.push({ startMs: Number(sentence.begin_time) || 0, endMs: Number(sentence.end_time) || 0, text: String(sentence.text) }); setAnswer(segmentTranscriptRef.current); }
        if (payload?.type === 'error') setMessage(payload.message || '实时语音识别连接失败');
      } catch { /* ignore non-JSON upstream frames */ }
    };
    socket.onerror = () => setMessage('实时语音识别连接失败，本场仍会保存录音。');
    socket.onopen = () => {
      socket.send(JSON.stringify({ action: 'start', taskId: crypto.randomUUID(), sampleRate: 16000 }));
      const context = new AudioContext(); realtimeContext.current = context; const source = context.createMediaStreamSource(media); const processor = context.createScriptProcessor(4096, 1, 1); const mute = context.createGain(); mute.gain.value = 0;
      processor.onaudioprocess = (event) => { if (socket.readyState !== WebSocket.OPEN) return; const input = event.inputBuffer.getChannelData(0); const ratio = context.sampleRate / 16000; const length = Math.floor(input.length / ratio); const pcm = new Int16Array(length); for (let i = 0; i < length; i += 1) { const sample = Math.max(-1, Math.min(1, input[Math.floor(i * ratio)])); pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff; } socket.send(pcm.buffer); };
      source.connect(processor); processor.connect(mute); mute.connect(context.destination); realtimeSource.current = source; realtimeProcessor.current = processor; void context.resume();
    };
  }
  async function start() { try { const data = await jsonFetch('/api/simulations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ templateId: Number(templateId) }) }); setSessionId(data.sessionId); setSteps(data.steps); setStepIndex(0); setStepStartedAt(Date.now()); setElapsed(0); setDrafts([]); setAnswer(''); setFollowup(null); setSegmentBlob(null); setFullAudio(null); fullAudioRef.current = null; finishedRef.current = false; segmentTranscriptRef.current = ''; setReading(false); setCountdown(3); await startFullRecording(); void startRealtime(); } catch (error) { setMessage((error as Error).message); } }
  async function startRecording() { try { const media = stream.current || await navigator.mediaDevices.getUserMedia({ audio: true }); stream.current = media; chunks.current = []; const value = new MediaRecorder(media); value.ondataavailable = (event) => { if (event.data.size) chunks.current.push(event.data); }; value.onstop = () => { const blob = new Blob(chunks.current, { type: value.mimeType || 'audio/webm' }); setSegmentBlob(blob); setRecording(false); }; recorder.current = value; value.start(); setRecording(true); } catch { setMessage('无法使用麦克风，请先允许浏览器录音权限。'); } }
  const startRecordingWithCue = useCallback(async () => { playCue('recording'); await startRecording(); }, [playCue]);
  const countdownStepRef = useRef(-1);
  useEffect(() => {
    if (!sessionId || stepIndex === countdownStepRef.current) return;
    countdownStepRef.current = stepIndex;
    segmentTranscriptRef.current = ''; segmentTranscriptSegmentsRef.current = [];
    if (stepStartedAt) { setReading(false); setCountdown(3); }
  }, [sessionId, stepIndex, stepStartedAt]);
  useEffect(() => {
    if (!sessionId || countdown === null) return;
    playCue('countdown', countdown);
    setMessage(`准备开始 · ${countdown}`);
    const timer = window.setTimeout(() => {
      if (countdown > 1) { setCountdown(countdown - 1); return; }
      setCountdown(null); setMessage('');
      const text = current?.question || current?.prompt || '';
      if (readQuestion && text && 'speechSynthesis' in window) {
        const runId = ++speechRunId.current; let completed = false; setReading(true); window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text); utterance.lang = /[\u4e00-\u9fff]/.test(text) ? 'zh-CN' : 'en-US';
        const finishReading = () => { if (completed || speechRunId.current !== runId) return; completed = true; setReading(false); if (autoRecord) void startRecordingWithCue(); };
        utterance.onend = finishReading; utterance.onerror = finishReading; window.speechSynthesis.speak(utterance);
      } else { setReading(false); if (autoRecord) void startRecordingWithCue(); }
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [sessionId, countdown, current, readQuestion, autoRecord, playCue, startRecordingWithCue]);
  function stopRecording() { if (recorder.current?.state === 'recording') recorder.current.stop(); }
  async function stopFullRecording() { const value = fullRecorder.current; if (!value || value.state !== 'recording') return fullAudioRef.current; return new Promise<Blob | null>((resolve) => { value.addEventListener('stop', () => resolve(fullAudioRef.current), { once: true }); value.stop(); }); }
  async function generateFollowup(sourceAnswer = answer, primaryAlreadySaved = false) { if (!current || !sourceAnswer.trim()) return; if (!primaryAlreadySaved) { saveCurrent(current.title, current.question || current.prompt || ''); } try { const data = await jsonFetch('/api/simulations/' + sessionId + '/followup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: current.question || current.prompt, answer: sourceAnswer, moduleTitle: current.title }) }); setFollowup(data.followup); } catch (error) { setMessage((error as Error).message); } }
  function saveCurrent(title = current?.title || '', question = followup || current?.question || current?.prompt || '', followupQuestion?: string) { if (!current) return null; const draft = { moduleIndex: stepIndex, moduleTitle: followup ? current.title + ' · 老师追问' : title, questionId: current.questionId, question, answer, transcript: answer, elapsedSeconds: Math.max(0, Math.floor((Date.now() - stepStartedAt) / 1000)), audio: segmentBlob || undefined, followupQuestion }; setDrafts((items) => [...items, draft]); setAnswer(''); setSegmentBlob(null); setFollowup(null); return draft; }
  async function beginFollowup() { const sourceAnswer = answer; saveCurrent(current?.title || '', current?.question || current?.prompt || ''); await generateFollowup(sourceAnswer, true); }
  async function next() { if (recording) { setMessage('请先结束本段录音，再进入下一环节。'); return; } if (current?.allowFollowup && answer.trim() && !followup) { await beginFollowup(); return; } const saved = saveCurrent(); if (stepIndex + 1 < steps.length) { setStepIndex((value) => value + 1); setStepStartedAt(Date.now()); } else await finish(saved ? [...drafts, saved] : drafts); }
  async function finish(finalDrafts = drafts) { if (!sessionId) return; try { const form = new FormData(); form.set('elapsedSeconds', String(elapsed)); form.set('transcript', finalDrafts.map((item) => item.transcript).filter(Boolean).join('\n')); form.set('answers', JSON.stringify(finalDrafts)); finalDrafts.forEach((item, index) => { if (item.audio) form.set('audio-' + index, new File([item.audio], 'segment-' + index + '.webm', { type: item.audio.type || 'audio/webm' })); }); const whole = await stopFullRecording() || fullAudio || fullAudioRef.current; if (whole) form.set('fullAudio', new File([whole], 'simulation.webm', { type: whole.type || 'audio/webm' })); await jsonFetch('/api/simulations/' + sessionId, { method: 'POST', body: form }); stream.current?.getTracks().forEach((track) => track.stop()); setMessage('完整模拟已保存。'); onBack(); } catch (error) { setMessage((error as Error).message); } }
  if (!sessionId) return <main className="simulation-page"><button className="back" onClick={onBack}>← 返回练习方式</button><header><span className="section-kicker">REAL INTERVIEW SIMULATION</span><h1>真实场景模拟</h1><p>用连续流程还原正式面试；每段作答独立记录，全流程也会保存为一段录音。</p></header>{message && <div className="management-message">{message}</div>}<div className="simulation-template-list">{templates.map((item) => <label className={templateId === String(item.id) ? 'active' : ''} key={item.id}><input type="radio" value={item.id} checked={templateId === String(item.id)} onChange={(event) => setTemplateId(event.target.value)} /><strong>{item.name}</strong><span>{item.description}</span><small>总时长 {format(item.totalSeconds)} · {Array.isArray(item.modules) ? item.modules.length : 0} 个模块</small></label>)}</div><button className="simulation-start" disabled={!templateId} onClick={() => void start()}>开始完整模拟</button></main>;
  if (!current) return null;
  const prompt = followup || current.question || current.prompt || '请开始作答。';
  return <main className="simulation-page running"><div className="simulation-running-head"><button className="back" onClick={onBack}>退出模拟</button><div><span>全程倒计时</span><strong>{format(totalSeconds - elapsed)}</strong></div><div><span>本环节建议时长</span><strong className={stepElapsed > (current.timeSeconds || 0) ? 'overtime' : ''}>{format(current.timeSeconds || 0)}</strong></div></div><ol className="simulation-puzzle">{steps.map((item, index) => <li className={index === stepIndex ? 'active' : index < stepIndex ? 'done' : ''} key={item.id}><b>{String(index + 1).padStart(2, '0')}</b><span>{item.title}</span></li>)}</ol><section className="simulation-question"><span className="section-kicker">{followup ? 'TEACHER FOLLOW-UP' : current.title}</span><h1>{prompt}</h1>{current.subcategory && <small>{current.subcategory}</small>}<p>{followup ? '这是基于刚才回答生成的老师追问，请继续作答。' : '本环节超过建议时长只会提醒；全程时间到后应结束模拟。'}</p></section><section className="simulation-answer"><textarea value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="可选：记录回答提纲；录音和实时文字稿将保存到本场模拟。" /><div className="recorder"><span><b>{recording ? '正在分段录音' : segmentBlob ? '本段录音已完成' : '准备录制本段回答'}</b><small>当前模块：{current.title}</small></span><button onClick={() => recording ? stopRecording() : void startRecording()}>{recording ? '结束本段录音' : '开始本段录音'}</button></div>{current.allowFollowup && !followup && <button className="secondary-action" disabled={!answer.trim()} onClick={() => void beginFollowup()}>生成老师追问</button>}</section><div className="simulation-actions"><button onClick={() => void next()}>{followup ? '完成追问并进入下一环节' : stepIndex + 1 === steps.length ? '完成模拟并保存' : '保存本段并进入下一环节'}</button></div></main>;
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

function History({ records, cards, autoTranscribe, onFilter, onNew, onContinue, onReview }: { records: RecordItem[]; cards: HomeCard[]; autoTranscribe: boolean; onFilter: (category?: string, search?: string) => Promise<void>; onNew: () => void; onContinue: (item: RecordItem) => void; onReview: (group: RecordGroup) => void }) {
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [jumpPage, setJumpPage] = useState('1');
  const [selectedKey, setSelectedKeyState] = useState<string | null>(null);
  const [message, setMessage] = useState('');
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
  const selectedGroup = selectedKey ? groups.find((group) => group.key === selectedKey) || null : null;
  function setSelectedKey(nextKey: string | null) {
    if (nextKey) {
      const target = groups.find((group) => group.key === nextKey);
      if (target) { onReview(target); return; }
    }
    setSelectedKeyState(nextKey);
  }
  useEffect(() => {
    if (!autoTranscribe || !records.some((item) => item.transcriptStatus === 'processing')) return;
    const timer = window.setInterval(() => { void onFilter(category, search).catch(() => undefined); }, 5000);
    return () => window.clearInterval(timer);
  }, [autoTranscribe, records, category, search, onFilter]);

  function applyFilter(event: FormEvent) {
    event.preventDefault(); setPage(1); setJumpPage('1'); void onFilter(category, search);
  }
  function jump(event: FormEvent) {
    event.preventDefault();
    const target = Math.min(totalPages, Math.max(1, Number(jumpPage) || 1));
    setPage(target); setJumpPage(String(target));
  }
  async function transcribe(item: RecordItem) {
    setMessage('');
    try {
      await jsonFetch('/api/records/' + item.id + '/transcription', { method: 'POST' });
      setMessage('已开始生成文字稿，请稍候查看。');
      await onFilter(category, search);
    } catch (error) { setMessage((error as Error).message); }
  }

  return <main className="history-page">
    <div className="history-head"><div><p className="eyebrow">— PRACTICE ARCHIVE</p><h1>作答记录</h1><p>相同题目会合并展示，点击记录可查看答案、录音和文字稿。</p></div><button onClick={onNew}>＋ 新的练习</button></div>
    <div className="stats"><div><span>题目记录</span><strong>{groups.length}<small> 题</small></strong></div><div><span>累计作答</span><strong>{records.length}<small> 次</small></strong></div><div><span>保存录音</span><strong>{records.filter((r) => r.hasAudio).length}<small> 条</small></strong></div></div>
    <form className="filters" onSubmit={applyFilter}><select value={category} onChange={(event) => { setCategory(event.target.value); setPage(1); }}><option value="">全部类别</option>{cards.map((card) => <option key={card.name}>{card.name}</option>)}</select><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索题目或作答内容" /><button>筛选记录</button></form>
    {message && <div className="management-message">{message}</div>}
    <section className="records">{visibleGroups.length ? visibleGroups.map((group, index) => {
      const latest = group.attempts[0];
      return <article className="record-group" key={group.key}><b>{String((page - 1) * pageSize + index + 1).padStart(2, '0')}</b><div className="record-group-main"><small>{group.username ? '学员：' + group.username + ' · ' : ''}{group.category} · {group.attempts.length} 次作答</small><h3>{group.question}</h3><p className="record-latest">{formatRecordDate(latest.createdAt)} · {latest.hasAudio ? '含录音' : '无录音'} · {latest.referenceAnswer ? '有参考答案' : '暂无参考答案'}</p><div className="record-group-actions"><button className="record-open" onClick={() => onReview(group)}>查看复盘 <span>→</span></button>{latest.questionId && latest.typeId && <button className="record-continue" onClick={() => onContinue(latest)}>继续作答</button>}</div></div></article>;
    }) : <div className="empty"><b>复</b><h3>还没有作答记录</h3><p>完成一次练习后，录音、答案和复盘信息会出现在这里。</p></div>}</section>
    <div className="pagination"><button disabled={page <= 1} onClick={() => setPage(page - 1)}>← 上一页</button><span>第 {page} / {totalPages} 页</span><button disabled={page >= totalPages} onClick={() => setPage(page + 1)}>下一页 →</button><form className="page-jump" onSubmit={jump}><input type="number" min="1" max={totalPages} value={jumpPage} onChange={(event) => setJumpPage(event.target.value)} /><button>跳转</button></form></div>
    {selectedGroup && <div className="modal-backdrop record-detail-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedKey(null); }}><section className="record-detail-modal" role="dialog" aria-modal="true" aria-labelledby="record-detail-title"><button type="button" className="modal-close" aria-label="关闭记录详情" onClick={() => setSelectedKey(null)}>×</button><span className="section-kicker">PRACTICE DETAIL</span><small className="record-detail-meta">{selectedGroup.username ? '学员：' + selectedGroup.username + ' · ' : ''}{selectedGroup.category} · {selectedGroup.attempts.length} 次作答</small><h2 id="record-detail-title">{selectedGroup.question}</h2><div className="record-detail-actions"><button className="review-trigger" onClick={() => { onReview(selectedGroup); setSelectedKey(null); }}>进入 AI 复盘</button>{selectedGroup.attempts[0].questionId && selectedGroup.attempts[0].typeId && <button className="modal-submit" onClick={() => { onContinue(selectedGroup.attempts[0]); setSelectedKey(null); }}>继续作答</button>}</div><section className="detail-reference">{selectedGroup.attempts[0].referenceAnswer ? <><span className="section-kicker">REFERENCE ANSWER</span><h3>参考答案</h3><p>{selectedGroup.attempts[0].referenceAnswer}</p></> : <><span className="section-kicker">REFERENCE ANSWER</span><h3>暂无参考答案</h3><p>这道题暂时没有配置参考答案。</p></>}</section><div className="detail-attempts"><h3>每次具体作答</h3>{selectedGroup.attempts.map((item, index) => <article className="detail-attempt" key={item.id}><div className="detail-attempt-head"><strong>第 {selectedGroup.attempts.length - index} 次</strong><small>{formatRecordDate(item.createdAt)}</small></div><p className="detail-answer-label">文字作答</p><p className="detail-answer">{item.answer || '本次未填写文字作答。'}</p>{item.hasAudio ? <TranscriptViewer item={item} onTranscribe={() => void transcribe(item)} /> : <p className="no-audio">这次作答没有录音。</p>}</article>)}</div><section className="ai-placeholder"><span className="section-kicker">AI REVIEW</span><h3>AI 复盘已经独立成页</h3><p>点击上方“进入 AI 复盘”，可以生成评估、查看历史比较并继续对话。</p></section></section></div>}
  </main>;
}
function TranscriptViewer({ item, autoTranscribe = false, onTranscribe }: { item: RecordItem; autoTranscribe?: boolean; onTranscribe: () => void }) {
  const [mode, setMode] = useState<'full' | 'segments'>('full');
  const segments = parseTranscriptSegments(item.transcriptSegments);
  const canShowSegments = segments.length > 0;

  if (item.transcriptStatus === 'completed' && item.transcript) {
    return <div className="detail-audio"><audio controls preload="none" src={'/api/records/' + item.id + '/audio'} /><div className="transcript-box"><div className="transcript-toolbar"><span className="transcript-state done">录音文字稿</span>{canShowSegments && <div className="transcript-toggle"><button type="button" className={mode === 'full' ? 'active' : ''} onClick={() => setMode('full')}>完整文字</button><button type="button" className={mode === 'segments' ? 'active' : ''} onClick={() => setMode('segments')}>时间分片</button></div>}</div>{mode === 'segments' && canShowSegments ? <div className="transcript-segments">{segments.map((segment, index) => <p className="transcript-segment" key={segment.startMs + '-' + segment.endMs + '-' + index}><time>{formatTranscriptTime(segment.startMs)} - {formatTranscriptTime(segment.endMs)}</time><span>{segment.text}</span></p>)}</div> : <p>{item.transcript}</p>}</div></div>;
  }
  if (autoTranscribe && item.transcriptStatus === 'failed') {
    return <div className={'detail-audio'}><audio controls preload={'none'} src={'/api/records/' + item.id + '/audio'} /><div className={'transcript-box'}><span className={'transcript-state failed'}>自动转写失败</span><p>{item.transcriptError || '自动转写失败，请联系管理员检查百炼配置。'}</p></div></div>;
  }
  if (autoTranscribe && item.transcriptStatus !== 'processing') {
    return <div className={'detail-audio'}><audio controls preload={'none'} src={'/api/records/' + item.id + '/audio'} /><div className={'transcript-box'}><span className={'transcript-state pending'}>自动转写已开启</span><p>录音保存后会自动生成文字稿，请稍候查看。</p></div></div>;
  }
  if (item.transcriptStatus === 'processing') {
    return <div className="detail-audio"><audio controls preload="none" src={'/api/records/' + item.id + '/audio'} /><div className="transcript-box"><span className="transcript-state pending">正在生成文字稿…</span><p>转写服务正在处理，请稍候，页面会自动刷新。</p></div></div>;
  }
  if (item.transcriptStatus === 'failed') {
    return <div className="detail-audio"><audio controls preload="none" src={'/api/records/' + item.id + '/audio'} /><div className="transcript-box"><span className="transcript-state failed">生成失败</span><p>{item.transcriptError || '转写失败，请重试。'}</p><button type="button" onClick={onTranscribe}>重新生成文字稿</button></div></div>;
  }
  return <div className="detail-audio"><audio controls preload="none" src={'/api/records/' + item.id + '/audio'} /><div className="transcript-box"><button type="button" onClick={onTranscribe}>生成录音文字稿</button></div></div>;
}
function Settings({ autoRecord, avoidRepeated, readQuestion, onChange }: { autoRecord: boolean; avoidRepeated: boolean; readQuestion: boolean; onChange: (value: boolean, avoidRepeated: boolean, readQuestion: boolean) => void }) {
  const [saved, setSaved] = useState('');
  const [guideOpen, setGuideOpen] = useState(false);
  const [origin, setOrigin] = useState('');
  const [copied, setCopied] = useState(false);
  const [browserHint, setBrowserHint] = useState<'chrome' | 'edge' | null>(null);
  const [copiedBrowserUrl, setCopiedBrowserUrl] = useState(false);
  const browserUrls = {
    chrome: 'chrome://flags/#unsafely-treat-insecure-origin-as-secure',
    edge: 'edge://flags/#unsafely-treat-insecure-origin-as-secure',
  } as const;

  useEffect(() => { setOrigin(window.location.origin); }, []);
  useEffect(() => {
    if (!guideOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setGuideOpen(false); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [guideOpen]);

  async function update(nextAutoRecord: boolean, nextAvoidRepeated: boolean, nextReadQuestion: boolean) { await jsonFetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoRecord: nextAutoRecord, avoidRepeated: nextAvoidRepeated, readQuestion: nextReadQuestion }) }); onChange(nextAutoRecord, nextAvoidRepeated, nextReadQuestion); setSaved('设置已保存'); }
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
  async function copyBrowserSettingsUrl() {
    if (!browserHint) return;
    const url = browserUrls[browserHint];
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const input = document.createElement('textarea');
      input.value = url; input.style.position = 'fixed'; input.style.opacity = '0';
      document.body.appendChild(input); input.select(); document.execCommand('copy'); input.remove();
    }
    setCopiedBrowserUrl(true); window.setTimeout(() => setCopiedBrowserUrl(false), 2200);
  }
  function openBrowserSettings(browser: 'chrome' | 'edge') {
    const url = browserUrls[browser];
    setBrowserHint(browser); setCopiedBrowserUrl(false);
    // This must run directly in the click handler; browsers may still block
    // chrome:// and edge:// navigation, so a visible manual fallback is shown.
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  return <main className="panel-page"><p className="eyebrow">— PERSONAL SETTINGS</p><h1>系统设置</h1><section className="setting-card"><div><h2>题目显示后自动录音</h2><p>开启后，3 秒准备倒计时结束时自动请求麦克风并开始录制。</p></div><button className={`switch ${autoRecord ? 'on' : ''}`} onClick={() => void update(!autoRecord, avoidRepeated, readQuestion)} aria-label="切换自动录音"><i /></button></section><section className="setting-card"><div><h2>抽题时避开已练习题目</h2><p>开启后，系统会优先抽取你还没有练习过的题目。</p></div><button className={avoidRepeated ? 'switch on' : 'switch'} onClick={() => void update(autoRecord, !avoidRepeated, readQuestion)} aria-label="切换重复题目设置"><i /></button></section><section className="setting-card"><div><h2>题目显示后朗读</h2><p>开启后，3 秒倒计时结束时使用浏览器语音朗读当前题目，朗读结束后再开始自动录音，支持中文和英文。</p></div><button className={readQuestion ? 'switch on' : 'switch'} onClick={() => void update(autoRecord, avoidRepeated, !readQuestion)} aria-label="切换题目朗读"><i /></button></section>{saved && <p className="saved">✓ {saved}</p>}<section className="permission-card"><div><span className="section-kicker">BROWSER PERMISSION</span><h2>HTTP 环境录音权限</h2><p>当前使用 IP + HTTP 时，浏览器默认不会开放麦克风。打开配置指引，可复制当前网址并快速进入 Chrome / Edge 的安全设置。</p></div><button className="permission-guide-trigger" onClick={() => setGuideOpen(true)}>查看配置指引 <span>→</span></button></section><div className="security-note"><b>数据存储说明</b><p>账号、题库、设置、作答记录和录音都保存在服务器 MySQL 数据库中。</p></div>{guideOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setGuideOpen(false); }}><div className="permission-modal" role="dialog" aria-modal="true" aria-labelledby="permission-guide-title"><button type="button" className="modal-close" aria-label="关闭录音权限指引" onClick={() => setGuideOpen(false)}>×</button><span className="section-kicker">MICROPHONE ACCESS</span><h2 id="permission-guide-title">开启 HTTP 录音权限</h2><p className="permission-intro">网页不能直接修改浏览器实验性开关，但可以帮你准备好要加入白名单的地址。</p><ol className="permission-steps"><li><b>01</b><div><strong>复制当前网址</strong><small>将下面的地址加入浏览器的安全来源列表。</small></div></li><li><b>02</b><div><strong>打开浏览器实验设置</strong><small>Chrome 或 Edge 中搜索 <code>unsafely-treat-insecure-origin-as-secure</code>。</small></div></li><li><b>03</b><div><strong>启用并重启浏览器</strong><small>把地址粘贴到白名单后，将开关设为 Enabled，再重启浏览器。</small></div></li></ol><div className="permission-origin"><code>{origin || '正在读取当前网址…'}</code><button type="button" onClick={() => void copyOrigin()} disabled={!origin}>{copied ? '已复制' : '复制地址'}</button></div><div className="permission-links"><button type="button" onClick={() => openBrowserSettings('chrome')}>打开 Chrome 设置</button><button type="button" onClick={() => openBrowserSettings('edge')}>打开 Edge 设置</button></div>{browserHint && <div className="browser-settings-fallback" role="status"><strong>若没有自动打开，请在地址栏直接访问：</strong><code>{browserUrls[browserHint]}</code><button type="button" onClick={() => void copyBrowserSettingsUrl()}>{copiedBrowserUrl ? '已复制' : '复制设置地址'}</button></div>}<p className="permission-warning">提示：这是浏览器临时兼容方案，仅建议本机开发使用。正式上线请使用 HTTPS。</p></div></div>}</main>;
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



type AiEvaluation = { id: number; status: string; result: string | null; error: string | null; createdAt: string; completedAt?: string | null };
type AiMessage = { id: number; role: 'user' | 'assistant'; content: string; evaluationId?: number | null; createdAt?: string };

function ReviewPage({ group, autoTranscribe, onBack }: { group: RecordGroup; autoTranscribe: boolean; onBack: () => void }) {
  const [evaluations, setEvaluations] = useState<AiEvaluation[]>([]);
  const [expandedEvaluationIds, setExpandedEvaluationIds] = useState<number[] | null>(null);
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [message, setMessage] = useState('');
  const questionId = group.questionId;
  const latest = group.attempts[0];
  const load = useCallback(async () => {
    if (!questionId) return;
    try {
      const data = await jsonFetch('/api/ai/evaluations?questionId=' + questionId + '&userId=' + group.userId);
      setEvaluations(data.evaluations || []);
      setMessages(data.messages || []);
    } catch (error) { setMessage((error as Error).message); }
    finally { setLoading(false); }
  }, [questionId, group.userId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!evaluations.some((item) => item.status === 'processing')) return;
    const timer = window.setInterval(() => { void load(); }, 4000);
    return () => window.clearInterval(timer);
  }, [evaluations, load]);

  async function generate() {
    if (!questionId || generating) return;
    setGenerating(true); setMessage('');
    try {
      const data = await jsonFetch('/api/ai/evaluations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ questionId, userId: group.userId }) });
      setMessage(data.reused ? '最近一次作答已经评估过，没有新的回答可生成。' : '评估已提交，正在生成，请稍候。');
      await load();
    } catch (error) { setMessage((error as Error).message); }
    finally { setGenerating(false); }
  }
  async function sendChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = chatInput.trim();
    if (!content || !questionId || chatLoading) return;
    setChatLoading(true); setMessage('');
    const clientId = -Date.now();
    setMessages((current) => [...current, { id: clientId - 1, role: 'user', content }, { id: clientId, role: 'assistant', content: '' }]);
    setChatInput('');
    try {
      const response = await fetch('/api/ai/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify({ questionId, userId: group.userId, message: content }) });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || '发送失败');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('浏览器不支持流式响应');
      const decoder = new TextDecoder(); let buffer = '';
      const applyEvent = (raw: string) => {
        const line = raw.split(/\r?\n/).find((item) => item.startsWith('data:'));
        if (!line) return;
        try {
          const payload = JSON.parse(line.slice(5).trim()) as { type?: string; content?: string; error?: string };
          if (payload.type === 'delta' && payload.content) setMessages((current) => current.map((item) => item.id === clientId ? { ...item, content: item.content + payload.content } : item));
          if (payload.type === 'error') throw new Error(payload.error || '对话生成失败');
        } catch (error) { if (error instanceof Error) throw error; }
      };
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/); buffer = events.pop() || '';
        events.forEach(applyEvent);
      }
      if (buffer.trim()) applyEvent(buffer);
      await load();
    } catch (error) { setMessage((error as Error).message); }
    finally { setChatLoading(false); }
  }
  async function transcribeAttempt(item: RecordItem) {
    try {
      await jsonFetch('/api/records/' + item.id + '/transcription', { method: 'POST' });
      setMessage('已开始生成文字稿，请稍候。');
      await load();
    } catch (error) { setMessage((error as Error).message); }
  }

  const completed = evaluations.find((item) => item.status === 'completed');
  return <main className="review-page">
    <header className="review-hero review-toolbar">
      <button className="review-back" onClick={onBack} aria-label="返回作答记录">返回作答记录</button>
      <div className="review-toolbar-title"><span className="section-kicker">QUESTION REVIEW</span><h1>问题复盘</h1></div>
      <div className="review-toolbar-actions"><button className="review-chat-open" onClick={() => setChatOpen(true)}>和小鱼讨论</button><button className="review-generate" disabled={!questionId || generating} onClick={() => void generate()}>{generating ? '正在提交…' : completed ? '更新评估' : '生成评估'}</button></div>
    </header>
    {message && <div className="management-message">{message}</div>}
    {!questionId ? <div className="empty"><h3>原题目已经不存在</h3><p>这条记录缺少题目编号，暂时无法建立独立的 AI 对话。</p></div> : <div className="review-grid">
      <section className="review-main">
        <div className="review-question-card"><span className="section-kicker">INTERVIEW QUESTION</span><h2>{group.question}</h2><div className="review-question-meta"><span>{group.category}</span><span>{group.attempts.length} 次作答</span><span>{latest.hasReferenceAnswer ? '有参考答案' : '暂无参考答案'}</span></div></div>
        <section className="review-section"><div className="review-section-title"><div><span className="section-kicker">RECENT ATTEMPTS</span><h2>最近的回答</h2></div><small>按时间倒序，最多取 3 次</small></div>{group.attempts.slice(0, 3).map((item, index) => {
          return <article className="review-attempt" key={item.id}><div className="review-attempt-head"><strong>第 {group.attempts.length - index} 次</strong><small>{formatRecordDate(item.createdAt)}</small></div><p className="review-answer">{item.answer || '本次没有填写文字作答。'}</p>{item.hasAudio && <TranscriptViewer item={item} autoTranscribe={autoTranscribe} onTranscribe={() => void transcribeAttempt(item)} />}</article>;
        })}</section>
      </section>
      <section className="review-evaluations review-section"><div className="review-section-title"><div><span className="section-kicker">EVALUATIONS</span><h2>评估结果</h2></div><small>{loading ? '正在读取…' : evaluations.length + ' 次评估'}</small></div>{evaluations.length ? evaluations.map((item, index) => <details className="evaluation-card" key={item.id} open={expandedEvaluationIds ? expandedEvaluationIds.includes(item.id) : index === 0} onToggle={(event) => { const isOpen = event.currentTarget.open; setExpandedEvaluationIds((current) => { const next = new Set(current ?? evaluations.filter((_value, position) => position === 0).map((value) => value.id)); if (isOpen) next.add(item.id); else next.delete(item.id); return [...next]; }); }}><summary><span><strong>{index === 0 ? '最新评估' : '历史评估 ' + (evaluations.length - index)}</strong><small>{formatRecordDate(item.createdAt)}</small></span><em>{item.status === 'processing' ? '生成中' : item.status === 'completed' ? '已完成' : '失败'}</em></summary>{item.status === 'processing' && <p className="evaluation-pending">AI 正在分析最近的回答，请稍候，页面会自动刷新。</p>}{item.status === 'failed' && <p className="evaluation-error">{item.error || '本次评估失败。'}</p>}{item.status === 'completed' && <MarkdownContent value={item.result || ''} className="evaluation-result" />}</details>) : <div className="review-empty">还没有评估。生成评估后，这里会保留每一次可展开查看的反馈。</div>}</section>
    </div>}
    {chatOpen && <div className="chat-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !chatLoading) setChatOpen(false); }}><section className="chat-modal" role="dialog" aria-modal="true" aria-labelledby="chat-modal-title"><div className="chat-modal-head"><div><span className="section-kicker">QUESTION DISCUSSION</span><h2 id="chat-modal-title">和小鱼讨论</h2><p>围绕这道题追问、打磨表达或模拟追问。</p></div><button className="chat-modal-close" aria-label="关闭对话" disabled={chatLoading} onClick={() => setChatOpen(false)}>×</button></div><div className="chat-messages">{messages.length ? messages.map((item) => <div className={'chat-message ' + item.role} key={item.id}><MarkdownContent value={item.content || (chatLoading ? '正在思考…' : '')} /></div>) : <div className="chat-empty">还没有对话。试着让小鱼把你的回答打磨得更清晰、有说服力。</div>}</div><form className="chat-form" onSubmit={sendChat}><textarea value={chatInput} onChange={(event) => setChatInput(event.target.value)} placeholder="例如：请把我的回答改成 90 秒的结构化版本。" disabled={chatLoading} /><button disabled={chatLoading || !chatInput.trim()}>{chatLoading ? '生成中…' : '发送'}</button></form></section></div>}
  </main>;
}

function Management() {
  const [tab, setTab] = useState<'users' | 'questions' | 'ai' | 'simulation'>('users');
  return <main className="management-hub"><header className="management-hub-head"><div><p className="eyebrow">— ADMIN CONSOLE</p><h1>管理后台</h1><p>集中管理用户、题库、AI 和真实模拟配置。</p></div></header><nav className="management-tabs"><button className={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}>用户管理<span>注册审批与账号</span></button><button className={tab === 'questions' ? 'active' : ''} onClick={() => setTab('questions')}>题库管理<span>题目与 Excel</span></button><button className={tab === 'ai' ? 'active' : ''} onClick={() => setTab('ai')}>AI 模型管理<span>平台、模型与提示词</span></button><button className={tab === 'simulation' ? 'active' : ''} onClick={() => setTab('simulation')}>真实模拟<span>流程与实时转写</span></button></nav><div className="management-hub-content">{tab === 'users' ? <Users /> : tab === 'questions' ? <QuestionBank /> : tab === 'ai' ? <AiConfig /> : <SimulationConfig />}</div></main>;
}

function SimulationConfig() {
  const [templates, setTemplates] = useState<SimulationTemplate[]>([]); const [selected, setSelected] = useState<SimulationTemplate | null>(null); const [realtime, setRealtime] = useState<{ provider: string; websocketUrl: string; model: string; apiKey?: string; apiKeySet?: boolean; apiKeyPreview?: string } | null>(null); const [message, setMessage] = useState('');
  const load = useCallback(async () => { try { const data = await jsonFetch('/api/simulations/config'); setTemplates(data.templates || []); setSelected((current) => current || data.templates?.[0] || null); setRealtime(data.realtimeAsr); } catch (error) { setMessage((error as Error).message); } }, []);
  useEffect(() => { void load(); }, [load]);
  const modules = selected ? (Array.isArray(selected.modules) ? selected.modules : JSON.parse(selected.modules || '[]')) as SimulationStep[] : [];
  function updateModule(index: number, patch: Partial<SimulationStep>) { if (!selected) return; const next = modules.map((item, position) => position === index ? { ...item, ...patch } : item); setSelected({ ...selected, modules: next }); }
  async function saveTemplate() { if (!selected) return; try { await jsonFetch('/api/simulations/config', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ template: selected }) }); setMessage('模拟流程已保存'); await load(); } catch (error) { setMessage((error as Error).message); } }
  async function saveRealtime() { if (!realtime) return; try { await jsonFetch('/api/simulations/config', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ realtimeAsr: realtime }) }); setMessage('实时语音识别配置已保存'); await load(); } catch (error) { setMessage((error as Error).message); } }
  return <section className="simulation-config"><header><span className="section-kicker">SIMULATION BUILDER</span><h2>真实场景模拟</h2><p>每张卡片代表一个拼图模块：可设置题型、抽题数量、单题建议时长与是否进入老师追问。</p></header>{message && <div className="management-message">{message}</div>}<div className="simulation-config-grid"><section className="simulation-builder"><label>选择流程<select value={selected?.id || ''} onChange={(event) => setSelected(templates.find((item) => item.id === Number(event.target.value)) || null)}>{templates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>{selected && <><label>流程名称<input value={selected.name} onChange={(event) => setSelected({ ...selected, name: event.target.value })} /></label><label>总时长（秒）<input type="number" min="60" value={selected.totalSeconds} onChange={(event) => setSelected({ ...selected, totalSeconds: Number(event.target.value) || 60 })} /></label><label>老师追问提示词<textarea value={selected.followupPrompt || ''} onChange={(event) => setSelected({ ...selected, followupPrompt: event.target.value })} placeholder="用于生成本流程中老师追问的问题" /></label><div className="module-puzzle-list">{modules.map((item, index) => <article key={item.id}><b>{String(index + 1).padStart(2, '0')}</b><label>模块名称<input value={item.title} onChange={(event) => updateModule(index, { title: event.target.value })} /></label><label>类型<select value={item.kind} onChange={(event) => updateModule(index, { kind: event.target.value as 'intro' | 'question' })}><option value="intro">自我介绍 / 固定题</option><option value="question">从题库抽题</option></select></label>{item.kind === 'question' && <label>题型编码<input value={item.typeCode || ''} onChange={(event) => updateModule(index, { typeCode: event.target.value })} placeholder="professional / english / comprehensive" /></label>}<label>抽题数<input type="number" min="1" value={item.count || 1} onChange={(event) => updateModule(index, { count: Number(event.target.value) || 1 })} /></label><label>建议时长（秒）<input type="number" min="30" value={item.timeSeconds || 120} onChange={(event) => updateModule(index, { timeSeconds: Number(event.target.value) || 30 })} /></label><label className="module-followup"><input type="checkbox" checked={Boolean(item.allowFollowup)} onChange={(event) => updateModule(index, { allowFollowup: event.target.checked })} /> 本题后进入老师追问</label></article>)}</div><button className="create-trigger" onClick={() => setSelected({ ...selected, modules: [...modules, { id: 'module-' + Date.now(), title: '新模块', kind: 'question', typeCode: 'professional', count: 1, timeSeconds: 120, allowFollowup: false }] })}>＋ 添加模块</button><button className="modal-submit" onClick={() => void saveTemplate()}>保存模拟流程</button></>}</section><section className="realtime-asr-card"><span className="section-kicker">REALTIME ASR</span><h3>实时语音识别 API</h3><p>仅用于真实模拟流程；普通练习继续使用原有的 Paraformer 转写配置。</p>{realtime && <><label>服务平台<input value={realtime.provider} onChange={(event) => setRealtime({ ...realtime, provider: event.target.value })} /></label><label>WebSocket 地址<input value={realtime.websocketUrl} onChange={(event) => setRealtime({ ...realtime, websocketUrl: event.target.value })} /></label><label>模型名称<input value={realtime.model} onChange={(event) => setRealtime({ ...realtime, model: event.target.value })} /></label><label>API Key {realtime.apiKeySet && <small className="key-preview">当前：{realtime.apiKeyPreview}（留空不修改）</small>}<input type="password" value={realtime.apiKey || ''} onChange={(event) => setRealtime({ ...realtime, apiKey: event.target.value })} placeholder="qwen-audio-3.0-asr-flash-streaming 的 API Key" /></label><button className="modal-submit" onClick={() => void saveRealtime()}>保存实时转写配置</button></>}</section></div></section>;
}

type AiModelConfig = { id: number; name: string; provider: string; baseUrl: string; model: string; apiKeySet: boolean; apiKeyPreview: string; apiKey?: string };
type AiPrompt = { id: number; name: string; content: string };
type AsrConfigClient = { provider: string; submitUrl: string; taskUrl: string; model: string; publicBaseUrl: string; apiKeySet: boolean; apiKeyPreview: string; tokenSecretSet: boolean; tokenSecretPreview: string; apiKey?: string; tokenSecret?: string };
type AiConfigState = { configs: AiModelConfig[]; prompts: AiPrompt[]; activeConfigId: number; activePromptId: number; autoTranscribe: boolean; asrConfig: AsrConfigClient | null };

const providerDefaults: Record<string, string> = {
  bailian: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  siliconflow: 'https://api.siliconflow.cn/v1',
  openai: 'https://api.openai.com/v1',
  custom: '',
};
const providerNames: Record<string, string> = { bailian: '阿里云百炼', siliconflow: '硅基流动', openai: 'OpenAI 兼容接口', custom: '自定义平台' };
const modelPresets: Record<string, string[]> = {
  bailian: ['qwen3.8-27b', 'qwen-plus', 'qwen-max'],
  siliconflow: ['Qwen/Qwen3-235B-A22B-Instruct-2507', 'Qwen/Qwen3-32B', 'deepseek-ai/DeepSeek-V3'],
  openai: ['gpt-4o-mini', 'gpt-4.1-mini', '自定义模型'],
  custom: [],
};

function AiConfig() {
  const [state, setState] = useState<AiConfigState>({ configs: [], prompts: [], activeConfigId: 0, activePromptId: 0, autoTranscribe: false, asrConfig: null });
  const [editingModel, setEditingModel] = useState<(AiModelConfig & { apiKey?: string }) | null>(null);
  const [editingPrompt, setEditingPrompt] = useState<AiPrompt | null>(null);
  const [asrDraft, setAsrDraft] = useState<AsrConfigClient | null>(null);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try { const data = await jsonFetch('/api/ai/config'); setState(data); setAsrDraft(data.asrConfig); }
    catch (error) { setMessage((error as Error).message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (loading) return <section className="ai-config-page"><p>正在读取 AI 配置…</p></section>;
  if (!state) return <section className="ai-config-page"><p className="evaluation-error">暂无 AI 配置，请重新加载数据库。</p></section>;

  const activeModel = state.configs.find((item) => item.id === state.activeConfigId) || state.configs[0];
  const activePrompt = state.prompts.find((item) => item.id === state.activePromptId) || state.prompts[0];
  const providerModelOptions = modelPresets[editingModel?.provider || 'custom'] || [];
  const currentModelIsPreset = Boolean(editingModel && providerModelOptions.includes(editingModel.model));

  function newModel() {
    setEditingModel({ id: 0, name: '', provider: 'bailian', baseUrl: providerDefaults.bailian, model: 'qwen3.8-27b', apiKeySet: false, apiKeyPreview: '', apiKey: '' });
  }
  function editModel(model: AiModelConfig) { setEditingModel({ ...model, apiKey: '' }); }
  function newPrompt() { setEditingPrompt({ id: 0, name: '', content: '' }); }
  function editPrompt(prompt: AiPrompt) { setEditingPrompt({ ...prompt }); }

  async function saveModel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!editingModel) return;
    setSaving(true); setMessage('');
    try {
      const data = await jsonFetch('/api/ai/config', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activeConfigId: editingModel.id || state.activeConfigId, activePromptId: state.activePromptId, autoTranscribe: state.autoTranscribe, config: { id: editingModel.id || undefined, name: editingModel.name, provider: editingModel.provider, baseUrl: editingModel.baseUrl, model: editingModel.model, apiKey: editingModel.apiKey || '' } }) });
      setState(data); setEditingModel(null); setMessage('模型配置已保存并设为当前配置');
    } catch (error) { setMessage((error as Error).message); }
    finally { setSaving(false); }
  }
  async function savePrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!editingPrompt) return;
    setSaving(true); setMessage('');
    try {
      const data = await jsonFetch('/api/ai/config', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activeConfigId: state.activeConfigId, activePromptId: editingPrompt.id || state.activePromptId, autoTranscribe: state.autoTranscribe, prompt: { id: editingPrompt.id || undefined, name: editingPrompt.name, content: editingPrompt.content } }) });
      setState(data); setEditingPrompt(null); setMessage('提示词已保存并设为当前提示词');
    } catch (error) { setMessage((error as Error).message); }
    finally { setSaving(false); }
  }
  async function selectActive(configId: number, promptId = state.activePromptId) {
    try {
      const data = await jsonFetch('/api/ai/config', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activeConfigId: configId, activePromptId: promptId, autoTranscribe: state.autoTranscribe }) });
      setState(data); setMessage('当前 AI 配置已切换');
    } catch (error) { setMessage((error as Error).message); }
  }
  async function toggleAutoTranscribe() {
    try {
      const data = await jsonFetch('/api/ai/config', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activeConfigId: state.activeConfigId, activePromptId: state.activePromptId, autoTranscribe: !state.autoTranscribe }) });
      setState(data); setMessage(data.autoTranscribe ? '已开启保存录音后的自动转写' : '已关闭自动转写，学员可手动生成文字稿');
    } catch (error) { setMessage((error as Error).message); }
  }
  async function saveAsr(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!asrDraft) return;
    setSaving(true); setMessage('');
    try {
      const data = await jsonFetch('/api/ai/config', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activeConfigId: state.activeConfigId, activePromptId: state.activePromptId, autoTranscribe: state.autoTranscribe, asrConfig: asrDraft }) });
      setState(data); setAsrDraft(data.asrConfig); setMessage('录音转文字 API 配置已保存');
    } catch (error) { setMessage((error as Error).message); }
    finally { setSaving(false); }
  }
  async function removeModel(id: number) {
    if (!window.confirm('确定删除这个模型配置吗？')) return;
    try { const data = await jsonFetch('/api/ai/config', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deleteConfigId: id, activeConfigId: state.activeConfigId, activePromptId: state.activePromptId, autoTranscribe: state.autoTranscribe }) }); setState(data); setMessage('模型配置已删除'); }
    catch (error) { setMessage((error as Error).message); }
  }
  async function removePrompt(id: number) {
    if (!window.confirm('确定删除这个提示词吗？')) return;
    try { const data = await jsonFetch('/api/ai/config', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deletePromptId: id, activeConfigId: state.activeConfigId, activePromptId: state.activePromptId, autoTranscribe: state.autoTranscribe }) }); setState(data); setMessage('提示词已删除'); }
    catch (error) { setMessage((error as Error).message); }
  }

  return <section className="ai-config-page">
    <div className="ai-config-intro"><span className="section-kicker">AI CONTROL CENTER</span><h2>模型与提示词</h2><p>模型配置、评估提示词和录音自动转写均由管理员控制。密钥只保存于服务器，不会在页面中回显。</p></div>
    {message && <div className="management-message">{message}</div>}
    <div className="ai-config-grid">
      <section className="ai-panel"><div className="ai-panel-head"><div><span className="section-kicker">MODEL CONFIGURATIONS</span><h3>模型配置</h3></div><button type="button" className="create-trigger small-trigger" onClick={newModel}>＋ 新增配置</button></div>
        <label className="ai-active-select">当前使用的模型<select value={state.activeConfigId} onChange={(event) => void selectActive(Number(event.target.value))}>{state.configs.map((item) => <option key={item.id} value={item.id}>{item.name} · {providerNames[item.provider] || item.provider} · {item.model}</option>)}</select></label>
        {activeModel && <div className="ai-active-summary"><strong>{activeModel.name}</strong><span>{providerNames[activeModel.provider] || activeModel.provider} · {activeModel.model}</span><small>{activeModel.apiKeySet ? 'API Key 已配置' : '尚未配置 API Key'}</small></div>}
        <div className="ai-config-list">{state.configs.map((item) => <article className={item.id === state.activeConfigId ? 'ai-config-card active' : 'ai-config-card'} key={item.id}><div><strong>{item.name}</strong><span>{providerNames[item.provider] || item.provider} · {item.model}</span></div><div className="ai-card-actions"><button type="button" onClick={() => editModel(item)}>编辑</button><button type="button" className="danger-text" disabled={item.id === state.activeConfigId} onClick={() => void removeModel(item.id)}>删除</button></div></article>)}</div>
        {editingModel && <form className="ai-editor" onSubmit={saveModel}><div className="ai-editor-title"><strong>{editingModel.id ? '编辑模型配置' : '新增模型配置'}</strong><button type="button" onClick={() => setEditingModel(null)}>取消</button></div><label>配置名称<input required value={editingModel.name} onChange={(event) => setEditingModel({ ...editingModel, name: event.target.value })} placeholder="例如：百炼面试评估" /></label><label>模型平台<select value={editingModel.provider} onChange={(event) => setEditingModel({ ...editingModel, provider: event.target.value, baseUrl: providerDefaults[event.target.value] || editingModel.baseUrl, model: (modelPresets[event.target.value] || [])[0] || '' })}>{Object.keys(providerNames).map((provider) => <option key={provider} value={provider}>{providerNames[provider]}</option>)}</select></label><label>兼容接口地址<input required type="url" value={editingModel.baseUrl} onChange={(event) => setEditingModel({ ...editingModel, baseUrl: event.target.value })} /></label><label>模型名称<select value={currentModelIsPreset ? editingModel.model : '__custom__'} onChange={(event) => setEditingModel({ ...editingModel, model: event.target.value === '__custom__' ? '' : event.target.value })}>{providerModelOptions.map((model) => <option key={model} value={model}>{model}</option>)}<option value="__custom__">自定义模型名称</option></select>{(!currentModelIsPreset || !editingModel.model) && <input required value={editingModel.model} onChange={(event) => setEditingModel({ ...editingModel, model: event.target.value })} placeholder="输入模型名称" />}</label><label>API Key {editingModel.apiKeySet && <small className="key-preview">当前：{editingModel.apiKeyPreview}（留空不修改）</small>}<input type="password" value={editingModel.apiKey || ''} onChange={(event) => setEditingModel({ ...editingModel, apiKey: event.target.value })} placeholder={editingModel.apiKeySet ? '留空保持当前 Key' : '粘贴 API Key'} autoComplete="off" /></label><button className="modal-submit" disabled={saving}>{saving ? '保存中…' : '保存并启用配置'}</button></form>}
      </section>
      <section className="ai-panel"><div className="ai-panel-head"><div><span className="section-kicker">PROMPT LIBRARY</span><h3>评估提示词</h3></div><button type="button" className="create-trigger small-trigger" onClick={newPrompt}>＋ 新增提示词</button></div>
        <label className="ai-active-select">当前使用的提示词<select value={state.activePromptId} onChange={(event) => void selectActive(state.activeConfigId, Number(event.target.value))}>{state.prompts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        {activePrompt && <div className="ai-active-summary prompt-summary"><strong>{activePrompt.name}</strong><span>{activePrompt.content.slice(0, 150)}{activePrompt.content.length > 150 ? '…' : ''}</span></div>}
        <div className="ai-prompt-list">{state.prompts.map((item) => <article className={item.id === state.activePromptId ? 'ai-prompt-card active' : 'ai-prompt-card'} key={item.id}><div><strong>{item.name}</strong><p>{item.content.slice(0, 110)}{item.content.length > 110 ? '…' : ''}</p></div><div className="ai-card-actions"><button type="button" onClick={() => editPrompt(item)}>编辑</button><button type="button" className="danger-text" disabled={item.id === state.activePromptId} onClick={() => void removePrompt(item.id)}>删除</button></div></article>)}</div>
        {editingPrompt && <form className="ai-editor" onSubmit={savePrompt}><div className="ai-editor-title"><strong>{editingPrompt.id ? '编辑提示词' : '新增提示词'}</strong><button type="button" onClick={() => setEditingPrompt(null)}>取消</button></div><label>提示词名称<input required value={editingPrompt.name} onChange={(event) => setEditingPrompt({ ...editingPrompt, name: event.target.value })} placeholder="例如：食品专业面试评估" /></label><label>提示词内容<textarea required value={editingPrompt.content} onChange={(event) => setEditingPrompt({ ...editingPrompt, content: event.target.value })} placeholder="写清楚角色、输入内容、评价维度和输出格式。" /></label><button className="modal-submit" disabled={saving}>{saving ? '保存中…' : '保存并启用提示词'}</button></form>}
      </section>
    </div>
    <section className="ai-panel ai-asr-panel"><div className="ai-panel-head"><div><span className="section-kicker">ASR CONFIGURATION</span><h3>录音转文字 API</h3></div><small>与 AI 对话模型完全独立</small></div>
      <p className="ai-panel-note">用于录音自动转写。密钥仅保存在服务器；更换 ASR 平台、模型或公网音频地址时，只需要在这里修改。</p>
      {asrDraft ? <form className="asr-editor" onSubmit={saveAsr}>
        <label>服务平台<select value={asrDraft.provider} onChange={(event) => setAsrDraft({ ...asrDraft, provider: event.target.value })}><option value="bailian">阿里云百炼</option><option value="custom">自定义兼容接口</option></select></label>
        <label>转写模型<input required value={asrDraft.model} onChange={(event) => setAsrDraft({ ...asrDraft, model: event.target.value })} placeholder="paraformer-v1" /></label>
        <label>提交接口地址<input required type="url" value={asrDraft.submitUrl} onChange={(event) => setAsrDraft({ ...asrDraft, submitUrl: event.target.value })} /></label>
        <label>任务查询地址<input required type="url" value={asrDraft.taskUrl} onChange={(event) => setAsrDraft({ ...asrDraft, taskUrl: event.target.value })} /></label>
        <label>公网音频地址<input type="url" value={asrDraft.publicBaseUrl} onChange={(event) => setAsrDraft({ ...asrDraft, publicBaseUrl: event.target.value })} placeholder="例如：http://服务器IP:18080" /></label>
        <label>ASR API Key {asrDraft.apiKeySet && <small className="key-preview">当前：{asrDraft.apiKeyPreview}（留空不修改）</small>}<input type="password" value={asrDraft.apiKey || ''} onChange={(event) => setAsrDraft({ ...asrDraft, apiKey: event.target.value })} placeholder={asrDraft.apiKeySet ? '留空保持当前 Key' : '粘贴录音转写 API Key'} autoComplete="off" /></label>
        <label>音频临时链接密钥 {asrDraft.tokenSecretSet && <small className="key-preview">已设置（留空不修改）</small>}<input type="password" value={asrDraft.tokenSecret || ''} onChange={(event) => setAsrDraft({ ...asrDraft, tokenSecret: event.target.value })} placeholder="用于保护上传录音的临时访问链接" autoComplete="off" /></label>
        <button className="modal-submit" disabled={saving}>{saving ? '保存中…' : '保存录音转文字配置'}</button>
      </form> : <div className="review-empty">正在读取录音转文字配置…</div>}
    </section>
    <section className="ai-automation"><div><span className="section-kicker">AUDIO PIPELINE</span><h3>录音后自动转写</h3><p>开启后，学员保存带录音的回答时，系统会自动提交百炼 Paraformer 转写；页面不再显示手动生成按钮。</p></div><button type="button" className={state.autoTranscribe ? 'switch on' : 'switch'} onClick={() => void toggleAutoTranscribe()} aria-label="切换自动转写"><i /></button></section>
  </section>;
}
