import { Migration } from '@mikro-orm/migrations';

export class Migration20260328000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "users" (
        "id" serial primary key,
        "username" varchar(255) not null,
        "password" varchar(255) not null,
        "email" varchar(255) not null,
        "name" varchar(255) not null,
        "role" varchar(255) not null default 'user',
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "users_username_unique" unique ("username"),
        constraint "users_email_unique" unique ("email")
      );
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists "users" cascade;');
  }
}
