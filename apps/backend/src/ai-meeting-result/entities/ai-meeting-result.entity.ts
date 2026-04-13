import {
  Entity,
  PrimaryKey,
  Property,
  ManyToOne,
  Index,
  OptionalProps,
  Unique,
} from '@mikro-orm/core';
import { UserEntity } from '../../user/entities/user.entity';

@Entity({ tableName: 'ai_meeting_results' })
@Unique({ properties: ['user', 'stockCode'] })
export class AiMeetingResultEntity {
  [OptionalProps]?: 'id' | 'updatedAt';

  @PrimaryKey()
  id!: number;

  @ManyToOne(() => UserEntity, { deleteRule: 'cascade' })
  @Index()
  user!: UserEntity;

  @Property({ length: 10 })
  @Index()
  stockCode!: string;

  @Property({ length: 100 })
  stockName!: string;

  @Property({ type: 'float' })
  score!: number;

  @Property({ type: 'text' })
  reasoning!: string;

  @Property({ type: 'json' })
  data!: Record<string, any>;

  @Property({ onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
