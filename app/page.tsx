"use client";

import fixWebmDuration from "fix-webm-duration";
import MarkdownContent from "@/components/MarkdownContent";
import UsageManagement from "@/components/UsageManagement";
import SimulationConfig from "@/components/SimulationConfig";
import SimulationHistory from "@/components/SimulationHistory";
import QuestionVoiceManagement from "@/components/QuestionVoiceManagement";
import NotificationBell from "@/components/NotificationBell";
import { pushNotification } from "@/lib/notifications-client";

import { ChangeEvent, FormEvent, MouseEvent, useCallback, useEffect, useRef, useState } from "react";

type Category = string;
type BrowserKey =
  | "chrome"
  | "edge"
  | "browser360"
  | "browser360speed"
  | "lenovo"
  | "quark"
  | "opera"
  | "qq"
  | "sogou"
  | "brave"
  | "centbrowser";
type User = {
  id: number;
  username: string;
  displayName: string;
  role: "admin" | "student";
};
type ManagedUser = User & { status: "pending" | "active" | "rejected" };
type Question = {
  id: number;
  typeId: number;
  typeCode: string;
  category: Category;
  content: string;
  subcategory?: string | null;
  hasAnswer?: number;
  questionVoiceUrl?: string | null;
  suppressBrowserRead?: boolean;
};
type QuestionType = {
  id: number;
  code: string;
  name: string;
  description: string | null;
  sortOrder?: number;
};
type BankQuestion = {
  id: number;
  typeId: number;
  typeName: string;
  content: string;
  answer: string | null;
  subcategory: string | null;
  status: string;
  extra?: unknown;
};
type DuplicateQuestion = Pick<BankQuestion, "id" | "typeId" | "typeName" | "content" | "subcategory" | "status"> & {
  createdAt?: string | null;
  recordCount: number;
  voiceCount: number;
};
type DuplicateGroup = { key: string; content: string; count: number; questions: DuplicateQuestion[] };
type ImportPreview = {
  totalRows: number; validRows: number; willImport: number; blankRows: number;
  duplicateExisting: { row: number; content: string }[];
  duplicateInFile: { row: number; content: string }[];
};
type TranscriptSegment = { startMs: number; endMs: number; text: string };
type RecordItem = {
  id: number;
  userId: number;
  questionId: number | null;
  typeId?: number | null;
  category: Category;
  question: string;
  answer: string;
  subcategory?: string | null;
  referenceAnswer?: string | null;
  hasReferenceAnswer?: number;
  hasAudio: number;
  transcript?: string | null;
  transcriptSegments?: TranscriptSegment[] | string | null;
  transcriptStatus?: string;
  transcriptError?: string | null;
  transcribedAt?: string | null;
  createdAt: string;
  username?: string;
  displayName?: string;
};
type RecordGroup = {
  key: string;
  userId: number;
  questionId: number | null;
  category: Category;
  question: string;
  username?: string;
  displayName?: string;
  attempts: RecordItem[];
};
type Page =
  | "home"
  | "answer"
  | "history"
  | "settings"
  | "management"
  | "review"
  | "picker"
  | "simulation"
  | "simulation-history";

type HomeCard = QuestionType & {
  no: string;
  en: string;
  desc: string;
  icon: string;
  color: string;
};
type SimulationRecord = {
  id: number;
  userId: number;
  templateName: string;
  status: string;
  totalSeconds: number;
  elapsedSeconds: number;
  startedAt: string;
  completedAt?: string | null;
  username?: string;
  displayName?: string;
  answerCount?: number;
};
const cardColors = ["coral", "blue", "green"];

async function jsonFetch(url: string, options?: RequestInit) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "请求失败");
  return body;
}

function formatRecordDate(value: string) {
  const normalized = String(value).includes("T")
    ? String(value)
    : String(value).replace(" ", "T");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime())
    ? "时间未知"
    : date.toLocaleString("zh-CN");
}

function parseTranscriptSegments(value: unknown): TranscriptSegment[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is TranscriptSegment => {
        if (!item || typeof item !== "object") return false;
        const candidate = item as Partial<TranscriptSegment>;
        return (
          Number.isFinite(Number(candidate.startMs)) &&
          Number.isFinite(Number(candidate.endMs)) &&
          typeof candidate.text === "string"
        );
      })
      .map((item) => ({
        startMs: Number(item.startMs),
        endMs: Number(item.endMs),
        text: item.text,
      }));
  }
  if (typeof value === "string") {
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
  if (seconds < 60) return seconds.toFixed(1) + "s";
  const minutes = Math.floor(seconds / 60);
  return (
    String(minutes).padStart(2, "0") +
    ":" +
    (seconds % 60).toFixed(1).padStart(4, "0")
  );
}

function learnerLabel(displayName?: string | null, username?: string | null) {
  const name = String(displayName || "").trim();
  const account = String(username || "").trim();
  if (!name) return account;
  return account && account !== name ? `${name}（${account}）` : name;
}

function AudioWithDuration({
  src,
  className = "",
}: {
  src: string;
  className?: string;
}) {
  return <audio className={className} controls preload="metadata" src={src} />;
}
export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState<Page>("home");
  const [simulationReviewId, setSimulationReviewId] = useState<number | null>(
    null,
  );
  const [question, setQuestion] = useState<Question | null>(null);
  const [reviewGroup, setReviewGroup] = useState<RecordGroup | null>(null);

  const [questionTypes, setQuestionTypes] = useState<QuestionType[]>([]);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [answer, setAnswer] = useState("");
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [autoRecord, setAutoRecord] = useState(true);
  const [autoTranscribe, setAutoTranscribe] = useState(false);
  const [avoidRepeated, setAvoidRepeated] = useState(false);
  const [readQuestion, setReadQuestion] = useState(false);
  const [recording, setRecording] = useState(false);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [referenceAnswer, setReferenceAnswer] = useState<string | null>(null);
  const homeCards: HomeCard[] = questionTypes.map((type, index) => ({
    ...type,
    no: String(index + 1).padStart(2, "0"),
    en: type.code.toUpperCase(),
    desc: type.description || "暂无介绍",
    icon: type.name.slice(0, 1),
    color: cardColors[index % cardColors.length],
  }));
  const [message, setMessage] = useState("");
  const recorder = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const stopResolver = useRef<((blob: Blob | null) => void) | null>(null);
  const recordingStartedAt = useRef<number | null>(null);
  const speechRunId = useRef(0);
  const questionAudio = useRef<HTMLAudioElement | null>(null);
  const audioContext = useRef<AudioContext | null>(null);

  const playCue = useCallback((kind: "countdown" | "recording", value = 0) => {
    try {
      const AudioContextCtor =
        window.AudioContext ||
        (window as typeof window & { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!AudioContextCtor) return;
      audioContext.current ??= new AudioContextCtor();
      const context = audioContext.current;
      void context.resume();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = context.currentTime;
      const duration = kind === "recording" ? 0.22 : 0.12;
      oscillator.type = "sine";
      oscillator.frequency.value =
        kind === "recording" ? 880 : 520 + Math.max(0, value) * 70;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.08, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + duration + 0.02);
    } catch {
      // The browser may block Web Audio until the first user gesture.
    }
  }, []);

  const startRecording = useCallback(async () => {
    if (recorder.current?.state === "recording") return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      chunks.current = [];
      streamRef.current = stream;
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size) chunks.current.push(event.data);
      };
      mediaRecorder.onstop = async () => {
        const rawBlob = chunks.current.length
          ? new Blob(chunks.current, {
              type: mediaRecorder.mimeType || "audio/webm",
            })
          : null;
        const elapsed = recordingStartedAt.current
          ? Math.max(0, Date.now() - recordingStartedAt.current)
          : 0;
        const blob =
          rawBlob && elapsed > 0
            ? await fixWebmDuration(rawBlob, elapsed, { logger: false })
            : rawBlob;
        setAudioBlob(blob);
        setRecording(false);
        stream.getTracks().forEach((track) => track.stop());
        stopResolver.current?.(blob);
        stopResolver.current = null;
      };
      recordingStartedAt.current = Date.now();
      mediaRecorder.start();
      recorder.current = mediaRecorder;
      setRecording(true);
      playCue("recording");
    } catch {
      setMessage("无法使用麦克风，请在浏览器地址栏允许录音权限。");
    }
  }, [playCue]);

  const loadRecords = useCallback(
    async (category = "", search = ""): Promise<RecordItem[]> => {
      const data = await jsonFetch(
        `/api/records?category=${encodeURIComponent(category)}&q=${encodeURIComponent(search)}`,
      );
      setRecords(data.records);
      return data.records as RecordItem[];
    },
    [],
  );

  const refreshReviewGroup = useCallback(async () => {
    const refreshedRecords = await loadRecords();
    setReviewGroup((current) => {
      if (!current) return current;
      const attempts = refreshedRecords.filter(
        (item) =>
          item.userId === current.userId &&
          (current.questionId
            ? item.questionId === current.questionId
            : item.question === current.question),
      );
      if (!attempts.length) return current;
      return {
        ...current,
        category: attempts[0].category,
        question: attempts[0].question,
        username: attempts[0].username,
        displayName: attempts[0].displayName,
        attempts,
      };
    });
  }, [loadRecords]);

  useEffect(() => {
    Promise.all([
      jsonFetch("/api/auth/me"),
      jsonFetch("/api/settings"),
      jsonFetch("/api/question-types"),
    ])
      .then(([me, settings, typeData]) => {
        setUser(me.user);
        setAutoRecord(settings.settings.autoRecord);
        setAutoTranscribe(Boolean(settings.settings.autoTranscribe));
        setAvoidRepeated(Boolean(settings.settings.avoidRepeated));
        setReadQuestion(Boolean(settings.settings.readQuestion));
        setQuestionTypes(typeData.types);
        return loadRecords();
      })
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, [loadRecords]);

  useEffect(() => {
    if (countdown === null) return;
    playCue("countdown", countdown);
    const timer = window.setTimeout(() => {
      if (countdown === 1) {
        setCountdown(null);
        if (readQuestion && question) {
          const runId = ++speechRunId.current;
          let completed = false;
          const finishReading = () => {
            if (completed || speechRunId.current !== runId) return;
            completed = true;
            if (autoRecord) void startRecording();
          };
          const browserFallback = () => {
            if (question.suppressBrowserRead) { finishReading(); return; }
            if (!("speechSynthesis" in window)) { setMessage("当前浏览器不支持题目朗读"); finishReading(); return; }
            window.speechSynthesis.cancel();
            const utterance = new SpeechSynthesisUtterance(question.content);
            utterance.lang = /[\u4e00-\u9fff]/.test(question.content) ? "zh-CN" : "en-US";
            utterance.onend = finishReading; utterance.onerror = finishReading; window.speechSynthesis.speak(utterance);
          };
          if (question.questionVoiceUrl) {
            const audio = new Audio(question.questionVoiceUrl); questionAudio.current = audio;
            audio.onended = finishReading; audio.onerror = browserFallback;
            void audio.play().catch(browserFallback);
          } else browserFallback();
        } else if (autoRecord) void startRecording();
      } else setCountdown(countdown - 1);
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [countdown, autoRecord, question, readQuestion, startRecording, playCue]);
  useEffect(() => {
    if (!audioBlob || !question?.hasAnswer) return;
    void jsonFetch("/api/questions/" + question.id + "/answer")
      .then((data) => setReferenceAnswer(data.answer || null))
      .catch(() => setReferenceAnswer(null));
  }, [audioBlob, question]);
  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    const form = new FormData(event.currentTarget);
    try {
      const data = await jsonFetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: form.get("username"),
          password: form.get("password"),
        }),
      });
      setUser(data.user);
      const settings = await jsonFetch("/api/settings");
      setAutoRecord(settings.settings.autoRecord);
      setAutoTranscribe(Boolean(settings.settings.autoTranscribe));
      setAvoidRepeated(Boolean(settings.settings.avoidRepeated));
      setReadQuestion(Boolean(settings.settings.readQuestion));
      const typeData = await jsonFetch("/api/question-types");
      setQuestionTypes(typeData.types);
      await loadRecords();
    } catch (error) {
      setMessage((error as Error).message);
    }
  }

  async function logout() {
    stopMedia();
    await fetch("/api/auth/logout", { method: "POST" });
    setUser(null);
    setRecords([]);
    setPage("home");
  }

  async function draw(typeId: number) {
    stopMedia();
    setMessage("");
    try {
      const data = await jsonFetch(
        "/api/questions/random?typeId=" + encodeURIComponent(String(typeId)),
      );
      setQuestion(data.question);
      setAnswer("");
      setAudioBlob(null);
      setReferenceAnswer(null);
      setCountdown(3);
      setPage("answer");
      window.scrollTo(0, 0);
    } catch (error) {
      setMessage((error as Error).message);
    }
  }

  function startSelectedQuestion(selected: Question) {
    stopMedia();
    setQuestion(selected);
    setAnswer("");
    setAudioBlob(null);
    setReferenceAnswer(null);
    setCountdown(3);
    setPage("answer");
    window.scrollTo(0, 0);
  }

  function stopRecording() {
    if (!recorder.current || recorder.current.state !== "recording")
      return Promise.resolve(audioBlob);
    return new Promise<Blob | null>((resolve) => {
      stopResolver.current = resolve;
      recorder.current?.stop();
    });
  }

  function stopMedia() {
    speechRunId.current += 1;
    window.speechSynthesis?.cancel();
    questionAudio.current?.pause();
    questionAudio.current = null;
    if (recorder.current?.state === "recording") recorder.current.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    setRecording(false);
  }

  function navigate(nextPage: Page) {
    // Stop both the ordinary practice reader and the simulation reader before
    // React switches screens, rather than waiting for component unmount.
    window.dispatchEvent(new Event("app-navigation"));
    stopMedia();
    setPage(nextPage);
  }

  function continueFromRecord(item: RecordItem) {
    if (!item.questionId || !item.typeId) {
      setMessage("原题已不存在，无法继续作答。");
      return;
    }
    stopMedia();
    setQuestion({
      id: item.questionId,
      typeId: item.typeId,
      typeCode: "",
      category: item.category,
      content: item.question,
      subcategory: item.subcategory,
      hasAnswer: item.hasReferenceAnswer,
    });
    setAnswer("");
    setAudioBlob(null);
    setReferenceAnswer(item.referenceAnswer || null);
    setCountdown(3);
    setPage("answer");
    window.scrollTo(0, 0);
  }
  async function save() {
    if (!question) return;
    setMessage("正在保存…");
    try {
      const blob = recording ? await stopRecording() : audioBlob;
      const form = new FormData();
      form.set("questionId", String(question.id));
      form.set("category", question.category);
      form.set("question", question.content);
      form.set("answer", answer);
      if (blob)
        form.set(
          "audio",
          new File([blob], "answer.webm", { type: blob.type || "audio/webm" }),
        );
      const saved = await jsonFetch("/api/records", {
        method: "POST",
        body: form,
      });
      if (autoTranscribe && blob && saved.id)
        await jsonFetch("/api/records/" + saved.id + "/transcription", {
          method: "POST",
        }).catch(() => undefined);
      await loadRecords();
      setMessage("");
      setPage("history");
    } catch (error) {
      setMessage((error as Error).message);
    }
  }

  if (loading)
    return (
      <div className="login-shell">
        <div className="login-card">
          <b className="login-mark">研</b>
          <p>正在载入训练系统…</p>
        </div>
      </div>
    );
  if (!user) return <Login onSubmit={login} message={message} />;

  return (
    <div className="app">
      <header>
        <button className="logo" onClick={() => navigate("home")}>
          <img
            className="logo-image"
            src="/logo2.0.png?v=1"
            alt="小鱼食品保研"
            width={226}
            height={75}
            loading="eager"
          />
          <span className="logo-training">
            <strong>保研面试训练</strong>
            <small>INTERVIEW TRAINING</small>
          </span>
        </button>
        <nav>
          <button
            className={page === "home" || page === "answer" ? "active" : ""}
            onClick={() => navigate("home")}
          >
            题库训练
          </button>
          <button
            className={page === "history" ? "active" : ""}
            onClick={() => navigate("history")}
          >
            作答记录 <i>{records.length}</i>
          </button>
          <button
            className={page === "simulation-history" ? "active" : ""}
            onClick={() => navigate("simulation-history")}
          >
            真实模拟记录
          </button>
          <button
            className={page === "settings" ? "active" : ""}
            onClick={() => navigate("settings")}
          >
            设置
          </button>
          {user.role === "admin" && (
            <button
              className={page === "management" ? "active" : ""}
              onClick={() => navigate("management")}
            >
              管理后台
            </button>
          )}
        </nav>
        <div className="account-actions">
          <NotificationBell />
          <button className="user-chip" onClick={logout}>
            {user.displayName}
            <small>退出</small>
          </button>
        </div>
      </header>
      {message && <div className="notice">{message}</div>}

      {page === "home" && (
        <main>
          <section className="hero">
            <div>
              <p className="eyebrow">— 推免面试 · 模拟训练</p>
              <h1>
                把每一次开口，
                <br />
                都练成<span>底气。</span>
              </h1>
              <p className="lead">
                从随机抽题到限时作答，提前适应真实面试节奏。
                <br />
                录音和练习记录安全保存在服务器。
              </p>
            </div>
            <aside>
              <span>累计训练</span>
              <strong>{String(records.length).padStart(2, "0")}</strong>
              <small>次个人作答</small>
              <div>
                <i
                  style={{
                    width: `${Math.min((records.length / 3) * 100, 100)}%`,
                  }}
                />
              </div>
              <p>建议完成 3 道不同类别题目</p>
            </aside>
          </section>
          <section className="practice-modes">
            <div className="title">
              <div>
                <small>PRACTICE MODES</small>
                <h2>选择练习方式</h2>
              </div>
              <span>随机练习 · 自主选题 · 完整面试模拟</span>
            </div>
            <div className="practice-mode-grid">
              <article>
                <span>01</span>
                <h3>随机抽题</h3>
                <p>从指定类别随机抽一题，快速进入日常训练。</p>
                <button
                  onClick={() =>
                    document
                      .getElementById("random-topic")
                      ?.scrollIntoView({ behavior: "smooth" })
                  }
                >
                  开始随机练习
                </button>
              </article>
              <article>
                <span>02</span>
                <h3>从题库选题</h3>
                <p>按题型和关键词筛选，自主选择想要练习的题目。</p>
                <button onClick={() => setPage("picker")}>进入题库选题</button>
              </article>
              <article className="simulation-mode">
                <span>03</span>
                <h3>真实场景模拟</h3>
                <p>按完整面试流程连续作答，保留分段和全程录音。</p>
                <button onClick={() => setPage("simulation")}>
                  开始完整模拟
                </button>
              </article>
            </div>
          </section>
          <section className="choose" id="random-topic">
            <div className="title">
              <div>
                <small>RANDOM QUESTION</small>
                <h2>随机抽取一个训练类别</h2>
              </div>
              <span>数据库题型 · 随机抽取 · 持久记录</span>
            </div>
            <div className="cards">
              {homeCards.map((card) => (
                <article className={card.color} key={card.id}>
                  <div className="cardtop">
                    <span>{card.no}</span>
                    <small>随机抽取</small>
                  </div>
                  <b className="symbol">{card.icon}</b>
                  <small className="en">{card.en}</small>
                  <h3>{card.name}</h3>
                  <p>{card.desc}</p>
                  <button onClick={() => draw(card.id)}>
                    开始抽题 <span>→</span>
                  </button>
                </article>
              ))}
            </div>
          </section>
          <section className="steps">
            <div>
              <small>HOW IT WORKS</small>
              <h2>四步完成一次高效练习</h2>
            </div>
            <ol>
              <li>
                <b>01</b>选择类别
              </li>
              <li>
                <b>02</b>3 秒准备
              </li>
              <li>
                <b>03</b>自动录音
              </li>
              <li>
                <b>04</b>复盘提升
              </li>
            </ol>
          </section>
        </main>
      )}

      {page === "answer" && question && (
        <main className="answer-page">
          <button
            className="back"
            onClick={() => {
              stopMedia();
              setPage("home");
            }}
          >
            ← 返回题库
          </button>
          <div className="answer-head">
            <div>
              <small>{question.category}</small>
              <h1>模拟作答</h1>
            </div>
            <button className="again" onClick={() => draw(question.typeId)}>
              ↻ 换一题
            </button>
          </div>
          <section className="question">
            <small>INTERVIEW QUESTION</small>
            <b>Q</b>
            <h2>{question.content}</h2>
            {question.subcategory && (
              <span className="question-subcategory">
                {question.subcategory}
              </span>
            )}
            <p>回答提示：观点明确 · 结构清晰 · 结合具体经历或案例</p>
            {countdown !== null && (
              <div className="countdown">
                <div key={countdown}>{countdown}</div>
                <strong>准备开始</strong>
                <small>
                  {readQuestion
                    ? autoRecord
                      ? "朗读题目，朗读结束后自动录音"
                      : "朗读题目后开始作答"
                    : autoRecord
                      ? "倒计时结束后将自动录音"
                      : "倒计时结束后开始作答"}
                </small>
              </div>
            )}
          </section>
          {referenceAnswer && (
            <section className="reference-answer">
              <span className="section-kicker">REFERENCE ANSWER</span>
              <h3>参考答案</h3>
              <p>{referenceAnswer}</p>
            </section>
          )}
          <section className="response">
            <label>
              作答提纲 <small>选填</small>
            </label>
            <textarea
              disabled={countdown !== null}
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              placeholder="记录你的回答框架、关键词或复盘笔记……"
            />
            <div className={`recorder ${recording ? "on" : ""}`}>
              <span>
                <b>
                  {recording
                    ? "● 正在录音"
                    : audioBlob
                      ? "✓ 录音已完成"
                      : "◉ 录制作答"}
                </b>
                <small>
                  {recording
                    ? "请保持自然语速"
                    : autoRecord
                      ? "倒计时后自动开始，也可手动控制"
                      : "自动录音已在设置中关闭"}
                </small>
              </span>
              <button
                disabled={countdown !== null}
                onClick={() =>
                  recording ? void stopRecording() : void startRecording()
                }
              >
                {recording ? "结束录音" : audioBlob ? "重新录制" : "开始录音"}
              </button>
            </div>
          </section>
          <div className="actions">
            <button
              onClick={() => {
                stopMedia();
                setPage("home");
              }}
            >
              退出练习
            </button>
            <button onClick={save} disabled={countdown !== null}>
              完成并保存记录 →
            </button>
          </div>
        </main>
      )}
      {page === "picker" && (
        <QuestionPicker
          types={questionTypes}
          onBack={() => setPage("home")}
          onPick={startSelectedQuestion}
        />
      )}
      {page === "simulation" && (
        <Simulation
          onBack={() => setPage("home")}
          onReview={(sessionId) => {
            setSimulationReviewId(sessionId);
            setPage("simulation-history");
          }}
        />
      )}
      {page === "simulation-history" && (
        <SimulationHistory
          onBack={() => setPage("home")}
          initialRecordId={simulationReviewId}
          onInitialRecordOpened={() => setSimulationReviewId(null)}
        />
      )}

      {page === "history" && (
        <History
          records={records}
          cards={homeCards}
          autoTranscribe={autoTranscribe}
          onFilter={loadRecords}
          onNew={() => setPage("home")}
          onContinue={continueFromRecord}
          onReview={(group) => {
            setReviewGroup(group);
            setPage("review");
          }}
        />
      )}
      {page === "settings" && (
        <Settings
          autoRecord={autoRecord}
          avoidRepeated={avoidRepeated}
          readQuestion={readQuestion}
          onChange={(value, repeated, read) => {
            setAutoRecord(value);
            setAvoidRepeated(repeated);
            setReadQuestion(read);
          }}
        />
      )}
      {page === "review" && reviewGroup && (
        <ReviewPage
          group={reviewGroup}
          autoTranscribe={autoTranscribe}
          onRefreshRecords={refreshReviewGroup}
          onBack={() => {
            setPage("history");
            void loadRecords();
          }}
        />
      )}
      {page === "management" && user.role === "admin" && <Management />}
      <footer>
        <span>小鱼食品保研 · 保研面试训练</span>
        <span>让准备看得见，让表达更从容。</span>
      </footer>
    </div>
  );
}

