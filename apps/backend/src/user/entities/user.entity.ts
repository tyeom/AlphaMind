import {
  Entity,
  PrimaryKey,
  Property,
  Enum,
  Unique,
  OptionalProps,
} from '@mikro-orm/core';
import { UserRole } from '@alpha-mind/common';

@Entity({ tableName: 'users' })
export class UserEntity {
  [OptionalProps]?: 'id' | 'role' | 'createdAt' | 'updatedAt';

  @PrimaryKey()
  id!: number;

  @Property()
  @Unique()
  username!: string;

  @Property({ hidden: true })
  password!: string;

  @Property()
  @Unique()
  email!: string;

  @Property()
  name!: string;

  @Enum(() => UserRole)
  role: UserRole = UserRole.USER;

  @Property()
  createdAt: Date = new Date();

  @Property({ onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
