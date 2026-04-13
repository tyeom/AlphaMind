import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  type Notification,
} from '../api/notification';
import { useAutoTradingWebSocket } from '../hooks/useAutoTradingWebSocket';

const TYPE_ICONS: Record<string, string> = {
  ai_meeting_started: 'AI',
  ai_meeting_completed: 'AI',
  ai_meeting_error: '!',
  buy_signal: 'B',
  sell_signal: 'S',
};

const TYPE_CLASS: Record<string, string> = {
  ai_meeting_started: 'notif-ai',
  ai_meeting_completed: 'notif-ai',
  ai_meeting_error: 'notif-error',
  buy_signal: 'notif-buy',
  sell_signal: 'notif-sell',
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '방금';
  if (mins < 60) return `${mins}분 전`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  return `${days}일 전`;
}

export function NotificationBell() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { on } = useAutoTradingWebSocket();
  const navigate = useNavigate();

  const fetchData = useCallback(async () => {
    try {
      const [list, count] = await Promise.all([
        getNotifications(),
        getUnreadCount(),
      ]);
      setNotifications(list);
      setUnreadCount(count);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  useEffect(() => {
    const off = on('notification', (data: Notification) => {
      setNotifications((prev) => [data, ...prev].slice(0, 100));
      setUnreadCount((prev) => prev + 1);
    });
    return off;
  }, [on]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const handleMarkAllRead = async () => {
    try {
      await markAllAsRead();
      setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
      setUnreadCount(0);
    } catch { /* ignore */ }
  };

  const handleMarkRead = async (id: number) => {
    try {
      await markAsRead(id);
      setNotifications((prev) =>
        prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)),
      );
      setUnreadCount((prev) => Math.max(0, prev - 1));
    } catch { /* ignore */ }
  };

  const handleClick = async (n: Notification) => {
    if (!n.isRead) handleMarkRead(n.id);

    if (n.type === 'ai_meeting_completed') {
      navigate('/ai-scanner?view=results');
      setOpen(false);
    } else if (n.type === 'ai_meeting_started') {
      navigate('/ai-scanner');
      setOpen(false);
    }
  };

  const handleDelete = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const wasUnread = notifications.find((n) => n.id === id && !n.isRead);
      await deleteNotification(id);
      setNotifications((prev) => prev.filter((n) => n.id !== id));
      if (wasUnread) setUnreadCount((prev) => Math.max(0, prev - 1));
    } catch { /* ignore */ }
  };

  return (
    <div className="notification-bell" ref={dropdownRef}>
      <button
        className="btn-icon notification-trigger"
        onClick={() => setOpen(!open)}
        title="알림"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unreadCount > 0 && (
          <span className="notification-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>
        )}
      </button>

      {open && (
        <div className="notification-dropdown">
          <div className="notification-header">
            <strong>알림</strong>
            {unreadCount > 0 && (
              <button className="btn-text btn-sm" onClick={handleMarkAllRead}>
                모두 읽음
              </button>
            )}
          </div>

          <div className="notification-list">
            {notifications.length === 0 ? (
              <div className="notification-empty">알림이 없습니다</div>
            ) : (
              notifications.map((n) => (
                <div
                  key={n.id}
                  className={`notification-item ${!n.isRead ? 'unread' : ''} ${TYPE_CLASS[n.type] || ''}`}
                  onClick={() => handleClick(n)}
                  style={{ cursor: (n.type === 'ai_meeting_completed' || n.type === 'ai_meeting_started') ? 'pointer' : undefined }}
                >
                  <div className={`notification-icon ${TYPE_CLASS[n.type] || ''}`}>
                    {TYPE_ICONS[n.type] || '?'}
                  </div>
                  <div className="notification-content">
                    <div className="notification-title">{n.title}</div>
                    <div className="notification-message">{n.message}</div>
                    <div className="notification-time">{timeAgo(n.createdAt)}</div>
                  </div>
                  <button
                    className="notification-delete"
                    onClick={(e) => handleDelete(n.id, e)}
                    title="삭제"
                  >
                    &times;
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