function QuestionPicker({
  types,
  onBack,
  onPick,
}: {
  types: QuestionType[];
  onBack: () => void;
  onPick: (question: Question) => void;
}) {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [typeId, setTypeId] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [message, setMessage] = useState("");
  const load = useCallback(
    async (target = 1) => {
      try {
        const params = new URLSearchParams({
          page: String(target),
          pageSize: "12",
        });
        if (typeId) params.set("typeId", typeId);
        if (search.trim()) params.set("q", search.trim());
        const data = await jsonFetch("/api/practice-questions?" + params);
        setQuestions(data.questions || []);
        setPage(data.page);
        setTotalPages(data.totalPages);
      } catch (error) {
        setMessage((error as Error).message);
      }
    },
    [typeId, search],
  );
  useEffect(() => {
    void load(1);
  }, [load]);
  return (
    <main className="picker-page">
      <button className="back" onClick={onBack}>
        ← 返回练习方式
      </button>
      <header>
        <span className="section-kicker">PICK A QUESTION</span>
        <h1>从题库选题</h1>
        <p>筛选后直接选择一题练习，作答方式、录音和复盘与随机抽题完全一致。</p>
      </header>
      <form
        className="picker-filters"
        onSubmit={(event) => {
          event.preventDefault();
          void load(1);
        }}
      >
        <select
          value={typeId}
          onChange={(event) => setTypeId(event.target.value)}
        >
          <option value="">全部题型</option>
          {types.map((type) => (
            <option key={type.id} value={type.id}>
              {type.name}
            </option>
          ))}
        </select>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索题目或具体分类"
        />
        <button>筛选题目</button>
      </form>
      {message && <div className="management-message">{message}</div>}
      <section className="picker-list">
        {questions.map((item) => (
          <article key={item.id}>
            <div>
              <span className="tag-chip">{item.category}</span>
              {item.subcategory && (
                <span className="tag-chip">{item.subcategory}</span>
              )}
              <h2>{item.content}</h2>
              <small>
                {item.hasAnswer ? "已配置参考答案" : "暂无参考答案"}
              </small>
            </div>
            <button onClick={() => onPick(item)}>练习这道题</button>
          </article>
        ))}
        {!questions.length && (
          <div className="empty">
            <h3>没有符合条件的题目</h3>
            <p>换一个筛选条件，或请管理员补充题库。</p>
          </div>
        )}
      </section>
      <div className="pagination">
        <button disabled={page <= 1} onClick={() => void load(page - 1)}>
          ← 上一页
        </button>
        <span>
          第 {page} / {totalPages} 页
        </span>
        <button
          disabled={page >= totalPages}
          onClick={() => void load(page + 1)}
        >
          下一页 →
        </button>
      </div>
    </main>
  );
}

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
  templateModuleId?: string;
  questionId?: number;
  question?: string;
  category?: string;
  subcategory?: string | null;
  referenceAnswer?: string | null;
  questionVoiceUrl?: string | null;
  suppressBrowserRead?: boolean;
};
type SimulationTemplate = {
  id: number;
  name: string;
  description: string;
  totalSeconds: number;
  moduleTimeoutMode?: "warn" | "immediate_advance" | "auto_advance";
  modules: SimulationStep[] | string;
  followupPrompt?: string;
  dynamicTtsConfig?: { provider?: string; model?: string; per?: number; rate?: number; pitch?: number; volume?: number };
  isActive?: boolean;
};
function downsamplePcm(
  input: Float32Array,
  inputRate: number,
  outputRate = 16000,
) {
  if (inputRate === outputRate) {
    const pcm = new Int16Array(input.length);
    for (let index = 0; index < input.length; index += 1)
      pcm[index] = Math.max(-1, Math.min(1, input[index])) * 0x7fff;
    return pcm;
  }
  const ratio = inputRate / outputRate;
  const length = Math.max(1, Math.round(input.length / ratio));
  const pcm = new Int16Array(length);
  for (let index = 0; index < length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(input.length, Math.floor((index + 1) * ratio));
    let sum = 0;
    for (let sample = start; sample < Math.max(start + 1, end); sample += 1)
      sum += input[sample] || 0;
    pcm[index] =
      Math.max(-1, Math.min(1, sum / Math.max(1, end - start))) * 0x7fff;
  }
  return pcm;
}

function readRealtimeSentence(value: unknown) {
  const data = value as {
    payload?: {
      output?: {
        sentence?: {
          text?: unknown;
          begin_time?: unknown;
          end_time?: unknown;
          beginTime?: unknown;
          endTime?: unknown;
          sentence?: unknown;
        };
        text?: unknown;
      };
    };
    output?: {
      sentence?: {
        text?: unknown;
        sentence?: unknown;
        begin_time?: unknown;
        end_time?: unknown;
        beginTime?: unknown;
        endTime?: unknown;
      };
      text?: unknown;
    };
  };
  const sentence = data?.payload?.output?.sentence || data?.output?.sentence;
  const text =
    typeof sentence?.text === "string"
      ? sentence.text
      : typeof sentence?.sentence === "string"
        ? sentence.sentence
        : typeof data?.payload?.output?.text === "string"
          ? data.payload.output.text
          : typeof data?.output?.text === "string"
            ? data.output.text
            : "";
  const startMs = Number(sentence?.begin_time ?? sentence?.beginTime ?? 0);
  const endMs = Number(sentence?.end_time ?? sentence?.endTime ?? startMs);
  return {
    text: text.trim(),
    startMs: Number.isFinite(startMs) ? startMs : 0,
    endMs: Number.isFinite(endMs) ? endMs : startMs,
  };
}
type SimulationAnswerDraft = {
  moduleIndex: number;
  moduleTitle: string;
  questionId?: number;
  question: string;
  answer: string;
  transcript: string;
  transcriptSegments?: TranscriptSegment[];
  elapsedSeconds: number;
  audio?: Blob;
  questionAudio?: Blob;
  followupQuestion?: string;
};

