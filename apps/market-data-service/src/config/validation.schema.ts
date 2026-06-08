import Joi from 'joi';

export const validationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),

  PORT: Joi.number().default(3001),

  // Database
  DB_HOST: Joi.string().required(),
  DB_PORT: Joi.number().default(5432),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_DATABASE: Joi.string().required(),

  // JWT
  JWT_SECRET: Joi.string().required(),

  // Claude CLI
  CLAUDE_CLI_PATH: Joi.string().default('claude'),
  CODEX_CLI_PATH: Joi.string().default('codex'),
  CODEX_HOME: Joi.string().default('/root/.codex'),

  // RabbitMQ
  RMQ_URL: Joi.string().default('amqp://alpha:alpha1234@localhost:5672'),

  // Backtest
  BACKTEST_SELL_TAX_PCT: Joi.number().default(0.15),

  // Sprint3 시장 레짐 — 산출 토글은 요청 options 로 받고, 임계/스케일 기본값만 둔다.
  REGIME_INDEX_SOURCE: Joi.string()
    .valid('breadth', 'yahoo', 'hybrid')
    .default('breadth'),
  REGIME_MA_DAYS: Joi.number().integer().positive().default(5),
  REGIME_MIN_HOLD_DAYS: Joi.number().integer().min(0).default(1),
  REGIME_MIN_BREADTH_SAMPLE: Joi.number().integer().positive().default(30),
  REGIME_RET5D_SPAN: Joi.number().positive().default(10),
  REGIME_VOL_FLOOR_PCT: Joi.number().default(2.0),
  REGIME_VOL_CEIL_PCT: Joi.number().default(6.0),
  REGIME_W_TREND: Joi.number().default(0.4),
  REGIME_W_MOM: Joi.number().default(0.2),
  REGIME_W_VOL: Joi.number().default(0.4),
  REGIME_CRISIS_ENTER: Joi.number().default(0.35),
  REGIME_CRISIS_EXIT: Joi.number().default(0.45),
  REGIME_ATTACK_ENTER: Joi.number().default(0.65),
  REGIME_ATTACK_EXIT: Joi.number().default(0.55),
  REGIME_CRISIS_SLOT_MULT: Joi.number().positive().default(0.5),
  REGIME_CRISIS_AMOUNT_MULT: Joi.number().positive().default(0.6),
  REGIME_NEUTRAL_SLOT_MULT: Joi.number().positive().default(0.8),
  REGIME_NEUTRAL_AMOUNT_MULT: Joi.number().positive().default(0.8),
  REGIME_ATTACK_SLOT_MULT: Joi.number().positive().default(1.0),
  REGIME_ATTACK_AMOUNT_MULT: Joi.number().positive().default(1.0),

  // Sprint3 상관 클러스터 — backend 캡 토글과 별개로 계산 options 가 ON일 때만 사용
  CORRELATION_THRESHOLD: Joi.number().default(0.8),
  CORR_MIN_OVERLAP: Joi.number().integer().positive().default(40),
  CORR_LOOKBACK_DAYS: Joi.number().integer().positive().default(60),
  CORR_MAX_CLUSTER_SIZE_WARN: Joi.number().integer().positive().default(6),
  CORR_LINKAGE: Joi.string().valid('union', 'average').default('union'),
});
