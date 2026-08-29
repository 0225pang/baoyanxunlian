import { execute } from '@/lib/db';

export type NotificationKind = 'success' | 'error' | 'info' | 'warning';

export async function createUserNotification(userId: number, title: string, content = '', kind: NotificationKind = 'info') {
  if (!Number.isInteger(userId) || userId < 1) return;
  await execute(
    'INSERT INTO user_notifications (user_id, kind, title, content) VALUES (?, ?, ?, ?)',
    [userId, kind, title.slice(0, 180), content.slice(0, 4000) || null],
  ).catch((error) => console.error('Could not save user notification:', error));
}