function Simulation({
  onBack,
  onReview,
}: {
  onBack: () => void;
  onReview: (sessionId: number) => void;
}) {
  const [templates, setTemplates] = useState<SimulationTemplate[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [sessionId, setSessionId] = useState(0);
  const [steps, setSteps] = useState<SimulationStep[]>([]);
  const [stepIndex, setStepIndex] = useState(0);
  const [answer, setAnswer] = useState("");
  const [recording, setRecording] = useState(false);
  const [segmentBlob, setSegmentBlob] = useState<Blob | null>(null);
  const [drafts, setDrafts] = useState<SimulationAnswerDraft[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [stepStartedAt, setStepStartedAt] = useState(0);
  const [stepElapsed, setStepElapsed] = useState(0);
  const [message, setMessage] = useState("");
  const [followup, setFollowup] = useState<string | null>(null);
  const [followupGenerating, setFollowupGenerating] = useState(false);
  const [followupRound, setFollowupRound] = useState(0);
  const [followupTurns, setFollowupTurns] = useState<
    Array<{ question: string; answer: string }>
  >([]);
  const [questionAudioBlobs, setQuestionAudioBlobs] = useState<Record<string, Blob>>({});
  const [autoRecord, setAutoRecord] = useState(true);
  const [readQuestion, setReadQuestion] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [reading, setReading] = useState(false);
  const [promptCycle, setPromptCycle] = useState(0);
  const [dynamicQuestionLoading, setDynamicQuestionLoading] = useState(false);
  const [dynamicQuestionError, setDynamicQuestionError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [completedSessionId, setCompletedSessionId] = useState<number | null>(
    null,
  );
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const stream = useRef<MediaStream | null>(null);
  const finishedRef = useRef(false);
  // State updates are asynchronous.  This ref prevents a just-cleared follow-up
  // from scheduling another countdown while the final submission is in flight.
  const submissionRef = useRef(false);
  const moduleTimeoutRef = useRef("");
  const segmentRecordingStartedAt = useRef(0);
  const speechRunId = useRef(0);
  const questionPromptAudio = useRef<HTMLAudioElement | null>(null);
  const questionReadingSafetyTimer = useRef<number | null>(null);
  const audioContext = useRef<AudioContext | null>(null);
  const [liveTranscript, setLiveTranscript] = useState("");
  const [realtimeStatus, setRealtimeStatus] = useState("");
  const [realtimeRetryAvailable, setRealtimeRetryAvailable] = useState(false);
  const realtimeSocket = useRef<WebSocket | null>(null);
  const realtimeAudioContext = useRef<AudioContext | null>(null);
  const realtimeSource = useRef<MediaStreamAudioSourceNode | null>(null);
  const realtimeProcessor = useRef<ScriptProcessorNode | null>(null);
  const realtimeMute = useRef<GainNode | null>(null);
  const realtimeRun = useRef(0);
  const liveTranscriptRef = useRef("");
  const liveSegmentsRef = useRef<TranscriptSegment[]>([]);
  const realtimeFailedRef = useRef(false);
  const realtimeOffsetMs = useRef(0);
  const segmentStopResolver = useRef<((blob: Blob | null) => void) | null>(
    null,
  );
  const playCue = useCallback((kind: "countdown" | "recording", value = 0) => {
    try {
      const AudioContextCtor =
        window.AudioContext ||
        (window as typeof window & { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!AudioContextCtor) return;
      audioContext.current ??= new AudioContextCtor();
      const context = audioContext.current;
      void context.resume();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = context.currentTime;
      const duration = kind === "recording" ? 0.22 : 0.12;
      oscillator.type = "sine";
      oscillator.frequency.value =
        kind === "recording" ? 880 : 520 + Math.max(0, value) * 70;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.08, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + duration + 0.02);
    } catch {
      /* Web Audio may wait for a user gesture. */
    }
  }, []);
  useEffect(() => {
    jsonFetch("/api/simulations")
      .then((data) => {
        setTemplates(data.templates || []);
        if (data.templates?.[0]) setTemplateId(String(data.templates[0].id));
      })
      .catch((error) => setMessage((error as Error).message));
  }, []);
  useEffect(() => {
    jsonFetch("/api/settings")
      .then((data) => {
        setAutoRecord(Boolean(data.settings?.autoRecord));
        setReadQuestion(Boolean(data.settings?.readQuestion));
      })
      .catch(() => undefined);
  }, []);
  const clockFrozen = countdown !== null || dynamicQuestionLoading || followupGenerating;
  useEffect(() => {
    if (!sessionId || clockFrozen) return;
    const timer = window.setInterval(
      () => {
        setElapsed((value) => value + 1);
        if (stepStartedAt) setStepElapsed((value) => value + 1);
      },
      1000,
    );
    return () => window.clearInterval(timer);
  }, [sessionId, clockFrozen, stepStartedAt]);
  useEffect(() => {
    if (!sessionId) return;
    setFollowupRound(0);
    setFollowupTurns([]);
  }, [sessionId]);
  useEffect(
    () => () => {
      speechRunId.current += 1;
      window.speechSynthesis?.cancel();
      questionPromptAudio.current?.pause();
      questionPromptAudio.current = null;
      if (recorder.current?.state === "recording") recorder.current.stop();
      stream.current?.getTracks().forEach((track) => track.stop());
      stopRealtimeTranscription(true);
    },
    [],
  );
  useEffect(() => {
    const stopOnNavigation = () => stopQuestionReading();
    window.addEventListener("app-navigation", stopOnNavigation);
    return () => window.removeEventListener("app-navigation", stopOnNavigation);
  }, []);
  const current = steps[stepIndex];
  const totalSeconds =
    templates.find((item) => item.id === Number(templateId))?.totalSeconds || 0;
  const moduleTimeoutMode =
    templates.find((item) => item.id === Number(templateId))
      ?.moduleTimeoutMode || "warn";
  const format = (seconds: number) =>
    String(Math.floor(Math.max(0, seconds) / 60)).padStart(2, "0") +
    ":" +
    String(Math.max(0, seconds) % 60).padStart(2, "0");
  useEffect(() => {
    if (
      !sessionId ||
      !totalSeconds ||
      elapsed < totalSeconds ||
      finishedRef.current
    )
      return;
    finishedRef.current = true;
    if (recorder.current?.state === "recording") recorder.current.stop();
    const timeoutTranscript = liveTranscriptRef.current || answer;
    const timeoutDrafts =
      current && (timeoutTranscript.trim() || segmentBlob)
        ? [
            ...drafts,
            {
              moduleIndex: stepIndex,
              moduleTitle: followup
                ? current.title + " · 老师追问"
                : current.title,
              questionId: current.questionId,
              question: followup || current.question || current.prompt || "",
              answer,
              transcript: timeoutTranscript,
              transcriptSegments: liveSegmentsRef.current.length
                ? [...liveSegmentsRef.current]
                : undefined,
              elapsedSeconds: stepElapsed,
              audio: segmentBlob || undefined,
              questionAudio: questionAudioBlobs[questionAudioKey()],
              followupQuestion: followup || undefined,
            },
          ]
        : drafts;
    setMessage("总时长已到，系统正在自动保存本场模拟。");
    void finish(timeoutDrafts);
  }, [
    elapsed,
    totalSeconds,
    sessionId,
    current,
    answer,
    segmentBlob,
    drafts,
    stepIndex,
    followup,
    stepStartedAt,
  ]);
  useEffect(() => {
    const suggestedSeconds = Math.floor(Number(current?.timeSeconds));
    if (
      !sessionId ||
      !current ||
      !["immediate_advance", "auto_advance"].includes(moduleTimeoutMode) ||
      !Number.isFinite(suggestedSeconds) ||
      suggestedSeconds < 1 ||
      !recording ||
      !segmentRecordingStartedAt.current ||
      finishedRef.current
    )
      return;
    const answerSeconds = Math.floor(
      (Date.now() - segmentRecordingStartedAt.current) / 1000,
    );
    const cutoffSeconds =
      moduleTimeoutMode === "immediate_advance"
        ? suggestedSeconds
        : Math.ceil(suggestedSeconds * 1.5);
    if (answerSeconds < cutoffSeconds) return;
    const timeoutKey = `${sessionId}:${stepIndex}:${followupRound}:${segmentRecordingStartedAt.current}`;
    if (moduleTimeoutRef.current === timeoutKey) return;
    moduleTimeoutRef.current = timeoutKey;
    setMessage(
      moduleTimeoutMode === "immediate_advance"
        ? "已到本环节建议时长，正在保存并进入下一题。"
        : "已超过本环节建议时长的 50%，正在保存并进入下一题。",
    );
    void (async () => {
      const audio = await stopRecording();
      const transcript = liveTranscriptRef.current || answer;
      const activeQuestion =
        followup || current.question || current.prompt || "";
      const saved =
        transcript.trim() || audio
          ? saveCurrent(
              undefined,
              activeQuestion,
              followup || undefined,
              audio,
            )
          : null;
      const nextDrafts = saved ? [...drafts, saved] : drafts;
      setFollowup(null);
      setFollowupRound(0);
      setFollowupTurns([]);
      segmentRecordingStartedAt.current = 0;
      if (stepIndex + 1 < steps.length) {
        const nextIndex = stepIndex + 1;
        const nextStep = steps[nextIndex];
        setStepIndex(nextIndex);
        setDynamicQuestionError("");
        if (nextStep?.kind === "dynamic" && !nextStep.question) {
          setStepStartedAt(0);
          setStepElapsed(0);
          setCountdown(null);
          void generateDynamicQuestion(nextIndex, nextDrafts);
        } else {
          setStepStartedAt(Date.now());
          setStepElapsed(0);
        }
      } else {
        finishedRef.current = true;
        await finish(nextDrafts);
      }
    })();
  }, [
    answer,
    current,
    drafts,
    elapsed,
    followup,
    followupRound,
    moduleTimeoutMode,
    recording,
    sessionId,
    stepIndex,
    steps,
  ]);
  function stopRealtimeTranscription(dispose = false) {
    if (dispose) realtimeRun.current += 1;
    const processor = realtimeProcessor.current;
    const source = realtimeSource.current;
    const mute = realtimeMute.current;
    realtimeProcessor.current = null;
    realtimeSource.current = null;
    realtimeMute.current = null;
    try {
      processor?.disconnect();
      source?.disconnect();
      mute?.disconnect();
    } catch {
      /* disconnected */
    }
    const context = realtimeAudioContext.current;
    realtimeAudioContext.current = null;
    if (context) void context.close().catch(() => undefined);
    const socket = realtimeSocket.current;
    if (socket?.readyState === WebSocket.OPEN && !dispose) {
      try {
        socket.send(JSON.stringify({ action: "finish" }));
      } catch {
        /* closed */
      }
      setRealtimeStatus("正在完成实时转写…");
    }
    if (dispose && socket && socket.readyState < WebSocket.CLOSING) {
      try {
        socket.close();
      } catch {
        /* closed */
      }
      realtimeSocket.current = null;
    }
  }

  function applyRealtimeSentence(payload: unknown, run: number) {
    if (realtimeRun.current !== run) return;
    const sentence = readRealtimeSentence(payload);
    if (!sentence.text) return;
    const rawStartMs = sentence.startMs || Math.max(0, liveSegmentsRef.current.at(-1)?.endMs || 0);
    const startMs = rawStartMs + realtimeOffsetMs.current;
    const endMs = Math.max(startMs, (sentence.endMs || rawStartMs) + realtimeOffsetMs.current);
    const next = [...liveSegmentsRef.current];
    const existing = next.findIndex((item) => item.startMs === startMs);
    if (existing >= 0) next[existing] = { startMs, endMs, text: sentence.text };
    else if (
      !next.some(
        (item) =>
          item.text === sentence.text && Math.abs(item.startMs - startMs) < 250,
      )
    )
      next.push({ startMs, endMs, text: sentence.text });
    next.sort(
      (left, right) => left.startMs - right.startMs || left.endMs - right.endMs,
    );
    liveSegmentsRef.current = next;
    const transcript = next.map((item) => item.text).join("");
    liveTranscriptRef.current = transcript;
    setLiveTranscript(transcript);
    setRealtimeStatus("实时转写中");
  }

  async function startRealtimeTranscription(media: MediaStream, resume = false) {
    stopRealtimeTranscription(true);
    if (!resume) {
      liveTranscriptRef.current = "";
      liveSegmentsRef.current = [];
    }
    realtimeFailedRef.current = false;
    realtimeOffsetMs.current = resume && segmentRecordingStartedAt.current
      ? Math.max(0, Date.now() - segmentRecordingStartedAt.current)
      : 0;
    if (!resume) setLiveTranscript("");
    setRealtimeRetryAvailable(false);
    const run = realtimeRun.current;
    try {
      const access = await jsonFetch("/api/realtime-asr/token", {
        method: "POST",
      });
      if (realtimeRun.current !== run) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(
        `${protocol}//${window.location.host}/ws/realtime-asr`,
      );
      socket.binaryType = "arraybuffer";
      realtimeSocket.current = socket;
      socket.onopen = () => {
        if (realtimeRun.current !== run) return;
        socket.send(
          JSON.stringify({
            action: "start",
            token: access.token,
            taskId: crypto.randomUUID(),
            sampleRate: 16000,
          }),
        );
        setRealtimeStatus("正在连接实时转写…");
      };
      socket.onmessage = (event) => {
        if (realtimeRun.current !== run) return;
        try {
          const message = JSON.parse(String(event.data));
          if (message.type === "ready") {
            setRealtimeStatus("实时转写中");
            setRealtimeRetryAvailable(false);
            return;
          }
          if (message.type === "result")
            applyRealtimeSentence(message.data, run);
          if (message.type === "error") {
            realtimeFailedRef.current = true;
            setRealtimeStatus(`实时转写不可用：${message.error}`);
            setRealtimeRetryAvailable(true);
          }
          if (message.type === "closed") {
            realtimeFailedRef.current = true;
            setRealtimeStatus(`实时转写已中断，录音仍会正常保存：${message.reason || message.code || "未知原因"}`);
            setRealtimeRetryAvailable(true);
          }
        } catch {
          /* ignore malformed upstream payload */
        }
      };
      socket.onerror = () => {
        if (realtimeRun.current === run) {
          setRealtimeStatus("实时转写连接失败，录音仍会正常保存");
          setRealtimeRetryAvailable(true);
        }
      };
      socket.onclose = (event) => {
        if (realtimeRun.current !== run) return;
        realtimeFailedRef.current = true;
        setRealtimeStatus(`实时转写已中断，录音仍会正常保存：${event.reason || event.code || "连接关闭"}`);
        setRealtimeRetryAvailable(true);
      };
      const AudioContextCtor =
        window.AudioContext ||
        (window as typeof window & { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!AudioContextCtor) {
        setRealtimeStatus("当前浏览器不支持实时转写");
        return;
      }
      const context = new AudioContextCtor();
      realtimeAudioContext.current = context;
      const source = context.createMediaStreamSource(media);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const mute = context.createGain();
      mute.gain.value = 0;
      realtimeSource.current = source;
      realtimeProcessor.current = processor;
      realtimeMute.current = mute;
      processor.onaudioprocess = (event) => {
        if (realtimeRun.current !== run || socket.readyState !== WebSocket.OPEN)
          return;
        const pcm = downsamplePcm(
          event.inputBuffer.getChannelData(0),
          context.sampleRate,
        );
        socket.send(pcm.buffer);
      };
      source.connect(processor);
      processor.connect(mute);
      mute.connect(context.destination);
      await context.resume();
    } catch {
      setRealtimeStatus("实时转写启动失败，录音仍会正常保存");
      setRealtimeRetryAvailable(true);
    }
  }
  function retryRealtimeTranscription() {
    if (!recording || !stream.current) return;
    setRealtimeStatus("正在恢复实时转写，已识别的内容会保留…");
    void startRealtimeTranscription(stream.current, true);
  }
  function questionAudioKey(index = stepIndex, followupRoundValue = followupRound, isFollowup = Boolean(followup)) {
    return isFollowup ? `${index}:followup:${followupRoundValue}` : `${index}:main`;
  }
  function saveGeneratedQuestionAudio(payload: { audio?: { base64?: string; mime?: string } | null }, key: string) {
    const encoded = String(payload.audio?.base64 || "");
    if (!encoded) return;
    try {
      const bytes = Uint8Array.from(atob(encoded), (value) => value.charCodeAt(0));
      setQuestionAudioBlobs((items) => ({ ...items, [key]: new Blob([bytes], { type: String(payload.audio?.mime || "audio/mpeg") }) }));
    } catch { /* Browser fallback still reads the text. */ }
  }
  async function generateDynamicQuestion(
    index = stepIndex,
    priorDrafts = drafts,
    sessionOverride = sessionId,
    stepsOverride = steps,
  ) {
    const target = stepsOverride[index];
    if (
      !target ||
      target.kind !== "dynamic" ||
      !sessionOverride ||
      dynamicQuestionLoading
    )
      return;
    setDynamicQuestionLoading(true);
    setDynamicQuestionError("");
    setMessage("正在根据此前回答生成自由交流问题…");
    try {
      const data = await jsonFetch(
        "/api/simulations/" + sessionOverride + "/dynamic-question",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            moduleId: target.templateModuleId || target.id,
            priorAnswers: priorDrafts.map((item) => ({
              moduleTitle: item.moduleTitle,
              question: item.question,
              answer: item.answer,
              transcript: item.transcript,
            })),
          }),
        },
      );
      const question = String(data.question || "").trim();
      if (!question) throw new Error("未生成有效问题");
      saveGeneratedQuestionAudio(data, `${index}:main`);
      if (data.audioError) setMessage(`题目已生成；语音合成失败，将使用浏览器朗读：${data.audioError}`);
      setSteps((items) =>
        items.map((item, position) =>
          position === index ? { ...item, question } : item,
        ),
      );
      setStepStartedAt(Date.now());
      setStepElapsed(0);
      setPromptCycle((value) => value + 1);
      if (!data.audioError) setMessage("");
    } catch (error) {
      const text = (error as Error).message;
      setDynamicQuestionError(text);
      setMessage(text);
    } finally {
      setDynamicQuestionLoading(false);
    }
  }
  async function start(startTemplateId = templateId) {
    try {
      const data = await jsonFetch("/api/simulations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId: Number(startTemplateId) }),
      });
      const firstDynamic = data.steps?.[0]?.kind === "dynamic";
      setSessionId(data.sessionId);
      setSteps(data.steps);
      setStepIndex(0);
      setStepStartedAt(firstDynamic ? 0 : Date.now());
      setStepElapsed(0);
      setElapsed(0);
      setDrafts([]);
      setQuestionAudioBlobs({});
      setAnswer("");
      setFollowup(null);
      setFollowupGenerating(false);
      setSegmentBlob(null);
      finishedRef.current = false;
      submissionRef.current = false;
      moduleTimeoutRef.current = "";
      segmentRecordingStartedAt.current = 0;
      setReading(false);
      setDynamicQuestionError("");
      setSubmitting(false);
      setCompletedSessionId(null);
      setCountdown(firstDynamic ? null : 3);
      if (firstDynamic)
        void generateDynamicQuestion(0, [], data.sessionId, data.steps);
    } catch (error) {
      setMessage((error as Error).message);
    }
  }
  async function startRecording() {
    try {
      const media =
        stream.current ||
        (await navigator.mediaDevices.getUserMedia({ audio: true }));
      stream.current = media;
      chunks.current = [];
      const value = new MediaRecorder(media);
      value.ondataavailable = (event) => {
        if (event.data.size) chunks.current.push(event.data);
      };
      value.onstop = () => {
        const blob = new Blob(chunks.current, {
          type: value.mimeType || "audio/webm",
        });
        setSegmentBlob(blob);
        setRecording(false);
        segmentStopResolver.current?.(blob);
        segmentStopResolver.current = null;
      };
      recorder.current = value;
      value.start();
      segmentRecordingStartedAt.current = Date.now();
      setRecording(true);
      void startRealtimeTranscription(media);
    } catch {
      setMessage("无法使用麦克风，请先允许浏览器录音权限。");
    }
  }
  const startRecordingWithCue = useCallback(async () => {
    playCue("recording");
    await startRecording();
  }, [playCue]);
  function stopQuestionReading() {
    speechRunId.current += 1;
    if (questionReadingSafetyTimer.current !== null) {
      window.clearTimeout(questionReadingSafetyTimer.current);
      questionReadingSafetyTimer.current = null;
    }
    window.speechSynthesis?.cancel();
    questionPromptAudio.current?.pause();
    questionPromptAudio.current = null;
    setReading(false);
    setCountdown(null);
  }
  const countdownStepRef = useRef("");
  useEffect(() => {
    const promptKey = `${sessionId}:${stepIndex}:${followup ? "followup" : "main"}:${promptCycle}`;
    if (
      !sessionId ||
      submitting ||
      finishedRef.current ||
      submissionRef.current ||
      promptKey === countdownStepRef.current
    )
      return;
    countdownStepRef.current = promptKey;

    if (stepStartedAt) {
      setReading(false);
      setCountdown(3);
    }
  }, [sessionId, stepIndex, stepStartedAt, followup, promptCycle, submitting]);
  useEffect(() => {
    if (
      !sessionId ||
      countdown === null ||
      submitting ||
      finishedRef.current ||
      submissionRef.current
    )
      return;
    playCue("countdown", countdown);
    setMessage(`准备开始 · ${countdown}`);
    const timer = window.setTimeout(() => {
      if (submissionRef.current || finishedRef.current) return;
      if (countdown > 1) {
        setCountdown(countdown - 1);
        return;
      }
      setCountdown(null);
      setMessage("");
      // 老师追问生成后，页面上的“当前题目”已经切换为 followup。
      // 朗读必须使用同一份当前文本，不能继续朗读原始题目。
      const text = followup || current?.question || current?.prompt || "";
      if (readQuestion && text) {
        const runId = ++speechRunId.current;
        let completed = false;
        setReading(true);
        const finishReading = () => {
          if (
            completed ||
            speechRunId.current !== runId ||
            submissionRef.current ||
            finishedRef.current
          )
            return;
          completed = true;
          setReading(false);
          // Some browser TTS engines emit `end` a little before their final
          // samples leave the speaker.  Keep a tiny, cancellable gap so the
          // auto recorder can never capture the question itself.
          if (autoRecord) {
            questionReadingSafetyTimer.current = window.setTimeout(() => {
              questionReadingSafetyTimer.current = null;
              if (
                speechRunId.current === runId &&
                !submissionRef.current &&
                !finishedRef.current
              ) void startRecordingWithCue();
            }, 250);
          }
        };
        const browserFallback = () => {
          if (submissionRef.current || finishedRef.current) return;
          if (current?.suppressBrowserRead && !followup) { finishReading(); return; }
          if (!("speechSynthesis" in window)) { finishReading(); return; }
          window.speechSynthesis.cancel();
          const utterance = new SpeechSynthesisUtterance(text);
          utterance.lang = /[\u4e00-\u9fff]/.test(text) ? "zh-CN" : "en-US";
          utterance.onend = finishReading; utterance.onerror = finishReading; window.speechSynthesis.speak(utterance);
        };
        const generatedAudio = questionAudioBlobs[questionAudioKey()];
        const audioUrl = generatedAudio ? URL.createObjectURL(generatedAudio) : current?.questionVoiceUrl;
        if (audioUrl) {
          const audio = new Audio(audioUrl); questionPromptAudio.current = audio;
          audio.onended = () => { if (generatedAudio) URL.revokeObjectURL(audioUrl); finishReading(); };
          audio.onerror = () => { if (generatedAudio) URL.revokeObjectURL(audioUrl); browserFallback(); };
          void audio.play().catch(browserFallback);
        } else browserFallback();
      } else {
        setReading(false);
        if (autoRecord) void startRecordingWithCue();
      }
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [
    sessionId,
    countdown,
    submitting,
    current,
    questionAudioBlobs,
    followup,
    followupRound,
    readQuestion,
    autoRecord,
    playCue,
    startRecordingWithCue,
  ]);
  async function stopRecording() {
    stopRealtimeTranscription();
    const value = recorder.current;
    if (!value || value.state !== "recording") return segmentBlob;
    return new Promise<Blob | null>((resolve) => {
      segmentStopResolver.current = resolve;
      value.stop();
    });
  }
  async function generateFollowup(
    sourceAnswer = answer,
    primaryAlreadySaved = false,
    priorTurns = followupTurns,
    round = followupRound + 1,
  ) {
    if (!current || !sourceAnswer.trim() || followupGenerating) return false;
    if (!primaryAlreadySaved) {
      saveCurrent(current.title, current.question || current.prompt || "");
    }
    setFollowupGenerating(true);
    try {
      const data = await jsonFetch(
        "/api/simulations/" + sessionId + "/followup",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            question: current.question || current.prompt,
            answer: sourceAnswer,
            moduleTitle: current.title,
            priorTurns,
            followupRound: round,
            followupCount: Math.max(1, Number(current.followupCount) || 1),
          }),
        },
      );
      const nextFollowup = String(data.followup || "").trim();
      setFollowup(nextFollowup);
      saveGeneratedQuestionAudio(data, `${stepIndex}:followup:${round}`);
      if (data.audioError) setMessage(`追问已生成；语音合成失败，将使用浏览器朗读：${data.audioError}`);
      return true;
    } catch (error) {
      setMessage((error as Error).message);
      return false;
    } finally {
      setFollowupGenerating(false);
    }
  }
  function saveCurrent(
    title = current?.title || "",
    question = followup || current?.question || current?.prompt || "",
    followupQuestion?: string,
    audioOverride: Blob | null = segmentBlob,
    keepGeneratedFollowup = false,
  ) {
    if (!current) return null;
    const transcript = liveTranscriptRef.current || answer;
    const draft = {
      moduleIndex: stepIndex,
      moduleTitle: followup ? current.title + " · 老师追问" : title,
      questionId: current.questionId,
      question,
      answer,
      transcript,
      transcriptSegments: liveSegmentsRef.current.length
        ? [...liveSegmentsRef.current]
        : undefined,
      elapsedSeconds: stepElapsed,
      audio: audioOverride || undefined,
      questionAudio: questionAudioBlobs[questionAudioKey()],
      followupQuestion,
    };
    setDrafts((items) => [...items, draft]);
    setAnswer("");
    setSegmentBlob(null);
    if (!keepGeneratedFollowup) setFollowup(null);
    stopRealtimeTranscription(true);
    liveTranscriptRef.current = "";
    liveSegmentsRef.current = [];
    setLiveTranscript("");
    setRealtimeStatus("");
    setRealtimeRetryAvailable(false);
    return draft;
  }
  async function next() {
    if (
      !current ||
      followupGenerating ||
      !(liveTranscript.trim() || answer.trim() || segmentBlob)
    )
      return;
    const audio = recording ? await stopRecording() : segmentBlob;
    const response = liveTranscriptRef.current || answer;
    if (
      current.allowFollowup &&
      followupRound < Math.max(1, Number(current.followupCount) || 1) &&
      !response.trim()
    ) {
      setMessage("生成老师追问需要文字回答；请填写作答提纲，或等待实时转写出现文字后再继续。");
      return;
    }
    const activeQuestion = followup || current.question || current.prompt || "";
    const followupLimit = Math.max(1, Number(current.followupCount) || 1);
    if (current.allowFollowup && followupRound < followupLimit) {
      const priorTurns = [
        ...followupTurns,
        { question: activeQuestion, answer: response },
      ];
      setFollowupTurns(priorTurns);
      if (
        await generateFollowup(response, true, priorTurns, followupRound + 1)
      ) {
        saveCurrent(
          undefined,
          activeQuestion,
          followup || undefined,
          audio,
          true,
        );
        setFollowupRound((value) => value + 1);
        setStepStartedAt(Date.now());
        setStepElapsed(0);
        setPromptCycle((value) => value + 1);
      }
      return;
    }
    setFollowupRound(0);
    setFollowupTurns([]);
    const saved = saveCurrent(
      undefined,
      activeQuestion,
      followup || undefined,
      audio,
    );
    const nextDrafts = saved ? [...drafts, saved] : drafts;
    if (stepIndex + 1 < steps.length) {
      const nextIndex = stepIndex + 1;
      const nextStep = steps[nextIndex];
      setStepIndex(nextIndex);
      setDynamicQuestionError("");
      if (nextStep?.kind === "dynamic" && !nextStep.question) {
        setStepStartedAt(0);
        setStepElapsed(0);
        setCountdown(null);
        void generateDynamicQuestion(nextIndex, nextDrafts);
      } else {
        setStepStartedAt(Date.now());
        setStepElapsed(0);
      }
    } else {
      // The final follow-up is still the current prompt here.  Cancel it before
      // clearing followup / opening the completion dialog, so it cannot replay.
      stopQuestionReading();
      await finish(nextDrafts);
    }
  }
  async function exitSimulation() {
    stopQuestionReading();
    if (recorder.current?.state === "recording") await stopRecording();
    else stopRealtimeTranscription(true);
    stream.current?.getTracks().forEach((track) => track.stop());
    if (sessionId && !finishedRef.current) {
      try {
        await jsonFetch("/api/simulations/" + sessionId, { method: "DELETE" });
      } catch (error) {
        setMessage((error as Error).message);
        return;
      }
    }
    onBack();
  }
  async function finish(finalDrafts = drafts) {
    if (!sessionId || submitting || submissionRef.current) return;
    submissionRef.current = true;
    stopQuestionReading();
    setSubmitting(true);
    try {
      const form = new FormData();
      form.set("elapsedSeconds", String(elapsed));
      form.set(
        "transcript",
        finalDrafts
          .map((item) => item.transcript)
          .filter(Boolean)
          .join("\n"),
      );
      form.set("answers", JSON.stringify(finalDrafts));
      finalDrafts.forEach((item, index) => {
        if (item.audio)
          form.set(
            "audio-" + index,
            new File([item.audio], "segment-" + index + ".webm", {
              type: item.audio.type || "audio/webm",
            }),
          );
        if (item.questionAudio)
          form.set(
            "question-audio-" + index,
            new File([item.questionAudio], "question-" + index + ".mp3", {
              type: item.questionAudio.type || "audio/mpeg",
            }),
          );
      });
      await jsonFetch("/api/simulations/" + sessionId, {
        method: "POST",
        body: form,
      });
      finishedRef.current = true;
      stream.current?.getTracks().forEach((track) => track.stop());
      setMessage("");
      setCompletedSessionId(sessionId);
    } catch (error) {
      setMessage((error as Error).message);
      setSubmitting(false);
      submissionRef.current = false;
    }
  }
  if (!sessionId)
    return (
      <SimulationLobby
        templates={templates}
        templateId={templateId}
        onSelect={setTemplateId}
        onStart={(id) => {
          setTemplateId(String(id));
          void start(String(id));
        }}
        onBack={onBack}
        format={format}
      />
    );
  if (!current) return null;
  const dynamicPending = current.kind === "dynamic" && !current.question;
  const hasCurrentResponse = Boolean(
    liveTranscript.trim() || answer.trim() || segmentBlob,
  );
  const followupLimit = Math.max(1, Number(current.followupCount) || 1);
  const followupResponseMissing = Boolean(!hasCurrentResponse);
  const nextDisabled = Boolean(
    countdown !== null ||
      reading ||
      submitting ||
      followupGenerating ||
      followupResponseMissing,
  );
  const isFinalSubmission =
    stepIndex + 1 === steps.length &&
    (!current.allowFollowup || followupRound >= followupLimit);
  const nextHint = followupGenerating
    ? "老师正在结合本题与刚才的作答生成下一轮追问，请稍候。"
    : followupResponseMissing
      ? `请先完成${followup ? "本次老师追问" : "本题"}的作答。`
      : current.allowFollowup && followupRound < followupLimit
        ? `确认回答后，将自动生成老师追问（第 ${followupRound + 1}/${followupLimit} 轮）。`
        : followup
          ? "已完成全部追问，可以保存并进入下一环节。"
          : "确认本段作答后，保存并进入下一环节。";
  const prompt =
    followup || current.question || current.prompt || "请开始作答。";
  return (
    <main className="simulation-page running">
      <div className="simulation-running-head">
        <button className="back" onClick={() => void exitSimulation()}>
          退出模拟
        </button>
        <div>
          <span>全程倒计时</span>
          <strong>{format(totalSeconds - elapsed)}</strong>
        </div>
        <div>
          <span>本环节建议时长</span>
          <strong
            className={
              stepElapsed > (current.timeSeconds || 0) ? "overtime" : ""
            }
          >
            {format(current.timeSeconds || 0)}
          </strong>
          {Number(current.timeSeconds) > 0 &&
          stepElapsed > Number(current.timeSeconds) ? (
            <small className="simulation-overtime-hint">
              {moduleTimeoutMode === "immediate_advance"
                ? "已到建议时长将自动进入下一题"
                : moduleTimeoutMode === "auto_advance"
                  ? "超过 50% 后将自动进入下一题"
                  : "已超出建议时长，仍可继续作答"}
            </small>
          ) : null}
        </div>
      </div>
      <ol className="simulation-puzzle">
        {steps.map((item, index) => (
          <li
            className={
              index === stepIndex ? "active" : index < stepIndex ? "done" : ""
            }
            key={item.id}
          >
            <b>{String(index + 1).padStart(2, "0")}</b>
            <span>{item.title}</span>
          </li>
        ))}
      </ol>
      {countdown !== null && (
        <div
          className="simulation-countdown-overlay"
          role="status"
          aria-live="assertive"
        >
          <div className="simulation-countdown-number" key={countdown}>
            {countdown}
          </div>
          <strong>准备开始</strong>
          <small>
            {readQuestion
              ? autoRecord
                ? "题目朗读结束后将自动开始录音"
                : "题目朗读结束后开始作答"
              : autoRecord
                ? "倒计时结束后将自动开始录音"
                : "倒计时结束后开始作答"}
          </small>
        </div>
      )}
      <section className="simulation-question">
        <span className="section-kicker">
          {followup ? "TEACHER FOLLOW-UP" : current.title}
        </span>
        {current.allowFollowup && (
          <span className="simulation-followup-tag">
            老师追问 · 最多 {followupLimit} 次
          </span>
        )}
        <h1>{dynamicPending ? "正在准备自由交流问题…" : prompt}</h1>
        {current.subcategory && <small>{current.subcategory}</small>}
        <p>
          {followup
            ? "这是基于刚才回答生成的老师追问，请继续作答。"
            : dynamicPending
              ? "系统会结合此前的自我介绍、项目介绍和作答内容生成问题；不会在此阶段开启录音。"
              : current.kind === "dynamic"
                ? "这道自由交流题由此前回答动态生成。"
                : moduleTimeoutMode === "immediate_advance"
                  ? "达到本环节建议时长后，会自动保存并进入下一题；全程时间到后结束模拟。"
                  : moduleTimeoutMode === "auto_advance"
                    ? "超出本环节建议时长 50% 后，会自动保存并进入下一题；全程时间到后结束模拟。"
                    : "本环节超过建议时长只会提醒；全程时间到后应结束模拟。"}
        </p>
        {dynamicPending && (
          <div className="simulation-generating">
            <span>
              {dynamicQuestionLoading
                ? "正在调用模型生成问题，请稍候…"
                : dynamicQuestionError || "正在准备问题…"}
            </span>
            {!dynamicQuestionLoading && (
              <button
                type="button"
                onClick={() => void generateDynamicQuestion()}
              >
                重新生成问题
              </button>
            )}
          </div>
        )}
      </section>
      {!dynamicPending && (
        <>
          <section className="simulation-answer">
            <textarea
              disabled={countdown !== null || reading}
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              placeholder="可选：记录回答提纲；录音和实时文字稿将保存到本场模拟。"
            />
            {realtimeStatus && (
              <div className="realtime-status">{realtimeStatus}{realtimeRetryAvailable && recording ? <button type="button" onClick={retryRealtimeTranscription}>恢复实时转写</button> : null}</div>
            )}
            {liveTranscript && (
              <div className="live-transcript">
                <small>实时识别稿</small>
                <p>{liveTranscript}</p>
              </div>
            )}
            <div className="recorder">
              <span>
                <b>
                  {recording
                    ? "正在分段录音"
                    : segmentBlob
                      ? "本段录音已完成"
                      : "准备录制本段回答"}
                </b>
                <small>当前模块：{current.title}</small>
              </span>
              <button
                disabled={countdown !== null || reading}
                onClick={() =>
                  recording ? void stopRecording() : void startRecording()
                }
              >
                {recording ? "结束本段录音" : "开始本段录音"}
              </button>
            </div>
          </section>
          <div className="simulation-actions">
            <div>
              <strong>
                {followup ? `老师追问 · 第 ${followupRound}/${followupLimit} 轮` : "本段作答"}
              </strong>
              <small>{nextHint}</small>
            </div>
            <button disabled={nextDisabled} onClick={() => void next()}>
              {submitting
                ? "正在提交记录…"
                : current.allowFollowup && followupRound < followupLimit
                ? followup
                  ? `完成本次追问并生成下一轮（${followupRound + 1}/${followupLimit}） →`
                  : `完成回答并生成老师追问（1/${followupLimit}） →`
                : isFinalSubmission
                  ? "结束本次回答并提交记录"
                  : followup
                    ? "完成最后一轮追问并进入下一环节 →"
                    : "保存本段并进入下一环节 →"}
            </button>
          </div>
        </>
      )}
      {completedSessionId && (
        <div className="simulation-complete-backdrop" role="presentation">
          <section
            className="simulation-complete-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="simulation-complete-title"
            aria-describedby="simulation-complete-description"
          >
            <div className="simulation-complete-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none">
                <path d="m5 12 4.2 4.2L19.5 6" />
              </svg>
            </div>
            <span className="section-kicker">SIMULATION SUBMITTED</span>
            <h2 id="simulation-complete-title">本次模拟已成功提交</h2>
            <p id="simulation-complete-description">
              您已成功提交，现在可去真实模拟记录界面查看并复盘。
            </p>
            <button autoFocus onClick={() => onReview(completedSessionId)}>
              确认，查看本次复盘
            </button>
          </section>
        </div>
      )}
    </main>
  );
}

function SimulationLobby({
  templates,
  templateId,
  onSelect,
  onStart,
  onBack,
  format,
}: {
  templates: SimulationTemplate[];
  templateId: string;
  onSelect: (value: string) => void;
  onStart: (id: number) => void;
  onBack: () => void;
  format: (seconds: number) => string;
}) {
  return (
    <main className="simulation-page">
      <button className="back" onClick={onBack}>
        ← 返回练习方式
      </button>
      <header>
        <span className="section-kicker">REAL INTERVIEW SIMULATION</span>
        <h1>真实场景模拟</h1>
        <p>
          选择一个学校的面试流程，按模块完成整场练习；每次模拟都会独立保存。
        </p>
      </header>
      <div className="simulation-template-list">
        {templates.map((item) => (
          <article key={item.id}>
            <div>
              <strong>{item.name}</strong>
              <span>{item.description || "暂无流程说明"}</span>
              <small>
                总时长 {format(item.totalSeconds)} ·{" "}
                {Array.isArray(item.modules) ? item.modules.length : 0} 个模块
              </small>
            </div>
            <button
              className="simulation-enter"
              onClick={() => {
                onSelect(String(item.id));
                onStart(item.id);
              }}
            >
              进入模拟
            </button>
          </article>
        ))}
      </div>
      {!templates.length && (
        <div className="empty">
          <h3>暂无可用流程</h3>
          <p>请管理员在后台添加学校面试流程。</p>
        </div>
      )}
    </main>
  );
}

