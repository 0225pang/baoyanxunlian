'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type Notification = { id: number; kind: 'success' | 'error' | 'info' | 'warning' | 'announcement'; title: string; content?: string | null; isRead: boolean; createdAt: string; announcementId?: number | null; forcePopup?: boolean };

function when(value: string) {
  const date = new Date(value.includes('T') ? value : value.replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function NotificationBell() {
  const [open, setOpen] = useState(false); const [items, setItems] = useState<Notification[]>([]); const [unread, setUnread] = useState(0); const centerRef = useRef<HTMLDivElement>(null);
  const load = useCallback(async () => {
    const response = await fetch('/api/notifications'); const data = await response.json().catch(() => ({}));
    if (response.ok) { setItems(data.notifications || []); setUnread(Number(data.unreadCount || 0)); }
  }, []);
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 15000); const receive = (event: Event) => { const item = (event as CustomEvent<Notification | null>).detail; if (item) { setItems((current) => [item, ...current.filter((entry) => entry.id !== item.id)].slice(0, 80)); setUnread((count) => count + (item.isRead ? 0 : 1)); } else void load(); }; window.addEventListener('app-notification', receive); return () => { window.clearInterval(timer); window.removeEventListener('app-notification', receive); }; }, [load]);
  const readAll = useCallback(async () => { const response = await fetch('/api/notifications', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all: true, excludeAnnouncements: true }) }); const data = await response.json().catch(() => ({})); if (response.ok) { setItems(data.notifications || []); setUnread(Number(data.unreadCount || 0)); } }, []);
  const readAnnouncement = useCallback(async (id: number) => { const response = await fetch('/api/notifications', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }); const data = await response.json().catch(() => ({})); if (response.ok) { setItems(data.notifications || []); setUnread(Number(data.unreadCount || 0)); } }, []);
  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => { if (centerRef.current && event.target instanceof Node && !centerRef.current.contains(event.target)) setOpen(false); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => { document.removeEventListener('pointerdown', closeOnOutsidePointer); document.removeEventListener('keydown', closeOnEscape); };
  }, [open]);
  const toggle = () => { if (open) { setOpen(false); return; } setOpen(true); void readAll(); };
  const announcement = items.find((item) => item.kind === 'announcement' && item.forcePopup && !item.isRead);
  return <div ref={centerRef} className="notification-center"><button type="button" className="notification-bell" aria-label={`通知中心${unread ? `，${unread} 条未读` : ''}`} aria-expanded={open} onClick={toggle}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 9a6 6 0 0 0-12 0c0-2-3-2-3-9M10 21h4" /></svg>{unread > 0 && <i>{unread > 99 ? '99+' : unread}</i>}</button>{open && <section className="notification-popover" role="dialog" aria-label="通知中心"><header><div><strong>通知中心</strong><small>打开后会自动标记普通通知为已读</small></div></header><div className="notification-list">{items.length ? items.map((item) => <article key={item.id} className={`notification-item ${item.kind} ${item.isRead ? 'read' : ''}`}><span aria-hidden="true" /> <div><b>{item.title}</b>{item.content && <p>{item.content}</p>}<time>{when(item.createdAt)}</time></div></article>) : <div className="notification-empty">还没有通知。完成转录、复盘、导入或配音后，结果会显示在这里。</div>}</div></section>}{announcement && <section className="announcement-live-overlay" role="alertdialog" aria-modal="true" aria-label="系统公告"><div className="announcement-live-backdrop" aria-hidden="true" /><div className="announcement-modal announcement-modal-live"><div className="announcement-modal-mark" aria-hidden="true">公告</div><button className="announcement-modal-close" type="button" aria-label="关闭并标记已读" onClick={() => void readAnnouncement(announcement.id)}>×</button><p className="announcement-modal-kicker">SYSTEM UPDATE</p><h2>{announcement.title}</h2><p className="announcement-modal-content">{announcement.content}</p><time>{when(announcement.createdAt)}</time><button className="announcement-modal-confirm" type="button" onClick={() => void readAnnouncement(announcement.id)}>我已阅读</button></div></section>}</div>;
}
