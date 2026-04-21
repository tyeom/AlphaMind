import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import {
  NotificationEntity,
  NotificationType,
} from './entities/notification.entity';
import { UserEntity } from '../user/entities/user.entity';

@Injectable()
export class NotificationService {
  constructor(private readonly em: EntityManager) {}

  /** 한 종목(또는 세션)당 최신 1건만 유지해야 하는 알림 타입 */
  private static readonly DEDUP_TYPES: Set<NotificationType> = new Set([
    NotificationType.AI_MEETING_STARTED,
    NotificationType.AI_MEETING_COMPLETED,
    NotificationType.ORDER_TRACKING_WARNING,
    NotificationType.SCHEDULED_SCAN_WARNING,
  ]);

  async create(
    userId: number,
    type: NotificationType,
    title: string,
    message: string,
    metadata?: Record<string, any>,
  ): Promise<NotificationEntity> {
    const user = await this.em.findOneOrFail(UserEntity, userId);

    // 중복 방지: 같은 타입의 기존 unread 알림 삭제
    if (NotificationService.DEDUP_TYPES.has(type)) {
      await this.em.nativeDelete(NotificationEntity, {
        user: userId,
        type,
        isRead: false,
      });
    }

    const notification = this.em.create(NotificationEntity, {
      user,
      type,
      title,
      message,
      metadata,
    });
    await this.em.persistAndFlush(notification);
    return notification;
  }

  async getAll(userId: number): Promise<NotificationEntity[]> {
    return this.em.find(
      NotificationEntity,
      { user: userId },
      { orderBy: { createdAt: 'DESC' }, limit: 100 },
    );
  }

  async getUnreadCount(userId: number): Promise<number> {
    return this.em.count(NotificationEntity, {
      user: userId,
      isRead: false,
    });
  }

  async markAsRead(id: number, userId: number): Promise<NotificationEntity> {
    const notification = await this.em.findOneOrFail(NotificationEntity, {
      id,
      user: userId,
    });
    notification.isRead = true;
    await this.em.flush();
    return notification;
  }

  async markAllAsRead(userId: number): Promise<number> {
    const count = await this.em.nativeUpdate(
      NotificationEntity,
      { user: userId, isRead: false },
      { isRead: true },
    );
    return count;
  }

  async delete(id: number, userId: number): Promise<void> {
    const notification = await this.em.findOneOrFail(NotificationEntity, {
      id,
      user: userId,
    });
    await this.em.removeAndFlush(notification);
  }
}
