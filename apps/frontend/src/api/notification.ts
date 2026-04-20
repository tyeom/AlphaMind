import { api } from './client';

export interface Notification {
  id: number;
  type:
    | 'ai_meeting_started'
    | 'ai_meeting_completed'
    | 'ai_meeting_error'
    | 'order_tracking_warning'
    | 'buy_signal'
    | 'sell_signal';
  title: string;
  message: string;
  metadata?: Record<string, any>;
  isRead: boolean;
  createdAt: string;
}

export function getNotifications(): Promise<Notification[]> {
  return api.get<Notification[]>('/notifications');
}

export function getUnreadCount(): Promise<number> {
  return api.get<number>('/notifications/unread-count');
}

export function markAsRead(id: number): Promise<Notification> {
  return api.patch<Notification>(`/notifications/${id}/read`);
}

export function markAllAsRead(): Promise<number> {
  return api.patch<number>('/notifications/read-all');
}

export function deleteNotification(id: number): Promise<void> {
  return api.delete<void>(`/notifications/${id}`);
}
