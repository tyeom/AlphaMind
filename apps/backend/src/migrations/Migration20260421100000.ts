import { Migration } from '@mikro-orm/migrations';

export class Migration20260421100000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "auto_trading_sessions"
        add column "pause_reason" varchar(20),
        add column "auto_pause_pending" boolean not null default false;
    `);

    this.addSql(`
      create table "scheduled_job_locks" (
        "job_name" varchar(100) not null,
        "locked_until" timestamptz not null,
        "owner" varchar(120) not null,
        "updated_at" timestamptz not null default now(),
        constraint "scheduled_job_locks_pkey" primary key ("job_name")
      );
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists "scheduled_job_locks" cascade;');

    this.addSql(`
      alter table "auto_trading_sessions"
        drop column "pause_reason",
        drop column "auto_pause_pending";
    `);
  }
}
