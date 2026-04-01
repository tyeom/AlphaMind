import { Migration } from '@mikro-orm/migrations';

export class Migration20260330000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "user_auth_tokens" (
        "id" serial primary key,
        "user_id" int not null references "users" ("id") on delete cascade,
        "token" text not null,
        "expires_at" timestamptz not null,
        "created_at" timestamptz not null default now()
      );
    `);
    this.addSql(
      `create index "user_auth_tokens_token_index" on "user_auth_tokens" ("token");`,
    );
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists "user_auth_tokens" cascade;');
  }
}