type SimulationEvaluation = {
  id: number;
  status: string;
  result: string | null;
  error: string | null;
  createdAt: string;
  completedAt?: string | null;
};

function LegacySimulationHistory({ onBack }: { onBack: () => void }) {
  const [records, setRecords] = useState<SimulationRecord[]>([]);
  const [templateFilter, setTemplateFilter] = useState("");
  const [selected, setSelected] = useState<SimulationRecord | null>(null);
  const [detail, setDetail] = useState<{
    session: SimulationRecord;
    answers: Array<{
      id: number;
      moduleIndex: number;
      moduleTitle: string;
      question: string;
      answer?: string | null;
      transcript?: string | null;
      elapsedSeconds: number;
      hasAudio: number;
      createdAt: string;
    }>;
  } | null>(null);
  const [evaluations, setEvaluations] = useState<SimulationEvaluation[]>([]);
  const [chatMessages, setChatMessages] = useState<
    Array<{ id: number; role: "user" | "assistant"; content: string }>
  >([]);
  const [message, setMessage] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  useEffect(() => {
    void jsonFetch("/api/simulation-records")
      .then((data) => setRecords(data.records || []))
      .catch((error) => setMessage((error as Error).message));
  }, []);
  const filteredRecords = templateFilter
    ? records.filter((item) => item.templateName === templateFilter)
    : records;
  const loadReview = useCallback(async (sessionId: number) => {
    const data = await jsonFetch(
      "/api/ai/simulation-evaluations?sessionId=" + sessionId,
    );
    setEvaluations(data.evaluations || []);
    setChatMessages(
      (data.messages || []).map(
        (item: {
          id: number;
          role: "user" | "assistant";
          content: string;
        }) => ({ id: Number(item.id), role: item.role, content: item.content }),
      ),
    );
  }, []);
  useEffect(() => {
    if (!selected || !evaluations.some((item) => item.status === "processing"))
      return;
    const timer = window.setInterval(() => {
      void loadReview(selected.id).catch(() => undefined);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [selected, evaluations, loadReview]);
  async function openRecord(item: SimulationRecord) {
    setSelected(item);
    setDetail(null);
    setEvaluations([]);
    setChatMessages([]);
    try {
      const [record] = await Promise.all([
        jsonFetch("/api/simulation-records/" + item.id),
        loadReview(item.id),
      ]);
      setDetail(record);
    } catch (error) {
      setMessage((error as Error).message);
    }
  }
  async function generateReview() {
    if (!selected || generating) return;
    setGenerating(true);
    setMessage("");
    try {
      const data = await jsonFetch("/api/ai/simulation-evaluations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: selected.id }),
      });
      setMessage(
        data.reused
          ? "本场模拟没有新的回答，已保留现有复盘。"
          : "模拟复盘已提交，正在生成，请稍候。",
      );
      await loadReview(selected.id);
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setGenerating(false);
    }
  }
  async function sendChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = chatInput.trim();
    if (!content || !selected || chatLoading) return;
    const clientId = -Date.now();
    setChatLoading(true);
    setMessage("");
    setChatInput("");
    setChatMessages((current) => [
      ...current,
      { id: clientId - 1, role: "user", content },
      { id: clientId, role: "assistant", content: "" },
    ]);
    try {
      const response = await fetch("/api/ai/simulation-chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ sessionId: selected.id, message: content }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "发送失败");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("浏览器不支持流式响应");
      const decoder = new TextDecoder();
      let buffer = "";
      const applyEvent = (raw: string) => {
        const line = raw
          .split(/\r?\n/)
          .find((item) => item.startsWith("data:"));
        if (!line) return;
        const payload = JSON.parse(line.slice(5).trim()) as {
          type?: string;
          content?: string;
          error?: string;
        };
        if (payload.type === "error")
          throw new Error(payload.error || "对话生成失败");
        if (payload.type === "delta" && payload.content)
          setChatMessages((current) =>
            current.map((item) =>
              item.id === clientId
                ? { ...item, content: item.content + payload.content }
                : item,
            ),
          );
      };
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() || "";
        events.forEach(applyEvent);
      }
      if (buffer.trim()) applyEvent(buffer);
      await loadReview(selected.id);
    } catch (error) {
      setMessage((error as Error).message);
      setChatMessages((current) =>
        current.filter((item) => item.id !== clientId),
      );
    } finally {
      setChatLoading(false);
    }
  }
  if (selected && detail) {
    const completed = evaluations.some((item) => item.status === "completed");
    return (
      <main className="simulation-page">
        <button
          className="back"
          onClick={() => {
            setSelected(null);
            setDetail(null);
          }}
        >
          ← 返回真实模拟记录
        </button>
        <header className="simulation-detail-head">
          <div>
            <span className="section-kicker">SIMULATION REVIEW</span>
            <h1>{detail.session.templateName}</h1>
            <p>
              {detail.session.username
                ? `学员：${detail.session.username} · `
                : ""}
              {formatRecordDate(detail.session.startedAt)} · 用时{" "}
              {Math.floor(detail.session.elapsedSeconds / 60)} 分钟
            </p>
          </div>
          <div className="simulation-review-actions">
            <button
              className="review-generate"
              disabled={generating}
              onClick={() => void generateReview()}
            >
              {generating
                ? "正在提交…"
                : completed
                  ? "更新模拟复盘"
                  : "复盘模拟流程"}
            </button>
            <button
              className="simulation-chat-trigger"
              onClick={() => setChatOpen(true)}
            >
              和小鱼讨论
            </button>
          </div>
        </header>
        {message && <div className="management-message">{message}</div>}
        <section className="simulation-review-evaluations review-section">
          <div className="review-section-title">
            <div>
              <span className="section-kicker">SIMULATION EVALUATION</span>
              <h2>整场复盘</h2>
            </div>
            <small>
              {evaluations.length ? `${evaluations.length} 次评估` : "尚未生成"}
            </small>
          </div>
          {evaluations.length ? (
            evaluations.map((item, index) => (
              <details
                className="evaluation-card"
                key={item.id}
                open={index === 0}
              >
                <summary>
                  <span>
                    <strong>
                      {index === 0
                        ? "最新复盘"
                        : "历史复盘 " + (evaluations.length - index)}
                    </strong>
                    <small>{formatRecordDate(item.createdAt)}</small>
                  </span>
                  <em>
                    {item.status === "processing"
                      ? "生成中"
                      : item.status === "completed"
                        ? "已完成"
                        : "失败"}
                  </em>
                </summary>
                {item.status === "processing" && (
                  <p className="evaluation-pending">
                    小鱼正在分析整场模拟，请稍候，页面会自动刷新。
                  </p>
                )}
                {item.status === "failed" && (
                  <p className="evaluation-error">
                    {item.error || "本次复盘失败"}
                  </p>
                )}
                {item.status === "completed" && (
                  <MarkdownContent
                    value={item.result || ""}
                    className="evaluation-result"
                  />
                )}
              </details>
            ))
          ) : (
            <div className="review-empty">
              点击“复盘模拟流程”后，会使用管理后台当前的评估提示词分析整场表现。
            </div>
          )}
        </section>
        <section className="simulation-answer-list">
          {detail.answers.map((item) => (
            <article key={item.id}>
              <div className="simulation-answer-head">
                <span>
                  模块 {item.moduleIndex + 1} · {item.moduleTitle}
                </span>
                <small>
                  {formatRecordDate(item.createdAt)} · {item.elapsedSeconds}s
                </small>
              </div>
              <h2>{item.question}</h2>
              <p>{item.transcript || item.answer || "暂无文字回答"}</p>
              {item.hasAudio ? (
                <AudioWithDuration
                  src={
                    "/api/simulation-records/" +
                    detail.session.id +
                    "/audio/" +
                    item.id
                  }
                />
              ) : null}
            </article>
          ))}
        </section>
        {chatOpen && (
          <div
            className="chat-modal-backdrop"
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !chatLoading)
                setChatOpen(false);
            }}
          >
            <section
              className="chat-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="simulation-chat-modal-title"
            >
              <div className="chat-modal-head">
                <div>
                  <span className="section-kicker">SIMULATION DISCUSSION</span>
                  <h2 id="simulation-chat-modal-title">和小鱼讨论</h2>
                  <p>
                    这里是正常讨论，不会自动重复整场评估；小鱼已了解本场题目、回答和转写。
                  </p>
                </div>
                <button
                  className="chat-modal-close"
                  aria-label="关闭对话"
                  disabled={chatLoading}
                  onClick={() => setChatOpen(false)}
                >
                  ×
                </button>
              </div>
              <div className="chat-messages">
                {chatMessages.length ? (
                  chatMessages.map((item) => (
                    <div className={"chat-message " + item.role} key={item.id}>
                      <MarkdownContent
                        value={item.content || (chatLoading ? "正在思考…" : "")}
                      />
                    </div>
                  ))
                ) : (
                  <div className="chat-empty">
                    可以追问某个回答如何改写、某个停顿如何处理，或让小鱼继续扮演老师。
                  </div>
                )}
              </div>
              <form className="chat-form" onSubmit={sendChat}>
                <textarea
                  value={chatInput}
                  onChange={(event) => setChatInput(event.target.value)}
                  placeholder="例如：把我的英文回答改成更自然的 60 秒版本。"
                  disabled={chatLoading}
                />
                <button disabled={chatLoading || !chatInput.trim()}>
                  {chatLoading ? "生成中…" : "发送"}
                </button>
              </form>
            </section>
          </div>
        )}
      </main>
    );
  }
  return (
    <main className="simulation-page">
      <button className="back" onClick={onBack}>
        ← 返回练习方式
      </button>
      <header>
        <span className="section-kicker">SIMULATION HISTORY</span>
        <h1>真实模拟记录</h1>
        <p>按学校流程查看每一次完整面试模拟；管理员可以查看所有学员记录。</p>
      </header>
      {records.length > 0 && (
        <div className="simulation-history-filter">
          <label>
            按学校流程筛选
            <select
              value={templateFilter}
              onChange={(event) => setTemplateFilter(event.target.value)}
            >
              <option value="">全部流程</option>
              {Array.from(
                new Set(records.map((item) => item.templateName)),
              ).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {message && <div className="management-message">{message}</div>}
      <div className="simulation-history-list">
        {filteredRecords.map((item) => (
          <article key={item.id}>
            <div>
              <span className="tag-chip">{item.templateName}</span>
              {item.username && (
                <span className="tag-chip">{item.username}</span>
              )}
              <h2>{formatRecordDate(item.startedAt)}</h2>
              <p>
                {item.answerCount || 0} 个回答 · 用时{" "}
                {Math.floor(item.elapsedSeconds / 60)} 分钟
              </p>
            </div>
            <button onClick={() => void openRecord(item)}>查看复盘</button>
          </article>
        ))}
      </div>
      {!records.length && (
        <div className="empty">
          <h3>还没有真实模拟记录</h3>
          <p>完成一次学校流程模拟后，记录会显示在这里。</p>
        </div>
      )}
    </main>
  );
}
function QuestionBank() {
  const [types, setTypes] = useState<QuestionType[]>([]);
  const [questions, setQuestions] = useState<BankQuestion[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [typeFilter, setTypeFilter] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [jumpPage, setJumpPage] = useState("1");
  const [total, setTotal] = useState(0);
  const [message, setMessage] = useState("");
  const [editor, setEditor] = useState<{
    id?: number;
    typeId: number;
    content: string;
    answer: string;
    subcategory: string;
    status: string;
  } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importTypeId, setImportTypeId] = useState("");
  const [importing, setImporting] = useState(false);
  const [duplicatesOpen, setDuplicatesOpen] = useState(false);
  const [duplicateGroups, setDuplicateGroups] = useState<DuplicateGroup[]>([]);
  const [duplicateSelected, setDuplicateSelected] = useState<number[]>([]);
  const [duplicateKeepers, setDuplicateKeepers] = useState<Record<string, number>>({});
  const [duplicatesLoading, setDuplicatesLoading] = useState(false);
  const pageSize = 8;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const allSelected =
    questions.length > 0 &&
    questions.every((item) => selected.includes(item.id));

  const loadTypes = useCallback(async () => {
    const data = await jsonFetch("/api/question-types");
    setTypes(data.types);
  }, []);
  const load = useCallback(
    async (targetPage = 1) => {
      const params = new URLSearchParams({
        page: String(targetPage),
        pageSize: String(pageSize),
      });
      if (typeFilter) params.set("typeId", typeFilter);
      if (search.trim()) params.set("q", search.trim());
      const data = await jsonFetch("/api/question-bank?" + params.toString());
      setQuestions(data.questions);
      setTotal(data.total);
      setPage(data.page);
      setJumpPage(String(data.page));
      setSelected([]);
    },
    [search, typeFilter],
  );
  useEffect(() => {
    void loadTypes();
  }, [loadTypes]);
  useEffect(() => {
    void load(1);
  }, [load]);

  function openCreate() {
    setEditor({
      typeId: Number(typeFilter || types[0]?.id || 0),
      content: "",
      answer: "",
      subcategory: "",
      status: "active",
    });
  }
  function openEdit(item: BankQuestion) {
    setEditor({
      id: item.id,
      typeId: item.typeId,
      content: item.content,
      answer: item.answer || "",
      subcategory: item.subcategory || "",
      status: item.status,
    });
  }
  function toggleSelected(id: number, checked: boolean) {
    setSelected((current) =>
      checked
        ? Array.from(new Set([...current, id]))
        : current.filter((item) => item !== id),
    );
  }
  function toggleAll(checked: boolean) {
    setSelected(checked ? questions.map((item) => item.id) : []);
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor) return;
    try {
      const result = await jsonFetch("/api/question-bank", {
        method: editor.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editor),
      });
      setEditor(null);
      setMessage("题目已保存");
      const regeneration = result.voiceRegeneration;
      if (regeneration?.found) {
        const text = `题目已保存；已按原配置重生成 ${regeneration.generated || 0}/${regeneration.found} 条配音${regeneration.failed ? `，${regeneration.failed} 条失败，请在题目语音管理查看原因` : ''}。`;
        setMessage(text);
        void pushNotification({ kind: regeneration.failed ? 'warning' : 'success', title: regeneration.failed ? '题目配音部分重生成失败' : '题目配音已重生成', content: text }).catch(() => undefined);
      }
      await load(page);
    } catch (error) {
      setMessage((error as Error).message);
    }
  }
  async function remove(ids: number[], confirmation = "确定删除选中的题目吗？已有作答记录会保留。") {
    if (
      !ids.length ||
      !window.confirm(confirmation)
    )
      return;
    try {
      const result = await jsonFetch("/api/question-bank", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      setMessage("已删除 " + result.deleted + " 道题目");
      await load(Math.min(page, totalPages));
    } catch (error) {
      setMessage((error as Error).message);
    }
  }
  async function loadDuplicates() {
    setDuplicatesLoading(true);
    try {
      const result = await jsonFetch("/api/question-bank?mode=duplicates");
      const groups = (result.groups || []) as DuplicateGroup[];
      setDuplicateGroups(groups);
      setDuplicateSelected([]);
      setDuplicateKeepers(Object.fromEntries(groups.map((group) => [group.key, group.questions[0]?.id])));
    } catch (error) { setMessage((error as Error).message); }
    finally { setDuplicatesLoading(false); }
  }
  async function openDuplicates() {
    setDuplicatesOpen(true);
    await loadDuplicates();
  }
  function toggleDuplicate(id: number, checked: boolean) {
    setDuplicateSelected((current) => checked ? Array.from(new Set([...current, id])) : current.filter((item) => item !== id));
  }
  function selectDeletableDuplicatesWithoutVoice() {
    const ids = duplicateGroups.flatMap((group) => {
      const withoutVoice = group.questions.filter((item) => item.voiceCount === 0);
      // Every duplicate group must retain at least one question. If none has
      // a generated voice, retain the first one; otherwise voices are kept.
      return withoutVoice.length === group.questions.length
        ? withoutVoice.slice(1).map((item) => item.id)
        : withoutVoice.map((item) => item.id);
    });
    setDuplicateSelected(ids);
  }
  async function deleteDuplicateIds(ids: number[], prompt: string) {
    if (!ids.length) return;
    await remove(ids, prompt);
    await loadDuplicates();
  }
  async function importExcel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const file = form.get("file"); const typeId = String(form.get("typeId") || "");
    if (!(file instanceof File) || !file.size) { setMessage("请选择 Excel 文件。"); return; }
    setImporting(true);
    try {
      form.set("preview", "1");
      const result = await jsonFetch("/api/question-bank", {
        method: "PUT",
        body: form,
      });
      setImportFile(file); setImportTypeId(typeId); setImportPreview(result as ImportPreview);
    } catch (error) {
      setMessage((error as Error).message);
    } finally { setImporting(false); }
  }
  async function confirmImport() {
    if (!importFile || !importTypeId) return;
    setImporting(true);
    try {
      const form = new FormData(); form.set("typeId", importTypeId); form.set("file", importFile); form.set("confirmImportDuplicates", "1");
      const result = await jsonFetch("/api/question-bank", { method: "PUT", body: form });
      setImportOpen(false); setImportPreview(null); setImportFile(null);
      setMessage("已导入 " + result.imported + " 条题目" + (result.skipped ? "，自动跳过 " + result.skipped + " 行（含重复或空白）" : ""));
      void pushNotification({ kind: result.errors?.length ? "warning" : "success", title: "题库导入完成", content: `已导入 ${result.imported} 条${result.skipped ? `，跳过 ${result.skipped} 行（重复或空白）` : ""}${result.errors?.length ? `，${result.errors.length} 行导入失败` : ""}。` }).catch(() => undefined);
      await load(1);
    } catch (error) { setMessage((error as Error).message); }
    finally { setImporting(false); }
  }
  function closeImport() {
    if (importing) return;
    setImportOpen(false); setImportPreview(null); setImportFile(null); setImportTypeId("");
  }
  function openImport() {
    setImportPreview(null); setImportFile(null); setImportTypeId(typeFilter || String(types[0]?.id || "")); setImportOpen(true);
  }
  function previewDuplicateRows(rows: { row: number; content: string }[]) {
    return rows.slice(0, 3).map((item) => `第 ${item.row} 行：${item.content}`).join("；");
  }
  function closeDuplicates() {
    if (!duplicatesLoading) setDuplicatesOpen(false);
  }
  async function deleteKeeping(group: DuplicateGroup) {
    const keeper = duplicateKeepers[group.key];
    const ids = group.questions.filter((item) => item.id !== keeper).map((item) => item.id);
    await deleteDuplicateIds(ids, `将保留选中的题目，并删除其余 ${ids.length} 道重复题。已有作答记录会保留，确认继续吗？`);
  }
  async function deleteSelectedDuplicates() {
    await deleteDuplicateIds(duplicateSelected, `确定删除选中的 ${duplicateSelected.length} 道重复题吗？已有作答记录会保留。`);
  }
  function duplicateCountText(group: DuplicateGroup) {
    return `${group.count} 道相同题干`;
  }
  function duplicateAssetText(item: DuplicateQuestion) {
    const labels = [] as string[];
    if (item.recordCount) labels.push(`${item.recordCount} 条作答`);
    if (item.voiceCount) labels.push(`${item.voiceCount} 个配音`);
    return labels.join(" · ") || "无作答和配音";
  }
  function setKeeper(groupKey: string, id: number) {
    setDuplicateKeepers((current) => ({ ...current, [groupKey]: id }));
  }
  function selectedDuplicateCount() {
    return duplicateSelected.length;
  }
  function preventClose(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) closeDuplicates();
  }
  function importPreventClose(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) closeImport();
  }
  function duplicateRowChecked(id: number) {
    return duplicateSelected.includes(id);
  }
  function duplicateKeeperFor(group: DuplicateGroup) {
    return duplicateKeepers[group.key] || group.questions[0]?.id;
  }
  function duplicateRowKey(group: DuplicateGroup, item: DuplicateQuestion) {
    return `${group.key}-${item.id}`;
  }
  function useImportPreview() {
    return Boolean(importPreview);
  }
  function importSubmitText() {
    return importing ? "正在检查…" : "检查重复并继续";
  }
  function confirmImportText() {
    return importing ? "正在导入…" : `跳过重复，导入 ${importPreview?.willImport || 0} 条`;
  }
  function hasDuplicateRows() {
    return Boolean(importPreview && (importPreview.duplicateExisting.length || importPreview.duplicateInFile.length || importPreview.blankRows));
  }
  function importDescription() {
    if (!importPreview) return "Excel 需要包含“题目内容”列；“参考答案”“具体分类”“来源”“备注”均可选。提交后会先检查与题库、文件内部重复的题干。";
    return `预检完成：将导入 ${importPreview.willImport} 条；重复或空白行会自动剔除，不影响其他题目。`;
  }
  function importPreviewRowsLabel() {
    if (!importPreview) return "";
    return `共读取 ${importPreview.totalRows} 行，含 ${importPreview.validRows} 行有题干内容。`;
  }
  function duplicateEmptyText() {
    return duplicatesLoading ? "正在检查全部题目…" : "没有发现重复题干";
  }
  function duplicateEmptyHint() {
    return duplicatesLoading ? "请稍候。" : "题目会按去除首尾空格及连续空格后的题干比对。";
  }
  function duplicateDialogTitle() {
    return `重复题处理${duplicateGroups.length ? ` · ${duplicateGroups.length} 组` : ""}`;
  }
  function duplicateBulkText() {
    return `批量删除已选（${selectedDuplicateCount()}）`;
  }
  function isDuplicateBulkDisabled() { return !selectedDuplicateCount() || duplicatesLoading; }
  function isDuplicateKeepDisabled(group: DuplicateGroup) { return duplicatesLoading || group.count < 2; }
  function duplicateCloseDisabled() { return duplicatesLoading; }
  function importCloseDisabled() { return importing; }
  function importHasIssues() { return hasDuplicateRows(); }
  function importExistingExample() { return importPreview ? previewDuplicateRows(importPreview.duplicateExisting) : ""; }
  function importFileExample() { return importPreview ? previewDuplicateRows(importPreview.duplicateInFile) : ""; }
  function importedFileName() { return importFile?.name || ""; }
  function duplicateQuestionSelectionLabel(item: DuplicateQuestion) { return `选择删除题目 ${item.id}`; }
  function duplicateKeeperLabel(item: DuplicateQuestion) { return `保留题目 ${item.id}`; }
  function duplicateRemoveLabel(group: DuplicateGroup) { return `保留选中项，删除其余 ${group.count - 1} 道`; }
  function duplicateTypeLabel(item: DuplicateQuestion) { return item.typeName || "未分类"; }
  function duplicateSubcategoryLabel(item: DuplicateQuestion) { return item.subcategory || "无具体分类"; }
  function duplicateIdLabel(item: DuplicateQuestion) { return `题目 #${item.id}`; }
  function duplicateContentLabel(group: DuplicateGroup) { return group.content; }
  function importCanConfirm() { return Boolean(importPreview && importFile && importTypeId && !importing); }
  function importCanPreflight() { return !importing; }
  function importNewFile() { setImportPreview(null); setImportFile(null); }
  function keepSelectionChange(group: DuplicateGroup, id: number) { setKeeper(group.key, id); }
  function shouldShowImportWarning() { return useImportPreview() && importHasIssues(); }
  function shouldShowImportClean() { return useImportPreview() && !importHasIssues(); }
  function importDefaultType() { return importTypeId || typeFilter || String(types[0]?.id || ""); }
  function importTypeChange(value: string) { setImportTypeId(value); importNewFile(); }
  function importFileChange(file: File | null) { setImportFile(file); setImportPreview(null); }
  function importFileRequired() { return !importPreview; }
  function importPreviewFileInputDisabled() { return importing || Boolean(importPreview); }
  function importConfirmCancel() { setImportPreview(null); }
  function duplicateDeleteRemaining(group: DuplicateGroup) { void deleteKeeping(group); }
  function duplicateDeleteBulk() { void deleteSelectedDuplicates(); }
  function duplicateToggle(item: DuplicateQuestion, checked: boolean) { toggleDuplicate(item.id, checked); }
  function duplicateRefresh() { void loadDuplicates(); }
  function importSubmit(event: FormEvent<HTMLFormElement>) { void importExcel(event); }
  function importConfirm() { void confirmImport(); }
  function duplicateOpen() { void openDuplicates(); }
  function duplicateClose() { closeDuplicates(); }
  function importClose() { closeImport(); }
  function importOpenDialog() { openImport(); }
  function duplicateBackdropClick(event: MouseEvent<HTMLDivElement>) { preventClose(event); }
  function importBackdropClick(event: MouseEvent<HTMLDivElement>) { importPreventClose(event); }
  function importDialogCloseButton() { closeImport(); }
  function duplicateDialogCloseButton() { closeDuplicates(); }
  function importTypeValue() { return importDefaultType(); }
  function duplicateGroupsPresent() { return duplicateGroups.length > 0; }
  function duplicateButtonText(group: DuplicateGroup) { return duplicateRemoveLabel(group); }
  function importPreviewMessage() { return importPreviewRowsLabel(); }
  function importFileInputChange(event: ChangeEvent<HTMLInputElement>) { importFileChange(event.target.files?.[0] || null); }
  function importTypeInputChange(event: ChangeEvent<HTMLSelectElement>) { importTypeChange(event.target.value); }
  function duplicateRadioChange(group: DuplicateGroup, item: DuplicateQuestion) { keepSelectionChange(group, item.id); }
  function duplicateCheckboxChange(item: DuplicateQuestion, event: ChangeEvent<HTMLInputElement>) { duplicateToggle(item, event.target.checked); }
  function isDuplicateKeeper(group: DuplicateGroup, item: DuplicateQuestion) { return duplicateKeeperFor(group) === item.id; }
  function duplicateKeepButtonClick(group: DuplicateGroup) { duplicateDeleteRemaining(group); }
  function duplicateBatchClick() { duplicateDeleteBulk(); }
  function duplicateSelectWithoutVoiceClick() { selectDeletableDuplicatesWithoutVoice(); }
  function duplicateRefreshClick() { duplicateRefresh(); }
  function importConfirmClick() { importConfirm(); }
  function importPreviewCancelClick() { importConfirmCancel(); }
  function importSubmitButtonText() { return importSubmitText(); }
  function importConfirmButtonText() { return confirmImportText(); }
  function importWarningText() { return "发现重复或空白行，以下内容会自动跳过："; }
  function importCleanText() { return "未发现重复题干，可直接导入。"; }
  function importExistingText() { return `与题库已有题目重复：${importPreview?.duplicateExisting.length || 0} 行`; }
  function importFileText() { return `文件内部重复：${importPreview?.duplicateInFile.length || 0} 行`; }
  function importBlankText() { return `题目内容为空：${importPreview?.blankRows || 0} 行`; }
  function importPreviewDialogTitle() { return "确认导入结果"; }
  function importSubmitHandler(event: FormEvent<HTMLFormElement>) { importSubmit(event); }
  function duplicateKeepText(group: DuplicateGroup) { return duplicateButtonText(group); }
  function duplicateHeaderText(group: DuplicateGroup) { return duplicateCountText(group); }
  function duplicateRowMeta(item: DuplicateQuestion) { return `${duplicateTypeLabel(item)} · ${duplicateSubcategoryLabel(item)} · ${duplicateAssetText(item)}`; }
  function duplicateGroupContent(group: DuplicateGroup) { return duplicateContentLabel(group); }
  function importDescriptionText() { return importDescription(); }
  function importFileNameText() { return importedFileName(); }
  function importShowWarning() { return shouldShowImportWarning(); }
  function importShowClean() { return shouldShowImportClean(); }
  function jump(event: FormEvent) {
    event.preventDefault();
    const target = Math.min(totalPages, Math.max(1, Number(jumpPage) || 1));
    void load(target);
  }

  return (
    <main className="panel-page bank-page">
      <div className="users-heading">
        <div>
          <p className="eyebrow">— QUESTION BANK</p>
          <h1>题库管理</h1>
          <p>维护题目、答案和具体分类，也可以批量导入 Excel。</p>
        </div>
        <div className="bank-actions">
          <button className="secondary-action" onClick={duplicateOpen}>
            重复题处理
          </button>
          <button
            className="secondary-action"
            onClick={importOpenDialog}
          >
            ↑ 导入 Excel
          </button>
          <button className="create-trigger" onClick={openCreate}>
            ＋ 新增题目
          </button>
        </div>
      </div>
      {message && <div className="management-message">{message}</div>}
      <section className="bank-toolbar">
        <select
          value={typeFilter}
          onChange={(event) => setTypeFilter(event.target.value)}
        >
          <option value="">全部题型</option>
          {types.map((type) => (
            <option key={type.id} value={type.id}>
              {type.name}
            </option>
          ))}
        </select>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索题目、答案或具体分类"
        />
        <button onClick={() => void load(1)}>筛选</button>
        <span>共 {total} 道题目</span>
      </section>
      <div className="bulk-toolbar">
        <label>
          <input
            type="checkbox"
            checked={allSelected}
            onChange={(event) => toggleAll(event.target.checked)}
          />{" "}
          全选本页
        </label>
        <span>已选 {selected.length} 道</span>
        <button
          className="danger-text"
          disabled={!selected.length}
          onClick={() => void remove(selected)}
        >
          批量删除
        </button>
      </div>
      <section className="bank-list">
        {questions.length ? (
          questions.map((item) => (
            <article className="bank-item" key={item.id}>
              <div className="bank-item-head">
                <label className="question-check">
                  <input
                    type="checkbox"
                    checked={selected.includes(item.id)}
                    onChange={(event) =>
                      toggleSelected(item.id, event.target.checked)
                    }
                  />
                </label>
                <div>
                  <span className="section-kicker">{item.typeName}</span>
                  <h2>{item.content}</h2>
                </div>
                <div className="bank-item-actions">
                  <button onClick={() => openEdit(item)}>编辑</button>
                  <button
                    className="danger-text"
                    onClick={() => void remove([item.id])}
                  >
                    删除
                  </button>
                </div>
              </div>
              <div className="bank-meta">
                {item.subcategory && (
                  <span className="tag-chip">{item.subcategory}</span>
                )}
                <span className={"question-status status-" + item.status}>
                  {item.status === "active"
                    ? "启用"
                    : item.status === "draft"
                      ? "草稿"
                      : "归档"}
                </span>
                {item.answer ? (
                  <span className="answer-state has-answer">有参考答案</span>
                ) : (
                  <span className="answer-state">暂无参考答案</span>
                )}
              </div>
              {item.answer && <p className="bank-answer">{item.answer}</p>}
            </article>
          ))
        ) : (
          <div className="empty">
            <b>题</b>
            <h3>暂无题目</h3>
            <p>可以新增题目，或导入整理好的 Excel。</p>
          </div>
        )}
      </section>
      <div className="pagination">
        <button disabled={page <= 1} onClick={() => void load(page - 1)}>
          ← 上一页
        </button>
        <span>
          第 {page} / {totalPages} 页
        </span>
        <button
          disabled={page >= totalPages}
          onClick={() => void load(page + 1)}
        >
          下一页 →
        </button>
        <form className="page-jump" onSubmit={jump}>
          <input
            aria-label="跳转页码"
            type="number"
            min="1"
            max={totalPages}
            value={jumpPage}
            onChange={(event) => setJumpPage(event.target.value)}
          />
          <button>跳转</button>
        </form>
      </div>
      {editor && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setEditor(null);
          }}
        >
          <form className="create-modal bank-editor" onSubmit={save}>
            <button
              type="button"
              className="modal-close"
              onClick={() => setEditor(null)}
            >
              ×
            </button>
            <span className="section-kicker">
              {editor.id ? "EDIT QUESTION" : "NEW QUESTION"}
            </span>
            <h2>{editor.id ? "编辑题目" : "新增题目"}</h2>
            <label>
              题目类型
              <select
                value={editor.typeId}
                onChange={(event) =>
                  setEditor({ ...editor, typeId: Number(event.target.value) })
                }
              >
                {types.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              题目内容
              <textarea
                required
                value={editor.content}
                onChange={(event) =>
                  setEditor({ ...editor, content: event.target.value })
                }
              />
            </label>
            <label>
              参考答案（可选）
              <textarea
                value={editor.answer}
                onChange={(event) =>
                  setEditor({ ...editor, answer: event.target.value })
                }
              />
            </label>
            <label>
              具体分类（可选）
              <input
                value={editor.subcategory}
                onChange={(event) =>
                  setEditor({ ...editor, subcategory: event.target.value })
                }
              />
            </label>
            <label>
              状态
              <select
                value={editor.status}
                onChange={(event) =>
                  setEditor({ ...editor, status: event.target.value })
                }
              >
                <option value="active">启用</option>
                <option value="draft">草稿</option>
                <option value="archived">归档</option>
              </select>
            </label>
            <button className="modal-submit">保存题目</button>
          </form>
        </div>
      )}
      {importOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={importBackdropClick}
        >
          <form className="create-modal import-modal" onSubmit={importSubmitHandler}>
            <button
              type="button"
              className="modal-close"
              disabled={importCloseDisabled()}
              onClick={importDialogCloseButton}
            >
              ×
            </button>
            <span className="section-kicker">EXCEL IMPORT</span>
            <h2>{useImportPreview() ? importPreviewDialogTitle() : "导入题库 Excel"}</h2>
            <p>{importDescriptionText()}</p>
            {useImportPreview() && <p className="import-preview-summary">{importPreviewMessage()}</p>}
            <label>
              导入到题型
              <select
                name="typeId"
                value={importTypeValue()}
                disabled={importPreviewFileInputDisabled()}
                onChange={importTypeInputChange}
                required
              >
                {types.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Excel 文件
              <input
                name="file"
                type="file"
                accept=".xlsx,.xls,.csv"
                disabled={importPreviewFileInputDisabled()}
                onChange={importFileInputChange}
                required={importFileRequired()}
              />
            </label>
            {useImportPreview() && (
              <div className="import-preview" role="status">
                <strong>{importShowWarning() ? importWarningText() : importCleanText()}</strong>
                {importShowWarning() && <ul>
                  {!!importPreview?.duplicateExisting.length && <li>{importExistingText()}。{importExistingExample()}</li>}
                  {!!importPreview?.duplicateInFile.length && <li>{importFileText()}。{importFileExample()}</li>}
                  {!!importPreview?.blankRows && <li>{importBlankText()}。</li>}
                </ul>}
                <small>文件：{importFileNameText()}</small>
              </div>
            )}
            {useImportPreview() ? (
              <div className="modal-button-row">
                <button type="button" className="secondary-action" disabled={importing} onClick={importPreviewCancelClick}>返回修改</button>
                <button type="button" className="modal-submit" disabled={!importCanConfirm()} onClick={importConfirmClick}>{importConfirmButtonText()}</button>
              </div>
            ) : <button className="modal-submit" disabled={!importCanPreflight()}>{importSubmitButtonText()}</button>}
          </form>
        </div>
      )}
      {duplicatesOpen && (
        <div className="modal-backdrop" onMouseDown={duplicateBackdropClick}>
          <section className="create-modal duplicate-modal" role="dialog" aria-modal="true" aria-labelledby="duplicate-question-title">
            <button type="button" className="modal-close" aria-label="关闭重复题处理" disabled={duplicateCloseDisabled()} onClick={duplicateDialogCloseButton}>×</button>
            <span className="section-kicker">DEDUPLICATE QUESTIONS</span>
            <h2 id="duplicate-question-title">{duplicateDialogTitle()}</h2>
            <p>按题干内容（忽略首尾及连续空格）分组。先选一条保留，再删除其他重复项；也可跨分组勾选后批量删除。</p>
            <div className="duplicate-modal-actions">
              <button type="button" className="secondary-action" disabled={duplicatesLoading} onClick={duplicateRefreshClick}>重新检查</button>
              <button type="button" className="secondary-action duplicate-smart-select" disabled={duplicatesLoading || !duplicateGroups.length} onClick={duplicateSelectWithoutVoiceClick}>一键选中无配音可删项</button>
              <button type="button" className="danger-action" disabled={isDuplicateBulkDisabled()} onClick={duplicateBatchClick}>{duplicateBulkText()}</button>
            </div>
            <small className="duplicate-selection-hint">会跳过已有题目配音的条目；若一组全部没有配音，会自动保留其中一条。</small>
            <div className="duplicate-groups">
              {!duplicateGroupsPresent() ? <div className="duplicate-empty"><strong>{duplicateEmptyText()}</strong><small>{duplicateEmptyHint()}</small></div> : duplicateGroups.map((group) => (
                <article key={group.key} className="duplicate-group">
                  <header><div><span>{duplicateHeaderText(group)}</span><h3>{duplicateGroupContent(group)}</h3></div><button type="button" className="danger-text" disabled={isDuplicateKeepDisabled(group)} onClick={() => duplicateKeepButtonClick(group)}>{duplicateKeepText(group)}</button></header>
                  <div className="duplicate-question-list">
                    {group.questions.map((item) => <label key={duplicateRowKey(group, item)} className="duplicate-question-row">
                      <input type="checkbox" aria-label={duplicateQuestionSelectionLabel(item)} checked={duplicateRowChecked(item.id)} onChange={(event) => duplicateCheckboxChange(item, event)} />
                      <input type="radio" name={`keeper-${group.key}`} aria-label={duplicateKeeperLabel(item)} checked={isDuplicateKeeper(group, item)} onChange={() => duplicateRadioChange(group, item)} />
                      <span><b>{duplicateIdLabel(item)}</b><small>{duplicateRowMeta(item)}</small></span>
                    </label>)}
                  </div>
                </article>
              ))}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function Login({
  onSubmit,
  message,
}: {
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  message: string;
}) {
  const [registering, setRegistering] = useState(false);
  const [registerMessage, setRegisterMessage] = useState("");
  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setRegisterMessage("");
    try {
      const result = await jsonFetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(data)),
      });
      setRegisterMessage(result.message);
      form.reset();
    } catch (error) {
      setRegisterMessage((error as Error).message);
    }
  }
  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={registering ? register : onSubmit}>
        <b className="login-mark">研</b>
        <small>YANLU INTERVIEW TRAINER</small>
        <h1>{registering ? "申请注册" : "欢迎回来"}</h1>
        <p>
          {registering
            ? "提交后需管理员审核通过才能登录"
            : "登录后开始你的保研面试训练"}
        </p>
        {registering && (
          <label>
            姓名
            <input name="displayName" autoComplete="name" required />
          </label>
        )}
        <label>
          账号
          <input name="username" autoComplete="username" required />
        </label>
        <label>
          密码
          <input
            name="password"
            type="password"
            minLength={registering ? 8 : undefined}
            autoComplete={registering ? "new-password" : "current-password"}
            required
          />
        </label>
        {(registering ? registerMessage : message) && (
          <div
            className={
              registerMessage.includes("已提交") ? "form-success" : "form-error"
            }
          >
            {registering ? registerMessage : message}
          </div>
        )}
        <button type="submit">
          {registering ? "提交注册申请 →" : "登录系统 →"}
        </button>
        <button
          type="button"
          className="login-switch"
          onClick={() => {
            setRegistering(!registering);
            setRegisterMessage("");
          }}
        >
          {registering ? "已有账号？返回登录" : "没有账号？申请注册"}
        </button>
      </form>
    </div>
  );
}

