import { Migration } from '@mikro-orm/migrations';

export class Migration20260401000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "auto_trading_sessions" (
        "id" serial primary key,
        "user_id" int not null references "users" ("id") on delete cascade,
        "stock_code" varchar(10) not null,
        "stock_name" varchar(100) not null,
        "strategy_id" varchar(30) not null,
        "variant" varchar(30),
        "investment_amount" decimal(15,0) not null,
        "realized_pnl" decimal(15,0) not null default 0,
        "unrealized_pnl" decimal(15,0) not null default 0,
        "holding_qty" int not null default 0,
        "avg_buy_price" float not null default 0,
        "total_buys" int not null default 0,
        "total_sells" int not null default 0,
        "status" varchar(10) not null default 'active',
        "ai_score" float,
        "created_at" timestamptz not null default now(),
        "stopped_at" timestamptz
      );
    `);
    this.addSql(
      `create index "auto_trading_sessions_user_id_index" on "auto_trading_sessions" ("user_id");`,
    );
    this.addSql(
      `create index "auto_trading_sessions_stock_code_index" on "auto_trading_sessions" ("stock_code");`,
    );
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists "auto_trading_sessions" cascade;');
  }
}
