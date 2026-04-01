import { Migration } from '@mikro-orm/migrations';

export class Migration20260330100000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "trade_histories" (
        "id" serial primary key,
        "user_id" int not null references "users" ("id") on delete cascade,
        "action" varchar(10) not null,
        "trade_type" varchar(4),
        "stock_code" varchar(6) not null,
        "order_dvsn" varchar(10) not null,
        "quantity" int not null,
        "price" int not null,
        "kis_order_no" varchar(255),
        "kis_org_order_no" varchar(255),
        "status" varchar(10) not null,
        "error_message" text,
        "raw_response" jsonb,
        "created_at" timestamptz not null default now()
      );
    `);
    this.addSql(
      `create index "trade_histories_user_id_index" on "trade_histories" ("user_id");`,
    );
    this.addSql(
      `create index "trade_histories_stock_code_index" on "trade_histories" ("stock_code");`,
    );
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists "trade_histories" cascade;');
  }
}