function History({
  records,
  cards,
  autoTranscribe,
  onFilter,
  onNew,
  onContinue,
  onReview,
}: {
  records: RecordItem[];
  cards: HomeCard[];
  autoTranscribe: boolean;
  onFilter: (category?: string, search?: string) => Promise<unknown>;
  onNew: () => void;
  onContinue: (item: RecordItem) => void;
  onReview: (group: RecordGroup) => void;
}) {
  const [category, setCategory] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [jumpPage, setJumpPage] = useState("1");
  const [selectedKey, setSelectedKeyState] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const pageSize = 8;
  const groups: RecordGroup[] = [];
  for (const item of records) {
    const key =
      String(item.userId) + ":" + (item.questionId || "record-" + item.id);
    let group = groups.find((candidate) => candidate.key === key);
    if (!group) {
      group = {
        key,
        userId: item.userId,
        questionId: item.questionId,
        category: item.category,
        question: item.question,
        username: item.username,
        displayName: item.displayName,
        attempts: [],
      };
      groups.push(group);
    }
    group.attempts.push(item);
  }
  const totalPages = Math.max(1, Math.ceil(groups.length / pageSize));
  const visibleGroups = groups.slice((page - 1) * pageSize, page * pageSize);
  const selectedGroup = selectedKey
    ? groups.find((group) => group.key === selectedKey) || null
    : null;
  function setSelectedKey(nextKey: string | null) {
    if (nextKey) {
      const target = groups.find((group) => group.key === nextKey);
      if (target) {
        onReview(target);
        return;
      }
    }
    setSelectedKeyState(nextKey);
  }
  useEffect(() => {
    if (
      !autoTranscribe ||
      !records.some((item) => item.transcriptStatus === "processing")
    )
      return;
    const timer = window.setInterval(() => {
      void onFilter(category, search).catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [autoTranscribe, records, category, search, onFilter]);

  function applyFilter(event: FormEvent) {
    event.preventDefault();
    setPage(1);
    setJumpPage("1");
    void onFilter(category, search);
  }
  function jump(event: FormEvent) {
    event.preventDefault();
    const target = Math.min(totalPages, Math.max(1, Number(jumpPage) || 1));
    setPage(target);
    setJumpPage(String(target));
  }
  async function transcribe(item: RecordItem) {
    setMessage("");
    try {
      await jsonFetch("/api/records/" + item.id + "/transcription", {
        method: "POST",
      });
      setMessage("已开始生成文字稿，请稍候查看。");
      await onFilter(category, search);
    } catch (error) {
      setMessage((error as Error).message);
    }
  }

  return (
    <main className="history-page">
      <div className="history-head">
        <div>
          <p className="eyebrow">— PRACTICE ARCHIVE</p>
          <h1>作答记录</h1>
          <p>相同题目会合并展示，点击记录可查看答案、录音和文字稿。</p>
        </div>
        <button onClick={onNew}>＋ 新的练习</button>
      </div>
      <div className="stats">
        <div>
          <span>题目记录</span>
          <strong>
            {groups.length}
            <small> 题</small>
          </strong>
        </div>
        <div>
          <span>累计作答</span>
          <strong>
            {records.length}
            <small> 次</small>
          </strong>
        </div>
        <div>
          <span>保存录音</span>
          <strong>
            {records.filter((r) => r.hasAudio).length}
            <small> 条</small>
          </strong>
        </div>
      </div>
      <form className="filters" onSubmit={applyFilter}>
        <select
          value={category}
          onChange={(event) => {
            setCategory(event.target.value);
            setPage(1);
          }}
        >
          <option value="">全部类别</option>
          {cards.map((card) => (
            <option key={card.name}>{card.name}</option>
          ))}
        </select>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索题目或作答内容"
        />
        <button>筛选记录</button>
      </form>
      {message && <div className="management-message">{message}</div>}
      <section className="records">
        {visibleGroups.length ? (
          visibleGroups.map((group, index) => {
            const latest = group.attempts[0];
            return (
              <article className="record-group" key={group.key}>
                <b>
                  {String((page - 1) * pageSize + index + 1).padStart(2, "0")}
                </b>
                <div className="record-group-main">
                  <small>
                    {group.username || group.displayName
                      ? "学员：" +
                        learnerLabel(group.displayName, group.username) +
                        " · "
                      : ""}
                    {group.category} · {group.attempts.length} 次作答
                  </small>
                  <h3>{group.question}</h3>
                  <p className="record-latest">
                    {formatRecordDate(latest.createdAt)} ·{" "}
                    {latest.hasAudio ? "含录音" : "无录音"} ·{" "}
                    {latest.referenceAnswer ? "有参考答案" : "暂无参考答案"}
                  </p>
                  <div className="record-group-actions">
                    <button
                      className="record-open"
                      onClick={() => onReview(group)}
                    >
                      查看复盘 <span>→</span>
                    </button>
                    {latest.questionId && latest.typeId && (
                      <button
                        className="record-continue"
                        onClick={() => onContinue(latest)}
                      >
                        继续作答
                      </button>
                    )}
                  </div>
                </div>
              </article>
            );
          })
        ) : (
          <div className="empty">
            <b>复</b>
            <h3>还没有作答记录</h3>
            <p>完成一次练习后，录音、答案和复盘信息会出现在这里。</p>
          </div>
        )}
      </section>
      <div className="pagination">
        <button disabled={page <= 1} onClick={() => setPage(page - 1)}>
          ← 上一页
        </button>
        <span>
          第 {page} / {totalPages} 页
        </span>
        <button disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
          下一页 →
        </button>
        <form className="page-jump" onSubmit={jump}>
          <input
            type="number"
            min="1"
            max={totalPages}
            value={jumpPage}
            onChange={(event) => setJumpPage(event.target.value)}
          />
          <button>跳转</button>
        </form>
      </div>
      {selectedGroup && (
        <div
          className="modal-backdrop record-detail-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSelectedKey(null);
          }}
        >
          <section
            className="record-detail-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="record-detail-title"
          >
            <button
              type="button"
              className="modal-close"
              aria-label="关闭记录详情"
              onClick={() => setSelectedKey(null)}
            >
              ×
            </button>
            <span className="section-kicker">PRACTICE DETAIL</span>
            <small className="record-detail-meta">
              {selectedGroup.username || selectedGroup.displayName
                ? "学员：" +
                  learnerLabel(
                    selectedGroup.displayName,
                    selectedGroup.username,
                  ) +
                  " · "
                : ""}
              {selectedGroup.category} · {selectedGroup.attempts.length} 次作答
            </small>
            <h2 id="record-detail-title">{selectedGroup.question}</h2>
            <div className="record-detail-actions">
              <button
                className="review-trigger"
                onClick={() => {
                  onReview(selectedGroup);
                  setSelectedKey(null);
                }}
              >
                进入 AI 复盘
              </button>
              {selectedGroup.attempts[0].questionId &&
                selectedGroup.attempts[0].typeId && (
                  <button
                    className="modal-submit"
                    onClick={() => {
                      onContinue(selectedGroup.attempts[0]);
                      setSelectedKey(null);
                    }}
                  >
                    继续作答
                  </button>
                )}
            </div>
            <section className="detail-reference">
              {selectedGroup.attempts[0].referenceAnswer ? (
                <>
                  <span className="section-kicker">REFERENCE ANSWER</span>
                  <h3>参考答案</h3>
                  <p>{selectedGroup.attempts[0].referenceAnswer}</p>
                </>
              ) : (
                <>
                  <span className="section-kicker">REFERENCE ANSWER</span>
                  <h3>暂无参考答案</h3>
                  <p>这道题暂时没有配置参考答案。</p>
                </>
              )}
            </section>
            <div className="detail-attempts">
              <h3>每次具体作答</h3>
              {selectedGroup.attempts.map((item, index) => (
                <article className="detail-attempt" key={item.id}>
                  <div className="detail-attempt-head">
                    <strong>
                      第 {selectedGroup.attempts.length - index} 次
                    </strong>
                    <small>{formatRecordDate(item.createdAt)}</small>
                  </div>
                  <p className="detail-answer-label">文字作答</p>
                  <p className="detail-answer">
                    {item.answer || "本次未填写文字作答。"}
                  </p>
                  {item.hasAudio ? (
                    <TranscriptViewer
                      item={item}
                      onTranscribe={() => void transcribe(item)}
                      onRefresh={async () => {
                        await onFilter(category, search);
                      }}
                    />
                  ) : (
                    <p className="no-audio">这次作答没有录音。</p>
                  )}
                </article>
              ))}
            </div>
            <section className="ai-placeholder">
              <span className="section-kicker">AI REVIEW</span>
              <h3>AI 复盘已经独立成页</h3>
              <p>
                点击上方“进入 AI 复盘”，可以生成评估、查看历史比较并继续对话。
              </p>
            </section>
          </section>
        </div>
      )}
    </main>
  );
}
function TranscriptViewer({
  item,
  autoTranscribe = false,
  onTranscribe,
  onRefresh,
}: {
  item: RecordItem;
  autoTranscribe?: boolean;
  onTranscribe: () => void;
  onRefresh?: () => void | Promise<void>;
}) {
  const [mode, setMode] = useState<"full" | "segments">("full");
  const [refreshing, setRefreshing] = useState(false);
  const segments = parseTranscriptSegments(item.transcriptSegments);
  const canShowSegments = segments.length > 0;

  async function refreshStatus() {
    if (!onRefresh || refreshing) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  }

  if (item.transcriptStatus === "completed" && item.transcript) {
    return (
      <div className="detail-audio">
        <audio
          controls
          preload="none"
          src={"/api/records/" + item.id + "/audio"}
        />
        <div className="transcript-box">
          <div className="transcript-toolbar">
            <span className="transcript-state done">录音文字稿</span>
            {canShowSegments && (
              <div className="transcript-toggle">
                <button
                  type="button"
                  className={mode === "full" ? "active" : ""}
                  onClick={() => setMode("full")}
                >
                  完整文字
                </button>
                <button
                  type="button"
                  className={mode === "segments" ? "active" : ""}
                  onClick={() => setMode("segments")}
                >
                  时间分片
                </button>
              </div>
            )}
          </div>
          {mode === "segments" && canShowSegments ? (
            <div className="transcript-segments">
              {segments.map((segment, index) => (
                <p
                  className="transcript-segment"
                  key={segment.startMs + "-" + segment.endMs + "-" + index}
                >
                  <time>
                    {formatTranscriptTime(segment.startMs)} -{" "}
                    {formatTranscriptTime(segment.endMs)}
                  </time>
                  <span>{segment.text}</span>
                </p>
              ))}
            </div>
          ) : (
            <p>{item.transcript}</p>
          )}
        </div>
      </div>
    );
  }
  if (autoTranscribe && item.transcriptStatus === "failed") {
    return (
      <div className={"detail-audio"}>
        <audio
          controls
          preload={"none"}
          src={"/api/records/" + item.id + "/audio"}
        />
        <div className={"transcript-box"}>
          <span className={"transcript-state failed"}>自动转写失败</span>
          <p>
            {item.transcriptError || "自动转写失败，请联系管理员检查百炼配置。"}
          </p>
          <button type="button" onClick={onTranscribe}>
            重新尝试转写
          </button>
        </div>
      </div>
    );
  }
  if (autoTranscribe && item.transcriptStatus !== "processing") {
    return (
      <div className={"detail-audio"}>
        <audio
          controls
          preload={"none"}
          src={"/api/records/" + item.id + "/audio"}
        />
        <div className={"transcript-box"}>
          <span className={"transcript-state pending"}>自动转写已开启</span>
          <p>录音保存后会自动生成文字稿，请稍候查看。</p>
        </div>
      </div>
    );
  }
  if (item.transcriptStatus === "processing") {
    return (
      <div className="detail-audio">
        <audio
          controls
          preload="none"
          src={"/api/records/" + item.id + "/audio"}
        />
        <div className="transcript-box">
          <span className="transcript-state pending">正在生成文字稿…</span>
          <p>
            文字稿通常需要约 10～60 秒；音频较长时可能需要 1～3
            分钟。页面会每隔几秒自动刷新，若离开页面后回来仍未更新，请点击下方按钮。
          </p>
          {onRefresh && (
            <button
              type="button"
              className="transcript-refresh"
              disabled={refreshing}
              onClick={() => void refreshStatus()}
            >
              {refreshing ? "刷新中…" : "↻ 刷新文字稿状态"}
            </button>
          )}
        </div>
      </div>
    );
  }
  if (item.transcriptStatus === "failed") {
    return (
      <div className="detail-audio">
        <audio
          controls
          preload="none"
          src={"/api/records/" + item.id + "/audio"}
        />
        <div className="transcript-box">
          <span className="transcript-state failed">生成失败</span>
          <p>{item.transcriptError || "转写失败，请重试。"}</p>
          <button type="button" onClick={onTranscribe}>
            重新生成文字稿
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="detail-audio">
      <audio
        controls
        preload="none"
        src={"/api/records/" + item.id + "/audio"}
      />
      <div className="transcript-box">
        <button type="button" onClick={onTranscribe}>
          生成录音文字稿
        </button>
      </div>
    </div>
  );
}
function Settings({
  autoRecord,
  avoidRepeated,
  readQuestion,
  onChange,
}: {
  autoRecord: boolean;
  avoidRepeated: boolean;
  readQuestion: boolean;
  onChange: (
    value: boolean,
    avoidRepeated: boolean,
    readQuestion: boolean,
  ) => void;
}) {
  const [saved, setSaved] = useState("");
  const [guideOpen, setGuideOpen] = useState(false);
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);
  const [browserHint, setBrowserHint] = useState<BrowserKey | null>(
    null,
  );
  const [copiedBrowserUrl, setCopiedBrowserUrl] = useState(false);
  const [voicePreviews, setVoicePreviews] = useState<Array<{ id: number; name: string; provider: string; model: string; audioUrl: string }>>([]);
  const [voicePreviewLoading, setVoicePreviewLoading] = useState(true);
  const browserUrls = {
    chrome: "chrome://flags/#unsafely-treat-insecure-origin-as-secure",
    edge: "edge://flags/#unsafely-treat-insecure-origin-as-secure",
    browser360: "se://flags/#unsafely-treat-insecure-origin-as-secure",
    browser360speed: "chrome://flags/#unsafely-treat-insecure-origin-as-secure",
    lenovo: "slbrowser://flags/#unsafely-treat-insecure-origin-as-secure",
    quark: "quark://flags/#unsafely-treat-insecure-origin-as-secure",
    opera: "opera://flags/#unsafely-treat-insecure-origin-as-secure",
    qq: "qqbrowser://flags/#unsafely-treat-insecure-origin-as-secure",
    sogou: "sogou://flags/#unsafely-treat-insecure-origin-as-secure",
    brave: "brave://flags/#unsafely-treat-insecure-origin-as-secure",
    centbrowser: "centbrowser://flags/#unsafely-treat-insecure-origin-as-secure",
  } as const;
  const browserOptions: Array<{ key: BrowserKey; label: string; note?: string }> = [
    { key: "edge", label: "Microsoft Edge" },
    { key: "chrome", label: "Google Chrome" },
    { key: "browser360", label: "360 安全浏览器", note: "仅极速 / Chromium 内核" },
    { key: "browser360speed", label: "360 极速浏览器 X" },
    { key: "lenovo", label: "联想浏览器" },
    { key: "quark", label: "夸克 PC" },
    { key: "opera", label: "Opera 欧朋" },
    { key: "qq", label: "QQ 浏览器 PC" },
    { key: "sogou", label: "搜狗浏览器", note: "仅极速模式" },
    { key: "brave", label: "Brave" },
    { key: "centbrowser", label: "百分浏览器" },
  ];

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);
  useEffect(() => {
    jsonFetch("/api/settings")
      .then((data) => {
        setVoicePreviews(data.voicePreviews || []);
      })
      .catch(() => undefined)
      .finally(() => setVoicePreviewLoading(false));
  }, []);
  useEffect(() => {
    if (!guideOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setGuideOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [guideOpen]);

  async function update(
    nextAutoRecord: boolean,
    nextAvoidRepeated: boolean,
    nextReadQuestion: boolean,
  ) {
    await jsonFetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        autoRecord: nextAutoRecord,
        avoidRepeated: nextAvoidRepeated,
        readQuestion: nextReadQuestion,
      }),
    });
    onChange(nextAutoRecord, nextAvoidRepeated, nextReadQuestion);
    setSaved("设置已保存");
  }
  async function copyOrigin() {
    if (!origin) return;
    try {
      await navigator.clipboard.writeText(origin);
    } catch {
      const input = document.createElement("textarea");
      input.value = origin;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      input.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2200);
  }
  async function copyBrowserSettingsUrl() {
    if (!browserHint) return;
    const url = browserUrls[browserHint];
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const input = document.createElement("textarea");
      input.value = url;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      input.remove();
    }
    setCopiedBrowserUrl(true);
    window.setTimeout(() => setCopiedBrowserUrl(false), 2200);
  }
  function openBrowserSettings(browser: BrowserKey) {
    const url = browserUrls[browser];
    setBrowserHint(browser);
    setCopiedBrowserUrl(false);
    // This must run directly in the click handler; browsers may still block
    // chrome:// and edge:// navigation, so a visible manual fallback is shown.
    window.open(url, "_blank", "noopener,noreferrer");
  }

  return (
    <main className="panel-page">
      <p className="eyebrow">— PERSONAL SETTINGS</p>
      <h1>系统设置</h1>
      <section className="setting-card">
        <div>
          <h2>题目显示后自动录音</h2>
          <p>开启后，3 秒准备倒计时结束时自动请求麦克风并开始录制。</p>
        </div>
        <button
          className={`switch ${autoRecord ? "on" : ""}`}
          onClick={() => void update(!autoRecord, avoidRepeated, readQuestion)}
          aria-label="切换自动录音"
        >
          <i />
        </button>
      </section>
      <section className="setting-card">
        <div>
          <h2>抽题时避开已练习题目</h2>
          <p>开启后，系统会优先抽取你还没有练习过的题目。</p>
        </div>
        <button
          className={avoidRepeated ? "switch on" : "switch"}
          onClick={() => void update(autoRecord, !avoidRepeated, readQuestion)}
          aria-label="切换重复题目设置"
        >
          <i />
        </button>
      </section>
      <section className="setting-card read-question-setting">
        <div>
          <h2>题目显示后朗读</h2>
          <p>
            开启后，3 秒倒计时结束时朗读当前题目，朗读结束后再开始自动录音。系统会从下方已配置的音色中随机选择；未匹配时使用浏览器语音。
          </p>
        </div>
        <button
          className={readQuestion ? "switch on" : "switch"}
          onClick={() => void update(autoRecord, avoidRepeated, !readQuestion)}
          aria-label="切换题目朗读"
        >
          <i />
        </button>
        <div className="settings-voice-library">
          <strong>当前可用朗读音色</strong>
          <p>目前系统为各个题目配备有以下音色，开启朗读功能后会随机选择。后续可能适配更多音色，并开发朗读音色偏好等功能。</p>
          {voicePreviewLoading ? <small>正在加载试听音色…</small> : voicePreviews.length === 0 ? <small>管理员暂未配置试听音色。</small> : <div className="settings-voice-list">{voicePreviews.map((voice) => <div className="settings-voice-item" key={voice.id}><span>{voice.name}<small>{voice.provider === "baidu" ? "百度" : "百炼"}{voice.model ? ` · ${voice.model}` : ""}</small></span><audio controls preload="none" src={voice.audioUrl} /></div>)}</div>}
        </div>
      </section>
      {saved && <p className="saved">✓ {saved}</p>}
      <section className="permission-card">
        <div>
          <span className="section-kicker">BROWSER PERMISSION</span>
          <h2>HTTP 环境录音权限</h2>
          <p>
            当前使用 IP + HTTP 时，浏览器默认不会开放麦克风。打开配置指引后，可复制当前网址并进入对应浏览器的实验设置。
          </p>
        </div>
        <button
          className="permission-guide-trigger"
          onClick={() => setGuideOpen(true)}
        >
          查看配置指引 <span>→</span>
        </button>
      </section>
      <div className="security-note">
        <b>数据存储说明</b>
        <p>账号、题库、设置、作答记录和录音都保存在服务器 MySQL 数据库中。</p>
      </div>
      {guideOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setGuideOpen(false);
          }}
        >
          <div
            className="permission-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="permission-guide-title"
          >
            <button
              type="button"
              className="modal-close"
              aria-label="关闭录音权限指引"
              onClick={() => setGuideOpen(false)}
            >
              ×
            </button>
            <span className="section-kicker">MICROPHONE ACCESS</span>
            <h2 id="permission-guide-title">开启 HTTP 录音权限</h2>
            <p className="permission-intro">
              这是仅用于电脑端 HTTP 调试的临时方案：网页不能直接修改浏览器实验性开关，但可以帮你准备好要加入白名单的地址。
            </p>
            <ol className="permission-steps">
              <li>
                <b>01</b>
                <div>
                  <strong>复制当前网址</strong>
                  <small>将下面的地址加入浏览器的安全来源列表。</small>
                </div>
              </li>
              <li>
                <b>02</b>
                <div>
                  <strong>打开浏览器实验设置</strong>
                  <small>
                    在下方选择正在使用的浏览器，或在地址栏输入对应完整 flags 地址并搜索{" "}
                    <code>unsafely-treat-insecure-origin-as-secure</code>。
                  </small>
                </div>
              </li>
              <li>
                <b>03</b>
                <div>
                  <strong>启用并重启浏览器</strong>
                  <small>
                    把地址粘贴到白名单后，将开关设为 Enabled，再重启浏览器。
                  </small>
                </div>
              </li>
            </ol>
            <div className="permission-origin">
              <code>{origin || "正在读取当前网址…"}</code>
              <button
                type="button"
                onClick={() => void copyOrigin()}
                disabled={!origin}
              >
                {copied ? "已复制" : "复制地址"}
              </button>
            </div>
            <div className="permission-links" aria-label="浏览器实验设置快捷入口">
              {browserOptions.map((browser) => (
                <button
                  type="button"
                  key={browser.key}
                  onClick={() => openBrowserSettings(browser.key)}
                  title={browserUrls[browser.key]}
                >
                  <span>{browser.label}</span>
                  {browser.note && <small>{browser.note}</small>}
                </button>
              ))}
            </div>
            <div className="permission-mobile-note">
              <strong>手机 / 平板请使用 HTTPS</strong>
              <p>
                手机浏览器通常没有这个 flags 开关，HTTP + IP 无法可靠申请麦克风；请使用 HTTPS。自动朗读、倒计时和开始录音提示音还会受系统自动播放策略限制，视觉倒计时与录音功能不受影响。
              </p>
            </div>
            {browserHint && (
              <div className="browser-settings-fallback" role="status">
                <strong>若没有自动打开，请在地址栏直接访问：</strong>
                <code>{browserUrls[browserHint]}</code>
                <button
                  type="button"
                  onClick={() => void copyBrowserSettingsUrl()}
                >
                  {copiedBrowserUrl ? "已复制" : "复制设置地址"}
                </button>
              </div>
            )}
            <p className="permission-warning">
              提示：360 安全浏览器、搜狗浏览器请切换到极速 / Chromium 内核；兼容模式无效。QQ 浏览器手机版不支持该 flag。正式上线和所有手机访问请使用 HTTPS。
            </p>
          </div>
        </div>
      )}
    </main>
  );
}

