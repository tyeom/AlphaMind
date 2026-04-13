import {
  Entity,
  PrimaryKey,
  Property,
  ManyToOne,
  Enum,
  Index,
  OptionalProps,
} from '@mikro-orm/core';
import { UserEntity } from '../../user/entities/user.entity';

export enum NotificationType {
  AI_MEETING_STARTED = 'ai_meeting_started',
  AI_MEETING_COMPLETED = 'ai_meeting_completed',
  AI_MEETING_ERROR = 'ai_meeting_error',
  BUY_SIGNAL = 'buy_signal',
  SELL_SIGNAL = 'sell_signal',
}

@Entity({ tableName: 'notifications' })
export class NotificationEntity {
  [OptionalProps]?: 'id' | 'isRead' | 'createdAt';

  @PrimaryKey()
  id!: number;

  @ManyToOne(() => UserEntity, { deleteRule: 'cascade' })
  @Index()
  user!: UserEntity;

  @Enum({ items: () => NotificationType })
  @Index()
  type!: NotificationType;

  @Property({ length: 200 })
  title!: string;

  @Property({ type: 'text' })
  message!: string;

  @Property({ type: 'json', nullable: true })
  metadata?: Record<string, any>;

  @Property({ default: false })
  @Index()
  isRead: boolean = false;

  @Property()
  createdAt: Date = new Date();
}
