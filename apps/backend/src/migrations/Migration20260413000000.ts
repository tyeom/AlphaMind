import { Migration } from '@mikro-orm/migrations';

export class Migration20260413000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "notifications" (
        "id" serial primary key,
        "user_id" int not null references "users"("id") on delete cascade,
        "type" varchar(30) not null,
        "title" varchar(200) not null,
        "message" text not null,
        "metadata" jsonb,
        "is_read" boolean not null default false,
        "created_at" timestamptz not null default now()
      );
    `);
    this.addSql(
      `create index "notifications_user_id_index" on "notifications" ("user_id");`,
    );
    this.addSql(
      `create index "notifications_type_index" on "notifications" ("type");`,
    );
    this.addSql(
      `create index "notifications_is_read_index" on "notifications" ("is_read");`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "notifications";`);
  }
}