function Users() {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [message, setMessage] = useState("");
  const [page, setPage] = useState(1);
  const [jumpPage, setJumpPage] = useState("1");
  const [total, setTotal] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ManagedUser | null>(null);
  const [deleteRecords, setDeleteRecords] = useState(false);
  const pageSize = 8;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const load = useCallback(async (targetPage = 1) => {
    const data = await jsonFetch(
      `/api/users?page=${targetPage}&pageSize=${pageSize}`,
    );
    setUsers(data.users);
    setTotal(data.total);
    setPage(data.page);
    setJumpPage(String(data.page));
  }, []);
  useEffect(() => {
    void load(1);
  }, [load]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      await jsonFetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(data)),
      });
      form.reset();
      setCreateOpen(false);
      setMessage("用户创建成功");
      await load(1);
    } catch (error) {
      setMessage((error as Error).message);
    }
  }
  async function review(userId: number, action: "approve" | "reject") {
    try {
      await jsonFetch("/api/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, action }),
      });
      setMessage(action === "approve" ? "申请已通过" : "申请已拒绝");
      await load(page);
    } catch (error) {
      setMessage((error as Error).message);
    }
  }
  async function remove() {
    if (!pendingDelete) return;
    try {
      await jsonFetch("/api/users", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: pendingDelete.id, deleteRecords }),
      });
      setMessage(
        deleteRecords ? "用户及其记录已删除" : "用户已删除，作答记录已保留",
      );
      setPendingDelete(null);
      setDeleteRecords(false);
      await load(page);
    } catch (error) {
      setMessage((error as Error).message);
    }
  }
  function jump(event: FormEvent) {
    event.preventDefault();
    const target = Math.min(totalPages, Math.max(1, Number(jumpPage) || 1));
    void load(target);
  }
  const pending = users.filter((item) => item.status === "pending");
  return (
    <main className="panel-page">
      <div className="users-heading">
        <div>
          <p className="eyebrow">— USER MANAGEMENT</p>
          <h1>用户管理</h1>
          <p>管理账号、审核注册申请，并维护用户权限。</p>
        </div>
        <button className="create-trigger" onClick={() => setCreateOpen(true)}>
          ＋ 创建用户
        </button>
      </div>
      {message && <div className="management-message">{message}</div>}
      <section className="approval-list">
        <div className="section-heading">
          <div>
            <span className="section-kicker">PENDING REVIEW</span>
            <h2>注册申请</h2>
          </div>
          <em>
            {pending.length
              ? `${pending.length} 条待处理`
              : "当前没有待处理申请"}
          </em>
        </div>
        <div className="approval-cards">
          {pending.length ? (
            pending.map((item) => (
              <article key={item.id}>
                <div className="approval-avatar">
                  {item.displayName.slice(0, 1)}
                </div>
                <div className="approval-info">
                  <strong>{item.displayName}</strong>
                  <span>@{item.username}</span>
                  <small>申请成为普通用户</small>
                </div>
                <div className="approval-actions">
                  <button onClick={() => void review(item.id, "reject")}>
                    拒绝
                  </button>
                  <button onClick={() => void review(item.id, "approve")}>
                    通过申请
                  </button>
                </div>
              </article>
            ))
          ) : (
            <div className="approval-empty">
              <span>✓</span>
              <div>
                <strong>暂无待审核申请</strong>
                <small>新用户注册后会出现在这里。</small>
              </div>
            </div>
          )}
        </div>
      </section>
      <section className="user-list">
        <div className="section-heading">
          <div>
            <span className="section-kicker">ACCOUNT DIRECTORY</span>
            <h2>已有用户</h2>
          </div>
          <em>共 {total} 个账号</em>
        </div>
        <div className="user-table">
          <div className="user-table-head">
            <span>用户</span>
            <span>登录账号</span>
            <span>角色</span>
            <span>状态</span>
            <span>操作</span>
          </div>
          {users.map((item) => (
            <article className="user-row" key={item.id}>
              <div className="user-name">
                <span className="user-avatar">
                  {item.displayName.slice(0, 1)}
                </span>
                <strong>{item.displayName}</strong>
              </div>
              <span className="user-username">@{item.username}</span>
              <span>{item.role === "admin" ? "管理员" : "普通用户"}</span>
              <small className={`status-${item.status}`}>
                {item.status === "active"
                  ? "正常"
                  : item.status === "pending"
                    ? "待审核"
                    : "已拒绝"}
              </small>
              <div className="user-actions">
                {item.role !== "admin" && (
                  <button
                    className="delete-user"
                    onClick={() => {
                      setPendingDelete(item);
                      setDeleteRecords(false);
                    }}
                  >
                    删除
                  </button>
                )}
              </div>
              {pendingDelete?.id === item.id && (
                <div className="delete-modal">
                  <strong>确定删除 {item.username}？</strong>
                  <label>
                    <input
                      type="checkbox"
                      checked={deleteRecords}
                      onChange={(event) =>
                        setDeleteRecords(event.target.checked)
                      }
                    />{" "}
                    同时删除该用户的作答记录和录音
                  </label>
                  <div>
                    <button
                      onClick={() => {
                        setPendingDelete(null);
                        setDeleteRecords(false);
                      }}
                    >
                      取消
                    </button>
                    <button className="danger" onClick={() => void remove()}>
                      确定删除
                    </button>
                  </div>
                </div>
              )}
            </article>
          ))}
        </div>
        <div className="pagination">
          <button disabled={page <= 1} onClick={() => void load(page - 1)}>
            ← 上一页
          </button>
          <span>
            第 {page} / {totalPages} 页
          </span>
          <button
            disabled={page >= totalPages}
            onClick={() => void load(page + 1)}
          >
            下一页 →
          </button>
          <form className="page-jump" onSubmit={jump}>
            <input
              aria-label="跳转页码"
              type="number"
              min="1"
              max={totalPages}
              value={jumpPage}
              onChange={(event) => setJumpPage(event.target.value)}
            />
            <button>跳转</button>
          </form>
        </div>
      </section>
      {createOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setCreateOpen(false);
          }}
        >
          <form
            className="create-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-user-title"
            onSubmit={create}
          >
            <button
              type="button"
              className="modal-close"
              aria-label="关闭创建用户弹窗"
              onClick={() => setCreateOpen(false)}
            >
              ×
            </button>
            <span className="section-kicker">NEW ACCOUNT</span>
            <h2 id="create-user-title">创建用户</h2>
            <p>管理员创建的账号会立即生效。</p>
            <label>
              登录账号
              <input name="username" autoComplete="username" required />
            </label>
            <label>
              显示姓名
              <input name="displayName" autoComplete="name" required />
            </label>
            <label>
              初始密码
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
              />
            </label>
            <label>
              角色
              <select name="role">
                <option value="student">普通用户</option>
                <option value="admin">管理员</option>
              </select>
            </label>
            <button className="modal-submit">创建用户</button>
          </form>
        </div>
      )}
    </main>
  );
}

