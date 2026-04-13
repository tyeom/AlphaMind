import { Migration } from '@mikro-orm/migrations';

export class Migration20260413100000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "ai_meeting_results" (
        "id" serial primary key,
        "user_id" int not null references "users"("id") on delete cascade,
        "stock_code" varchar(10) not null,
        "stock_name" varchar(100) not null,
        "score" real not null,
        "reasoning" text not null,
        "data" jsonb not null,
        "updated_at" timestamptz not null default now()
      );
    `);
    this.addSql(`create index "ai_meeting_results_user_id_index" on "ai_meeting_results" ("user_id");`);
    this.addSql(`create index "ai_meeting_results_stock_code_index" on "ai_meeting_results" ("stock_code");`);
    this.addSql(`create unique index "ai_meeting_results_user_id_stock_code_unique" on "ai_meeting_results" ("user_id", "stock_code");`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "ai_meeting_results";`);
  }
}
