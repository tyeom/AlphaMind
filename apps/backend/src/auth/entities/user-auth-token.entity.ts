import {
  Entity,
  PrimaryKey,
  Property,
  ManyToOne,
  OptionalProps,
  Index,
} from '@mikro-orm/core';
import { UserEntity } from '../../user/entities/user.entity';

@Entity({ tableName: 'user_auth_tokens' })
export class UserAuthTokenEntity {
  [OptionalProps]?: 'id' | 'createdAt';

  @PrimaryKey()
  id!: number;

  @ManyToOne(() => UserEntity, { deleteRule: 'cascade' })
  user!: UserEntity;

  @Property({ type: 'text' })
  @Index()
  token!: string;

  @Property()
  expiresAt!: Date;

  @Property()
  createdAt: Date = new Date();
}