type AiEvaluation = {
  id: number;
  status: string;
  result: string | null;
  error: string | null;
  createdAt: string;
  completedAt?: string | null;
};
type AiMessage = {
  id: number;
  role: "user" | "assistant";
  content: string;
  evaluationId?: number | null;
  createdAt?: string;
};

function ReviewPage({
  group,
  autoTranscribe,
  onRefreshRecords,
  onBack,
}: {
  group: RecordGroup;
  autoTranscribe: boolean;
  onRefreshRecords: () => Promise<void>;
  onBack: () => void;
}) {
  const [evaluations, setEvaluations] = useState<AiEvaluation[]>([]);
  const [expandedEvaluationIds, setExpandedEvaluationIds] = useState<
    number[] | null
  >(null);
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [message, setMessage] = useState("");
  const questionId = group.questionId;
  const latest = group.attempts[0];
  const load = useCallback(async () => {
    if (!questionId) return;
    try {
      const data = await jsonFetch(
        "/api/ai/evaluations?questionId=" +
          questionId +
          "&userId=" +
          group.userId,
      );
      setEvaluations(data.evaluations || []);
      setMessages(data.messages || []);
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [questionId, group.userId]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const hasProcessingEvaluation = evaluations.some(
      (item) => item.status === "processing",
    );
    const hasProcessingTranscript = group.attempts.some(
      (item) => item.transcriptStatus === "processing",
    );
    if (!hasProcessingEvaluation && !hasProcessingTranscript) return;
    const timer = window.setInterval(() => {
      if (hasProcessingEvaluation) void load();
      if (hasProcessingTranscript)
        void onRefreshRecords().catch(() => undefined);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [evaluations, group.attempts, load, onRefreshRecords]);

  async function generate() {
    if (!questionId || generating) return;
    setGenerating(true);
    setMessage("");
    try {
      const data = await jsonFetch("/api/ai/evaluations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId, userId: group.userId }),
      });
      setMessage(
        data.reused
          ? "最近一次作答已经评估过，没有新的回答可生成。"
          : "评估已提交，正在生成，请稍候。",
      );
      await load();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setGenerating(false);
    }
  }
  async function sendChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = chatInput.trim();
    if (!content || !questionId || chatLoading) return;
    setChatLoading(true);
    setMessage("");
    const clientId = -Date.now();
    setMessages((current) => [
      ...current,
      { id: clientId - 1, role: "user", content },
      { id: clientId, role: "assistant", content: "" },
    ]);
    setChatInput("");
    try {
      const response = await fetch("/api/ai/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          questionId,
          userId: group.userId,
          message: content,
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "发送失败");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("浏览器不支持流式响应");
      const decoder = new TextDecoder();
      let buffer = "";
      const applyEvent = (raw: string) => {
        const line = raw
          .split(/\r?\n/)
          .find((item) => item.startsWith("data:"));
        if (!line) return;
        try {
          const payload = JSON.parse(line.slice(5).trim()) as {
            type?: string;
            content?: string;
            error?: string;
          };
          if (payload.type === "delta" && payload.content)
            setMessages((current) =>
              current.map((item) =>
                item.id === clientId
                  ? { ...item, content: item.content + payload.content }
                  : item,
              ),
            );
          if (payload.type === "error")
            throw new Error(payload.error || "对话生成失败");
        } catch (error) {
          if (error instanceof Error) throw error;
        }
      };
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() || "";
        events.forEach(applyEvent);
      }
      if (buffer.trim()) applyEvent(buffer);
      await load();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setChatLoading(false);
    }
  }
  async function transcribeAttempt(item: RecordItem) {
    try {
      await jsonFetch("/api/records/" + item.id + "/transcription", {
        method: "POST",
      });
      setMessage("已开始生成文字稿，请稍候。");
      await Promise.all([load(), onRefreshRecords()]);
    } catch (error) {
      setMessage((error as Error).message);
    }
  }

  const completed = evaluations.find((item) => item.status === "completed");
  return (
    <main className="review-page">
      <header className="review-hero review-toolbar">
        <button
          className="review-back"
          onClick={onBack}
          aria-label="返回作答记录"
        >
          返回作答记录
        </button>
        <div className="review-toolbar-title">
          <span className="section-kicker">QUESTION REVIEW</span>
          <h1>问题复盘</h1>
        </div>
        <div className="review-toolbar-actions">
          <button
            className="review-chat-open"
            onClick={() => setChatOpen(true)}
          >
            和小鱼讨论
          </button>
          <button
            className="review-generate"
            disabled={!questionId || generating}
            onClick={() => void generate()}
          >
            {generating ? "正在提交…" : completed ? "更新评估" : "生成评估"}
          </button>
        </div>
      </header>
      {message && <div className="management-message">{message}</div>}
      {!questionId ? (
        <div className="empty">
          <h3>原题目已经不存在</h3>
          <p>这条记录缺少题目编号，暂时无法建立独立的 AI 对话。</p>
        </div>
      ) : (
        <div className="review-grid">
          <section className="review-main">
            <div className="review-question-card">
              <span className="section-kicker">INTERVIEW QUESTION</span>
              <h2>{group.question}</h2>
              <div className="review-question-meta">
                <span>{group.category}</span>
                <span>{group.attempts.length} 次作答</span>
                <span>
                  {latest.hasReferenceAnswer ? "有参考答案" : "暂无参考答案"}
                </span>
              </div>
            </div>
            <section className="review-section">
              <div className="review-section-title">
                <div>
                  <span className="section-kicker">RECENT ATTEMPTS</span>
                  <h2>最近的回答</h2>
                </div>
                <small>按时间倒序，最多取 3 次</small>
              </div>
              {group.attempts.slice(0, 3).map((item, index) => {
                return (
                  <article className="review-attempt" key={item.id}>
                    <div className="review-attempt-head">
                      <strong>第 {group.attempts.length - index} 次</strong>
                      <small>{formatRecordDate(item.createdAt)}</small>
                    </div>
                    <p className="review-answer">
                      {item.answer || "本次没有填写文字作答。"}
                    </p>
                    {item.hasAudio && (
                      <TranscriptViewer
                        item={item}
                        autoTranscribe={autoTranscribe}
                        onTranscribe={() => void transcribeAttempt(item)}
                        onRefresh={onRefreshRecords}
                      />
                    )}
                  </article>
                );
              })}
            </section>
          </section>
          <section className="review-evaluations review-section">
            <div className="review-section-title">
              <div>
                <span className="section-kicker">EVALUATIONS</span>
                <h2>评估结果</h2>
              </div>
              <small>
                {loading ? "正在读取…" : evaluations.length + " 次评估"}
              </small>
            </div>
            {evaluations.length ? (
              evaluations.map((item, index) => (
                <details
                  className="evaluation-card"
                  key={item.id}
                  open={
                    expandedEvaluationIds
                      ? expandedEvaluationIds.includes(item.id)
                      : index === 0
                  }
                  onToggle={(event) => {
                    const isOpen = event.currentTarget.open;
                    setExpandedEvaluationIds((current) => {
                      const next = new Set(
                        current ??
                          evaluations
                            .filter((_value, position) => position === 0)
                            .map((value) => value.id),
                      );
                      if (isOpen) next.add(item.id);
                      else next.delete(item.id);
                      return [...next];
                    });
                  }}
                >
                  <summary>
                    <span>
                      <strong>
                        {index === 0
                          ? "最新评估"
                          : "历史评估 " + (evaluations.length - index)}
                      </strong>
                      <small>{formatRecordDate(item.createdAt)}</small>
                    </span>
                    <em>
                      {item.status === "processing"
                        ? "生成中"
                        : item.status === "completed"
                          ? "已完成"
                          : "失败"}
                    </em>
                  </summary>
                  {item.status === "processing" && (
                    <p className="evaluation-pending">
                      AI 正在分析最近的回答，请稍候，页面会自动刷新。
                    </p>
                  )}
                  {item.status === "failed" && (
                    <p className="evaluation-error">
                      {item.error || "本次评估失败。"}
                    </p>
                  )}
                  {item.status === "completed" && (
                    <MarkdownContent
                      value={item.result || ""}
                      className="evaluation-result"
                    />
                  )}
                </details>
              ))
            ) : (
              <div className="review-empty">
                还没有评估。生成评估后，这里会保留每一次可展开查看的反馈。
              </div>
            )}
          </section>
        </div>
      )}
      {chatOpen && (
        <div
          className="chat-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !chatLoading)
              setChatOpen(false);
          }}
        >
          <section
            className="chat-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="chat-modal-title"
          >
            <div className="chat-modal-head">
              <div>
                <span className="section-kicker">QUESTION DISCUSSION</span>
                <h2 id="chat-modal-title">和小鱼讨论</h2>
                <p>围绕这道题追问、打磨表达或模拟追问。</p>
              </div>
              <button
                className="chat-modal-close"
                aria-label="关闭对话"
                disabled={chatLoading}
                onClick={() => setChatOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="chat-messages">
              {messages.length ? (
                messages.map((item) => (
                  <div className={"chat-message " + item.role} key={item.id}>
                    <MarkdownContent
                      value={item.content || (chatLoading ? "正在思考…" : "")}
                    />
                  </div>
                ))
              ) : (
                <div className="chat-empty">
                  还没有对话。试着让小鱼把你的回答打磨得更清晰、有说服力。
                </div>
              )}
            </div>
            <form className="chat-form" onSubmit={sendChat}>
              <textarea
                value={chatInput}
                onChange={(event) => setChatInput(event.target.value)}
                placeholder="例如：请把我的回答改成 90 秒的结构化版本。"
                disabled={chatLoading}
              />
              <button disabled={chatLoading || !chatInput.trim()}>
                {chatLoading ? "生成中…" : "发送"}
              </button>
            </form>
          </section>
        </div>
      )}
    </main>
  );
}

type ApiUsageItem = {
  inputTokens: number;
  outputTokens: number;
  audioSeconds: number;
  requestCount: number;
};
type ApiUsageUser = {
  id: number;
  username: string;
  displayName: string;
  aiEnabled: boolean;
  asrEnabled: boolean;
  realtimeAsrEnabled: boolean;
  aiTokenLimit: number;
  asrRequestLimit: number;
  realtimeSecondsLimit: number;
  usage: Record<string, ApiUsageItem>;
};
type ApiUsageDay = {
  label: string;
  aiTokens: number;
  asrRequests: number;
  realtimeSeconds: number;
};

