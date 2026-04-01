import { Migration } from '@mikro-orm/migrations';

export class Migration20260330200000 extends Migration {
  override async up(): Promise<void> {
    // trade_histories에 stock_name 컬럼 추가
    this.addSql(
      `alter table "trade_histories" add column "stock_name" varchar(255);`,
    );

    // 매매 일지 일별 요약 테이블
    this.addSql(`
      create table "trade_daily_summaries" (
        "id" serial primary key,
        "user_id" int not null references "users" ("id") on delete cascade,
        "date" varchar(8) not null,
        "total_buy_amount" decimal(15,0) not null default 0,
        "total_sell_amount" decimal(15,0) not null default 0,
        "realized_profit_loss" decimal(15,0) not null default 0,
        "total_eval_amount" decimal(15,0) not null default 0,
        "total_purchase_amount" decimal(15,0) not null default 0,
        "total_eval_profit_loss" decimal(15,0) not null default 0,
        "total_profit_loss_rate" float not null default 0,
        "cash_balance" decimal(15,0) not null default 0,
        "stock_summaries" jsonb,
        "created_at" timestamptz not null default now()
      );
    `);
    this.addSql(
      `create index "trade_daily_summaries_user_id_index" on "trade_daily_summaries" ("user_id");`,
    );
    this.addSql(
      `create index "trade_daily_summaries_date_index" on "trade_daily_summaries" ("date");`,
    );
    this.addSql(
      `create unique index "trade_daily_summaries_user_id_date_unique" on "trade_daily_summaries" ("user_id", "date");`,
    );
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists "trade_daily_summaries" cascade;');
    this.addSql(
      `alter table "trade_histories" drop column if exists "stock_name";`,
    );
  }
}
