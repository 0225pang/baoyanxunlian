'use client';

export type ClientNotification = { kind?: 'success' | 'error' | 'info' | 'warning'; title: string; content?: string };

export async function pushNotification(notification: ClientNotification) {
  const response = await fetch('/api/notifications', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(notification),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || '通知保存失败');
  window.dispatchEvent(new CustomEvent('app-notification', { detail: result.notification }));
  return result.notification;
}