function UsageLineChart({ days }: { days: ApiUsageDay[] }) {
  const max = Math.max(1, ...days.map((item) => item.aiTokens));
  const width = 520;
  const height = 210;
  const pad = 26;
  const points = days
    .map(
      (item, index) =>
        `${pad + index * ((width - pad * 2) / Math.max(1, days.length - 1))},${height - pad - (item.aiTokens / max) * (height - pad * 2)}`,
    )
    .join(" ");
  return (
    <figure className="usage-chart-card">
      <figcaption>
        <span>大模型 Tokens</span>
        <strong>
          {days
            .reduce((total, item) => total + item.aiTokens, 0)
            .toLocaleString()}
        </strong>
        <small>最近 7 天 · 含对话、评估与追问</small>
      </figcaption>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="最近七天大模型 token 用量折线图"
      >
        <line x1={pad} x2={width - pad} y1={pad} y2={pad} />
        <line x1={pad} x2={width - pad} y1={height / 2} y2={height / 2} />
        <line x1={pad} x2={width - pad} y1={height - pad} y2={height - pad} />
        <polyline
          className="usage-line-fill"
          points={`${pad},${height - pad} ${points} ${width - pad},${height - pad}`}
        />
        <polyline className="usage-line" points={points} />
        {days.map((item, index) => {
          const x =
            pad + index * ((width - pad * 2) / Math.max(1, days.length - 1));
          const y = height - pad - (item.aiTokens / max) * (height - pad * 2);
          return (
            <g key={item.label}>
              <circle cx={x} cy={y} r="3.5">
                <title>
                  {item.label}：{item.aiTokens.toLocaleString()} token
                </title>
              </circle>
              <text x={x} y={height - 7} textAnchor="middle">
                {item.label}
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

function UsageBarChart({ days }: { days: ApiUsageDay[] }) {
  const max = Math.max(
    1,
    ...days.map((item) => Math.max(item.asrRequests, item.realtimeSeconds)),
  );
  const width = 520;
  const height = 210;
  const pad = 26;
  const group = (width - pad * 2) / Math.max(1, days.length);
  return (
    <figure className="usage-chart-card">
      <figcaption>
        <span>语音 API 用量</span>
        <strong>
          {days.reduce((total, item) => total + item.asrRequests, 0)}{" "}
          <em>次转写</em>
        </strong>
        <small>深色：普通转写任务 · 浅色：实时转写秒数</small>
      </figcaption>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="最近七天语音 API 用量柱状图"
      >
        <line x1={pad} x2={width - pad} y1={pad} y2={pad} />
        <line x1={pad} x2={width - pad} y1={height / 2} y2={height / 2} />
        <line x1={pad} x2={width - pad} y1={height - pad} y2={height - pad} />
        {days.map((item, index) => {
          const x = pad + index * group + group * 0.2;
          const barWidth = group * 0.24;
          const asrHeight = (item.asrRequests / max) * (height - pad * 2);
          const liveHeight = (item.realtimeSeconds / max) * (height - pad * 2);
          return (
            <g key={item.label}>
              <rect
                className="usage-bar-asr"
                x={x}
                y={height - pad - asrHeight}
                width={barWidth}
                height={asrHeight}
                rx="3"
              >
                <title>
                  {item.label}：普通转写 {item.asrRequests} 次
                </title>
              </rect>
              <rect
                className="usage-bar-live"
                x={x + barWidth + 5}
                y={height - pad - liveHeight}
                width={barWidth}
                height={liveHeight}
                rx="3"
              >
                <title>
                  {item.label}：实时转写 {item.realtimeSeconds} 秒
                </title>
              </rect>
              <text x={x + barWidth + 2.5} y={height - 7} textAnchor="middle">
                {item.label}
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

function LegacyUsageManagement() {
  const [users, setUsers] = useState<ApiUsageUser[]>([]);
  const [daily, setDaily] = useState<ApiUsageDay[]>([]);
  const [message, setMessage] = useState("");
  const [savingId, setSavingId] = useState(0);
  const load = useCallback(async () => {
    try {
      const data = await jsonFetch("/api/usage");
      setUsers(data.users || []);
      setDaily(data.daily || []);
    } catch (error) {
      setMessage((error as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const update = (id: number, patch: Partial<ApiUsageUser>) =>
    setUsers((items) =>
      items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  const amount = (
    user: ApiUsageUser,
    feature: "ai" | "asr" | "realtime_asr",
  ) =>
    feature === "ai"
      ? Number(user.usage.ai?.inputTokens || 0) +
        Number(user.usage.ai?.outputTokens || 0)
      : feature === "asr"
        ? Number(user.usage.asr?.requestCount || 0)
        : Number(user.usage.realtime_asr?.audioSeconds || 0);
  const ratio = (used: number, limit: number) =>
    limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const formatSeconds = (value: number) =>
    value >= 60
      ? `${Math.floor(value / 60)} 分 ${value % 60} 秒`
      : `${value} 秒`;
  async function save(user: ApiUsageUser) {
    setSavingId(user.id);
    setMessage("");
    try {
      await jsonFetch("/api/usage", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          aiEnabled: user.aiEnabled,
          asrEnabled: user.asrEnabled,
          realtimeAsrEnabled: user.realtimeAsrEnabled,
          aiTokenLimit: user.aiTokenLimit,
          asrRequestLimit: user.asrRequestLimit,
          realtimeSecondsLimit: user.realtimeSecondsLimit,
        }),
      });
      setMessage(`已保存 ${user.displayName} 的 API 权限与额度`);
      await load();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setSavingId(0);
    }
  }
  return (
    <section className="usage-management">
      <header className="usage-head">
        <div>
          <span className="section-kicker">API USAGE & GUARDRAILS</span>
          <h2>用量与额度</h2>
          <p>
            图表展示最近 7 天的实际消耗；用户额度按自然月控制，填 <b>0</b>{" "}
            表示不限额。
          </p>
        </div>
        <button className="secondary-action" onClick={() => void load()}>
          刷新数据
        </button>
      </header>
      {message && (
        <div className="management-message" role="status">
          {message}
        </div>
      )}
      <div className="usage-charts">
        <UsageLineChart days={daily} />
        <UsageBarChart days={daily} />
      </div>
      <div className="usage-user-list">
        {users.map((user) => {
          const aiUsed = amount(user, "ai");
          const asrUsed = amount(user, "asr");
          const realtimeUsed = amount(user, "realtime_asr");
          return (
            <article className="usage-user-card" key={user.id}>
              <div className="usage-user-heading">
                <div className="usage-avatar">
                  {user.displayName.slice(0, 1)}
                </div>
                <div>
                  <h3>{user.displayName}</h3>
                  <span>@{user.username}</span>
                </div>
                <button
                  className="modal-submit usage-save"
                  disabled={savingId === user.id}
                  onClick={() => void save(user)}
                >
                  {savingId === user.id ? "保存中…" : "保存此用户"}
                </button>
              </div>
              <div className="usage-meters">
                <div className="usage-meter">
                  <div>
                    <strong>大模型</strong>
                    <span>
                      {aiUsed.toLocaleString()} /{" "}
                      {user.aiTokenLimit
                        ? user.aiTokenLimit.toLocaleString()
                        : "不限额"}{" "}
                      token
                    </span>
                  </div>
                  <div className="usage-bar">
                    <i
                      style={{ width: `${ratio(aiUsed, user.aiTokenLimit)}%` }}
                    />
                  </div>
                </div>
                <div className="usage-meter">
                  <div>
                    <strong>录音转写</strong>
                    <span>
                      {asrUsed} / {user.asrRequestLimit || "不限额"} 次
                    </span>
                  </div>
                  <div className="usage-bar amber">
                    <i
                      style={{
                        width: `${ratio(asrUsed, user.asrRequestLimit)}%`,
                      }}
                    />
                  </div>
                </div>
                <div className="usage-meter">
                  <div>
                    <strong>实时转写</strong>
                    <span>
                      {formatSeconds(realtimeUsed)} /{" "}
                      {user.realtimeSecondsLimit
                        ? formatSeconds(user.realtimeSecondsLimit)
                        : "不限额"}
                    </span>
                  </div>
                  <div className="usage-bar violet">
                    <i
                      style={{
                        width: `${ratio(realtimeUsed, user.realtimeSecondsLimit)}%`,
                      }}
                    />
                  </div>
                </div>
              </div>
              <div className="usage-controls">
                <label>
                  <input
                    type="checkbox"
                    checked={user.aiEnabled}
                    onChange={(event) =>
                      update(user.id, { aiEnabled: event.target.checked })
                    }
                  />{" "}
                  启用 AI 对话、评估与追问
                </label>
                <label>
                  每月 token 额度
                  <input
                    type="number"
                    min="0"
                    value={user.aiTokenLimit}
                    onChange={(event) =>
                      update(user.id, {
                        aiTokenLimit: Math.max(
                          0,
                          Number(event.target.value) || 0,
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={user.asrEnabled}
                    onChange={(event) =>
                      update(user.id, { asrEnabled: event.target.checked })
                    }
                  />{" "}
                  启用录音转文字
                </label>
                <label>
                  每月转写任务额度
                  <input
                    type="number"
                    min="0"
                    value={user.asrRequestLimit}
                    onChange={(event) =>
                      update(user.id, {
                        asrRequestLimit: Math.max(
                          0,
                          Number(event.target.value) || 0,
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={user.realtimeAsrEnabled}
                    onChange={(event) =>
                      update(user.id, {
                        realtimeAsrEnabled: event.target.checked,
                      })
                    }
                  />{" "}
                  启用实时转写
                </label>
                <label>
                  每月实时转写秒数
                  <input
                    type="number"
                    min="0"
                    value={user.realtimeSecondsLimit}
                    onChange={(event) =>
                      update(user.id, {
                        realtimeSecondsLimit: Math.max(
                          0,
                          Number(event.target.value) || 0,
                        ),
                      })
                    }
                  />
                </label>
              </div>
            </article>
          );
        })}
      </div>
      {!users.length && <div className="review-empty">暂无可统计用户。</div>}
    </section>
  );
}
function Management() {
  const [tab, setTab] = useState<
    "users" | "questions" | "voice" | "ai" | "simulation" | "usage"
  >("users");
  return (
    <main className="management-hub">
      <header className="management-hub-head">
        <div>
          <p className="eyebrow">— ADMIN CONSOLE</p>
          <h1>管理后台</h1>
          <p>集中管理用户、题库、AI 和真实模拟配置。</p>
        </div>
      </header>
      <nav className="management-tabs">
        <button
          className={tab === "users" ? "active" : ""}
          onClick={() => setTab("users")}
        >
          用户管理<span>注册审批与账号</span>
        </button>
        <button
          className={tab === "questions" ? "active" : ""}
          onClick={() => setTab("questions")}
        >
          题库管理<span>题目与 Excel</span>
        </button>
        <button
          className={tab === "voice" ? "active" : ""}
          onClick={() => setTab("voice")}
        >
          题目语音<span>复刻、生成与试听</span>
        </button>
        <button
          className={tab === "ai" ? "active" : ""}
          onClick={() => setTab("ai")}
        >
          AI 模型管理<span>平台、模型与提示词</span>
        </button>
        <button
          className={tab === "simulation" ? "active" : ""}
          onClick={() => setTab("simulation")}
        >
          真实模拟<span>流程与实时转写</span>
        </button>
        <button
          className={tab === "usage" ? "active" : ""}
          onClick={() => setTab("usage")}
        >
          用量额度<span>API 权限与消耗</span>
        </button>
      </nav>
      <div className="management-hub-content">
        {tab === "users" ? (
          <Users />
        ) : tab === "questions" ? (
          <QuestionBank />
        ) : tab === "voice" ? (
          <QuestionVoiceManagement />
        ) : tab === "ai" ? (
          <AiConfig />
        ) : tab === "simulation" ? (
          <SimulationConfig />
        ) : (
          <UsageManagement />
        )}
      </div>
    </main>
  );
}

function LegacySimulationConfig() {
  const [templates, setTemplates] = useState<SimulationTemplate[]>([]);
  const [selected, setSelected] = useState<SimulationTemplate | null>(null);
  const [realtime, setRealtime] = useState<{
    provider: string;
    websocketUrl: string;
    model: string;
    apiKey?: string;
    apiKeySet?: boolean;
    apiKeyPreview?: string;
  } | null>(null);
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    try {
      const data = await jsonFetch("/api/simulations/config");
      setTemplates(data.templates || []);
      setSelected(
        (current) =>
          (current?.id &&
          data.templates?.some(
            (item: SimulationTemplate) => item.id === current.id,
          )
            ? data.templates.find(
                (item: SimulationTemplate) => item.id === current.id,
              )
            : data.templates?.[0]) || null,
      );
      setRealtime(data.realtimeAsr);
    } catch (error) {
      setMessage((error as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const modules = selected
    ? ((Array.isArray(selected.modules)
        ? selected.modules
        : JSON.parse(selected.modules || "[]")) as SimulationStep[])
    : [];
  function updateModule(index: number, patch: Partial<SimulationStep>) {
    if (!selected) return;
    const next = modules.map((item, position) =>
      position === index ? { ...item, ...patch } : item,
    );
    setSelected({ ...selected, modules: next });
  }
  async function saveTemplate() {
    if (!selected) return;
    try {
      await jsonFetch("/api/simulations/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template: selected }),
      });
      setMessage("模拟流程已保存");
      setSelected(null);
      await load();
    } catch (error) {
      setMessage((error as Error).message);
    }
  }
  async function saveRealtime() {
    if (!realtime) return;
    try {
      await jsonFetch("/api/simulations/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ realtimeAsr: realtime }),
      });
      setMessage("实时语音识别配置已保存");
      await load();
    } catch (error) {
      setMessage((error as Error).message);
    }
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
          prompt: "请进行中文自我介绍。",
        },
      ],
      followupPrompt: "",
      isActive: true,
    });
  }
  return (
    <section className="simulation-config">
      <header>
        <span className="section-kicker">SIMULATION BUILDER</span>
        <h2>真实场景模拟</h2>
        <p>
          每张卡片代表一个拼图模块：可设置题型、抽题数量、单题建议时长与是否进入老师追问。
        </p>
      </header>
      {message && <div className="management-message">{message}</div>}
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
              ＋ 新增学校流程
            </button>
          </div>
          {selected && (
            <>
              <label>
                流程名称
                <input
                  value={selected.name}
                  onChange={(event) =>
                    setSelected({ ...selected, name: event.target.value })
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
                    setSelected({
                      ...selected,
                      totalSeconds: Number(event.target.value) || 60,
                    })
                  }
                />
              </label>
              <label>
                老师追问提示词
                <textarea
                  value={selected.followupPrompt || ""}
                  onChange={(event) =>
                    setSelected({
                      ...selected,
                      followupPrompt: event.target.value,
                    })
                  }
                  placeholder="用于生成本流程中老师追问的问题"
                />
              </label>
              <div className="module-puzzle-list">
                {modules.map((item, index) => (
                  <article key={item.id}>
                    <b>{String(index + 1).padStart(2, "0")}</b>
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
                      类型
                      <select
                        value={item.kind}
                        onChange={(event) =>
                          updateModule(index, {
                            kind: event.target.value as "intro" | "question",
                          })
                        }
                      >
                        <option value="intro">自我介绍 / 固定题</option>
                        <option value="question">从题库抽题</option>
                      </select>
                    </label>
                    {item.kind === "question" && (
                      <label>
                        题型编码
                        <input
                          value={item.typeCode || ""}
                          onChange={(event) =>
                            updateModule(index, {
                              typeCode: event.target.value,
                            })
                          }
                          placeholder="professional / english / comprehensive"
                        />
                      </label>
                    )}
                    <label>
                      抽题数
                      <input
                        type="number"
                        min="1"
                        value={item.count || 1}
                        onChange={(event) =>
                          updateModule(index, {
                            count: Number(event.target.value) || 1,
                          })
                        }
                      />
                    </label>
                    <label>
                      建议时长（秒）
                      <input
                        type="number"
                        min="30"
                        value={item.timeSeconds || 120}
                        onChange={(event) =>
                          updateModule(index, {
                            timeSeconds: Number(event.target.value) || 30,
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
                          })
                        }
                      />{" "}
                      本题后进入老师追问
                    </label>
                  </article>
                ))}
              </div>
              <button
                className="create-trigger"
                onClick={() =>
                  setSelected({
                    ...selected,
                    modules: [
                      ...modules,
                      {
                        id: "module-" + Date.now(),
                        title: "新模块",
                        kind: "question",
                        typeCode: "professional",
                        count: 1,
                        timeSeconds: 120,
                        allowFollowup: false,
                      },
                    ],
                  })
                }
              >
                ＋ 添加模块
              </button>
              <button
                className="modal-submit"
                onClick={() => void saveTemplate()}
              >
                保存模拟流程
              </button>
            </>
          )}
        </section>
        <section className="realtime-asr-card">
          <span className="section-kicker">REALTIME ASR</span>
          <h3>实时语音识别 API</h3>
          <p>
            仅用于真实模拟流程；普通练习继续使用原有的 Paraformer 转写配置。
          </p>
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
                WebSocket 地址（Qwen-Audio 请填写业务空间 Workspace 地址）
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
                  placeholder="qwen-audio-3.0-asr-flash-streaming 的 API Key"
                />
              </label>
              <button
                className="modal-submit"
                onClick={() => void saveRealtime()}
              >
                保存实时转写配置
              </button>
            </>
          )}
        </section>
      </div>
    </section>
  );
}

type AiModelConfig = {
  id: number;
  name: string;
  provider: string;
  baseUrl: string;
  model: string;
  apiKeySet: boolean;
  apiKeyPreview: string;
  apiKey?: string;
};
type AiPrompt = { id: number; name: string; content: string };
type AsrConfigClient = {
  provider: string;
  submitUrl: string;
  taskUrl: string;
  model: string;
  publicBaseUrl: string;
  apiKeySet: boolean;
  apiKeyPreview: string;
  tokenSecretSet: boolean;
  tokenSecretPreview: string;
  apiKey?: string;
  tokenSecret?: string;
};
type AiConfigState = {
  configs: AiModelConfig[];
  prompts: AiPrompt[];
  activeConfigId: number;
  activePromptId: number;
  autoTranscribe: boolean;
  asrConfig: AsrConfigClient | null;
};

const providerDefaults: Record<string, string> = {
  bailian: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  siliconflow: "https://api.siliconflow.cn/v1",
  openai: "https://api.openai.com/v1",
  custom: "",
};
const providerNames: Record<string, string> = {
  bailian: "阿里云百炼",
  siliconflow: "硅基流动",
  openai: "OpenAI 兼容接口",
  custom: "自定义平台",
};
const modelPresets: Record<string, string[]> = {
  bailian: ["qwen3.8-27b", "qwen-plus", "qwen-max"],
  siliconflow: [
    "Qwen/Qwen3-235B-A22B-Instruct-2507",
    "Qwen/Qwen3-32B",
    "deepseek-ai/DeepSeek-V3",
  ],
  openai: ["gpt-4o-mini", "gpt-4.1-mini", "自定义模型"],
  custom: [],
};

function AiConfig() {
  const [state, setState] = useState<AiConfigState>({
    configs: [],
    prompts: [],
    activeConfigId: 0,
    activePromptId: 0,
    autoTranscribe: false,
    asrConfig: null,
  });
  const [editingModel, setEditingModel] = useState<
    (AiModelConfig & { apiKey?: string }) | null
  >(null);
  const [editingPrompt, setEditingPrompt] = useState<AiPrompt | null>(null);
  const [asrDraft, setAsrDraft] = useState<AsrConfigClient | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await jsonFetch("/api/ai/config");
      setState(data);
      setAsrDraft(data.asrConfig);
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  if (loading)
    return (
      <section className="ai-config-page">
        <p>正在读取 AI 配置…</p>
      </section>
    );
  if (!state)
    return (
      <section className="ai-config-page">
        <p className="evaluation-error">暂无 AI 配置，请重新加载数据库。</p>
      </section>
    );

  const activeModel =
    state.configs.find((item) => item.id === state.activeConfigId) ||
    state.configs[0];
  const activePrompt =
    state.prompts.find((item) => item.id === state.activePromptId) ||
    state.prompts[0];
  const providerModelOptions =
    modelPresets[editingModel?.provider || "custom"] || [];
  const currentModelIsPreset = Boolean(
    editingModel && providerModelOptions.includes(editingModel.model),
  );

  function newModel() {
    setEditingModel({
      id: 0,
      name: "",
      provider: "bailian",
      baseUrl: providerDefaults.bailian,
      model: "qwen3.8-27b",
      apiKeySet: false,
      apiKeyPreview: "",
      apiKey: "",
    });
  }
  function editModel(model: AiModelConfig) {
    setEditingModel({ ...model, apiKey: "" });
  }
  function newPrompt() {
    setEditingPrompt({ id: 0, name: "", content: "" });
  }
  function editPrompt(prompt: AiPrompt) {
    setEditingPrompt({ ...prompt });
  }

  async function saveModel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingModel) return;
    setSaving(true);
    setMessage("");
    try {
      const data = await jsonFetch("/api/ai/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          activeConfigId: editingModel.id || state.activeConfigId,
          activePromptId: state.activePromptId,
          autoTranscribe: state.autoTranscribe,
          config: {
            id: editingModel.id || undefined,
            name: editingModel.name,
            provider: editingModel.provider,
            baseUrl: editingModel.baseUrl,
            model: editingModel.model,
            apiKey: editingModel.apiKey || "",
          },
        }),
      });
      setState(data);
      setEditingModel(null);
      setMessage("模型配置已保存并设为当前配置");
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function savePrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingPrompt) return;
    setSaving(true);
    setMessage("");
    try {
      const data = await jsonFetch("/api/ai/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          activeConfigId: state.activeConfigId,
          activePromptId: editingPrompt.id || state.activePromptId,
          autoTranscribe: state.autoTranscribe,
          prompt: {
            id: editingPrompt.id || undefined,
            name: editingPrompt.name,
            content: editingPrompt.content,
          },
        }),
      });
      setState(data);
      setEditingPrompt(null);
      setMessage("提示词已保存并设为当前提示词");
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function selectActive(
    configId: number,
    promptId = state.activePromptId,
  ) {
    try {
      const data = await jsonFetch("/api/ai/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          activeConfigId: configId,
          activePromptId: promptId,
          autoTranscribe: state.autoTranscribe,
        }),
      });
      setState(data);
      setMessage("当前 AI 配置已切换");
    } catch (error) {
      setMessage((error as Error).message);
    }
  }
  async function toggleAutoTranscribe() {
    try {
      const data = await jsonFetch("/api/ai/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          activeConfigId: state.activeConfigId,
          activePromptId: state.activePromptId,
          autoTranscribe: !state.autoTranscribe,
        }),
      });
      setState(data);
      setMessage(
        data.autoTranscribe
          ? "已开启保存录音后的自动转写"
          : "已关闭自动转写，学员可手动生成文字稿",
      );
    } catch (error) {
      setMessage((error as Error).message);
    }
  }
  async function saveAsr(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!asrDraft) return;
    setSaving(true);
    setMessage("");
    try {
      const data = await jsonFetch("/api/ai/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          activeConfigId: state.activeConfigId,
          activePromptId: state.activePromptId,
          autoTranscribe: state.autoTranscribe,
          asrConfig: asrDraft,
        }),
      });
      setState(data);
      setAsrDraft(data.asrConfig);
      setMessage("录音转文字 API 配置已保存");
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function removeModel(id: number) {
    if (!window.confirm("确定删除这个模型配置吗？")) return;
    try {
      const data = await jsonFetch("/api/ai/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deleteConfigId: id,
          activeConfigId: state.activeConfigId,
          activePromptId: state.activePromptId,
          autoTranscribe: state.autoTranscribe,
        }),
      });
      setState(data);
      setMessage("模型配置已删除");
    } catch (error) {
      setMessage((error as Error).message);
    }
  }
  async function removePrompt(id: number) {
    if (!window.confirm("确定删除这个提示词吗？")) return;
    try {
      const data = await jsonFetch("/api/ai/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deletePromptId: id,
          activeConfigId: state.activeConfigId,
          activePromptId: state.activePromptId,
          autoTranscribe: state.autoTranscribe,
        }),
      });
      setState(data);
      setMessage("提示词已删除");
    } catch (error) {
      setMessage((error as Error).message);
    }
  }

  return (
    <section className="ai-config-page">
      <div className="ai-config-intro">
        <span className="section-kicker">AI CONTROL CENTER</span>
        <h2>模型与提示词</h2>
        <p>
          模型配置、评估提示词和录音自动转写均由管理员控制。密钥只保存于服务器，不会在页面中回显。
        </p>
      </div>
      {message && <div className="management-message">{message}</div>}
      <div className="ai-config-grid">
        <section className="ai-panel">
          <div className="ai-panel-head">
            <div>
              <span className="section-kicker">MODEL CONFIGURATIONS</span>
              <h3>模型配置</h3>
            </div>
            <button
              type="button"
              className="create-trigger small-trigger"
              onClick={newModel}
            >
              ＋ 新增配置
            </button>
          </div>
          <label className="ai-active-select">
            当前使用的模型
            <select
              value={state.activeConfigId}
              onChange={(event) =>
                void selectActive(Number(event.target.value))
              }
            >
              {state.configs.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {providerNames[item.provider] || item.provider}{" "}
                  · {item.model}
                </option>
              ))}
            </select>
          </label>
          {activeModel && (
            <div className="ai-active-summary">
              <strong>{activeModel.name}</strong>
              <span>
                {providerNames[activeModel.provider] || activeModel.provider} ·{" "}
                {activeModel.model}
              </span>
              <small>
                {activeModel.apiKeySet ? "API Key 已配置" : "尚未配置 API Key"}
              </small>
            </div>
          )}
          <div className="ai-config-list">
            {state.configs.map((item) => (
              <article
                className={
                  item.id === state.activeConfigId
                    ? "ai-config-card active"
                    : "ai-config-card"
                }
                key={item.id}
              >
                <div>
                  <strong>{item.name}</strong>
                  <span>
                    {providerNames[item.provider] || item.provider} ·{" "}
                    {item.model}
                  </span>
                </div>
                <div className="ai-card-actions">
                  <button type="button" onClick={() => editModel(item)}>
                    编辑
                  </button>
                  <button
                    type="button"
                    className="danger-text"
                    disabled={item.id === state.activeConfigId}
                    onClick={() => void removeModel(item.id)}
                  >
                    删除
                  </button>
                </div>
              </article>
            ))}
          </div>
          {editingModel && (
            <form className="ai-editor" onSubmit={saveModel}>
              <div className="ai-editor-title">
                <strong>
                  {editingModel.id ? "编辑模型配置" : "新增模型配置"}
                </strong>
                <button type="button" onClick={() => setEditingModel(null)}>
                  取消
                </button>
              </div>
              <label>
                配置名称
                <input
                  required
                  value={editingModel.name}
                  onChange={(event) =>
                    setEditingModel({
                      ...editingModel,
                      name: event.target.value,
                    })
                  }
                  placeholder="例如：百炼面试评估"
                />
              </label>
              <label>
                模型平台
                <select
                  value={editingModel.provider}
                  onChange={(event) =>
                    setEditingModel({
                      ...editingModel,
                      provider: event.target.value,
                      baseUrl:
                        providerDefaults[event.target.value] ||
                        editingModel.baseUrl,
                      model: (modelPresets[event.target.value] || [])[0] || "",
                    })
                  }
                >
                  {Object.keys(providerNames).map((provider) => (
                    <option key={provider} value={provider}>
                      {providerNames[provider]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                兼容接口地址
                <input
                  required
                  type="url"
                  value={editingModel.baseUrl}
                  onChange={(event) =>
                    setEditingModel({
                      ...editingModel,
                      baseUrl: event.target.value,
                    })
                  }
                />
              </label>
              <label>
                模型名称
                <select
                  value={
                    currentModelIsPreset ? editingModel.model : "__custom__"
                  }
                  onChange={(event) =>
                    setEditingModel({
                      ...editingModel,
                      model:
                        event.target.value === "__custom__"
                          ? ""
                          : event.target.value,
                    })
                  }
                >
                  {providerModelOptions.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                  <option value="__custom__">自定义模型名称</option>
                </select>
                {(!currentModelIsPreset || !editingModel.model) && (
                  <input
                    required
                    value={editingModel.model}
                    onChange={(event) =>
                      setEditingModel({
                        ...editingModel,
                        model: event.target.value,
                      })
                    }
                    placeholder="输入模型名称"
                  />
                )}
              </label>
              <label>
                API Key{" "}
                {editingModel.apiKeySet && (
                  <small className="key-preview">
                    当前：{editingModel.apiKeyPreview}（留空不修改）
                  </small>
                )}
                <input
                  type="password"
                  value={editingModel.apiKey || ""}
                  onChange={(event) =>
                    setEditingModel({
                      ...editingModel,
                      apiKey: event.target.value,
                    })
                  }
                  placeholder={
                    editingModel.apiKeySet ? "留空保持当前 Key" : "粘贴 API Key"
                  }
                  autoComplete="off"
                />
              </label>
              <button className="modal-submit" disabled={saving}>
                {saving ? "保存中…" : "保存并启用配置"}
              </button>
            </form>
          )}
        </section>
        <section className="ai-panel">
          <div className="ai-panel-head">
            <div>
              <span className="section-kicker">PROMPT LIBRARY</span>
              <h3>评估提示词</h3>
            </div>
            <button
              type="button"
              className="create-trigger small-trigger"
              onClick={newPrompt}
            >
              ＋ 新增提示词
            </button>
          </div>
          <label className="ai-active-select">
            当前使用的提示词
            <select
              value={state.activePromptId}
              onChange={(event) =>
                void selectActive(
                  state.activeConfigId,
                  Number(event.target.value),
                )
              }
            >
              {state.prompts.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          {activePrompt && (
            <div className="ai-active-summary prompt-summary">
              <strong>{activePrompt.name}</strong>
              <span>
                {activePrompt.content.slice(0, 150)}
                {activePrompt.content.length > 150 ? "…" : ""}
              </span>
            </div>
          )}
          <div className="ai-prompt-list">
            {state.prompts.map((item) => (
              <article
                className={
                  item.id === state.activePromptId
                    ? "ai-prompt-card active"
                    : "ai-prompt-card"
                }
                key={item.id}
              >
                <div>
                  <strong>{item.name}</strong>
                  <p>
                    {item.content.slice(0, 110)}
                    {item.content.length > 110 ? "…" : ""}
                  </p>
                </div>
                <div className="ai-card-actions">
                  <button type="button" onClick={() => editPrompt(item)}>
                    编辑
                  </button>
                  <button
                    type="button"
                    className="danger-text"
                    disabled={item.id === state.activePromptId}
                    onClick={() => void removePrompt(item.id)}
                  >
                    删除
                  </button>
                </div>
              </article>
            ))}
          </div>
          {editingPrompt && (
            <form className="ai-editor" onSubmit={savePrompt}>
              <div className="ai-editor-title">
                <strong>
                  {editingPrompt.id ? "编辑提示词" : "新增提示词"}
                </strong>
                <button type="button" onClick={() => setEditingPrompt(null)}>
                  取消
                </button>
              </div>
              <label>
                提示词名称
                <input
                  required
                  value={editingPrompt.name}
                  onChange={(event) =>
                    setEditingPrompt({
                      ...editingPrompt,
                      name: event.target.value,
                    })
                  }
                  placeholder="例如：食品专业面试评估"
                />
              </label>
              <label>
                提示词内容
                <textarea
                  required
                  value={editingPrompt.content}
                  onChange={(event) =>
                    setEditingPrompt({
                      ...editingPrompt,
                      content: event.target.value,
                    })
                  }
                  placeholder="写清楚角色、输入内容、评价维度和输出格式。"
                />
              </label>
              <button className="modal-submit" disabled={saving}>
                {saving ? "保存中…" : "保存并启用提示词"}
              </button>
            </form>
          )}
        </section>
      </div>
      <section className="ai-panel ai-asr-panel">
        <div className="ai-panel-head">
          <div>
            <span className="section-kicker">ASR CONFIGURATION</span>
            <h3>录音转文字 API</h3>
          </div>
          <small>与 AI 对话模型完全独立</small>
        </div>
        <p className="ai-panel-note">
          用于录音自动转写。密钥仅保存在服务器；更换 ASR
          平台、模型或公网音频地址时，只需要在这里修改。
        </p>
        {asrDraft ? (
          <form className="asr-editor" onSubmit={saveAsr}>
            <label>
              服务平台
              <select
                value={asrDraft.provider}
                onChange={(event) =>
                  setAsrDraft({ ...asrDraft, provider: event.target.value })
                }
              >
                <option value="bailian">阿里云百炼</option>
                <option value="custom">自定义兼容接口</option>
              </select>
            </label>
            <label>
              转写模型
              <input
                required
                value={asrDraft.model}
                onChange={(event) =>
                  setAsrDraft({ ...asrDraft, model: event.target.value })
                }
                placeholder="paraformer-v1"
              />
              <small className="field-hint">
                当前异步提交接口使用 <code>paraformer-v1</code>；<code>paraformer-v2</code>
                在此接口或当前账号下不可用时会返回 Model not exist。
              </small>
            </label>
            <label>
              提交接口地址
              <input
                required
                type="url"
                value={asrDraft.submitUrl}
                onChange={(event) =>
                  setAsrDraft({ ...asrDraft, submitUrl: event.target.value })
                }
              />
            </label>
            <label>
              任务查询地址
              <input
                required
                type="url"
                value={asrDraft.taskUrl}
                onChange={(event) =>
                  setAsrDraft({ ...asrDraft, taskUrl: event.target.value })
                }
              />
            </label>
            <label>
              公网音频地址
              <input
                type="url"
                value={asrDraft.publicBaseUrl}
                onChange={(event) =>
                  setAsrDraft({
                    ...asrDraft,
                    publicBaseUrl: event.target.value,
                  })
                }
                placeholder="例如：http://服务器IP:18080"
              />
            </label>
            <label>
              ASR API Key{" "}
              {asrDraft.apiKeySet && (
                <small className="key-preview">
                  当前：{asrDraft.apiKeyPreview}（留空不修改）
                </small>
              )}
              <input
                type="password"
                value={asrDraft.apiKey || ""}
                onChange={(event) =>
                  setAsrDraft({ ...asrDraft, apiKey: event.target.value })
                }
                placeholder={
                  asrDraft.apiKeySet
                    ? "留空保持当前 Key"
                    : "粘贴录音转写 API Key"
                }
                autoComplete="off"
              />
            </label>
            <label>
              音频临时链接密钥{" "}
              {asrDraft.tokenSecretSet && (
                <small className="key-preview">已设置（留空不修改）</small>
              )}
              <input
                type="password"
                value={asrDraft.tokenSecret || ""}
                onChange={(event) =>
                  setAsrDraft({ ...asrDraft, tokenSecret: event.target.value })
                }
                placeholder="用于保护上传录音的临时访问链接"
                autoComplete="off"
              />
            </label>
            <button className="modal-submit" disabled={saving}>
              {saving ? "保存中…" : "保存录音转文字配置"}
            </button>
          </form>
        ) : (
          <div className="review-empty">正在读取录音转文字配置…</div>
        )}
      </section>
      <section className="ai-automation">
        <div>
          <span className="section-kicker">AUDIO PIPELINE</span>
          <h3>录音后自动转写</h3>
          <p>
            开启后，学员保存带录音的回答时，系统会自动提交百炼 Paraformer
            转写；页面不再显示手动生成按钮。
          </p>
        </div>
        <button
          type="button"
          className={state.autoTranscribe ? "switch on" : "switch"}
          onClick={() => void toggleAutoTranscribe()}
          aria-label="切换自动转写"
        >
          <i />
        </button>
      </section>
    </section>
  );
}
