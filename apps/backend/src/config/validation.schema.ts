import Joi from 'joi';

export const validationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),

  PORT: Joi.number().default(3000),

  // Database
  DB_HOST: Joi.string().required(),
  DB_PORT: Joi.number().default(5432),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_DATABASE: Joi.string().required(),

  // JWT
  JWT_SECRET: Joi.string().required(),
  JWT_EXPIRES_IN: Joi.string().default('1d'),

  // KIS (한국투자증권)
  KIS_APP_KEY: Joi.string().required(),
  KIS_APP_SECRET: Joi.string().required(),
  KIS_ACCOUNT_NO: Joi.string().length(8).required(),
  KIS_ACCOUNT_PROD_CD: Joi.string().length(2).default('01'),
  KIS_HTS_ID: Joi.string().allow('').optional(),
  KIS_ENV: Joi.string().valid('sandbox', 'production').default('sandbox'),
  KIS_MAX_RPS: Joi.number().default(8),
  KIS_RATE_BURST: Joi.number().default(8),
  KIS_RATE_MAX_RETRY: Joi.number().default(5),
  KIS_WS_APPROVAL_TIMEOUT_MS: Joi.number().integer().positive().default(15000),
  KIS_WS_HANDSHAKE_TIMEOUT_MS: Joi.number().integer().positive().default(15000),

  // Toss (토스증권 Open API) — 현재가/차트 등 시세 조회를 KIS REST 대신 사용.
  // 키 미설정 시 시세 조회는 KIS REST 로 폴백한다(allow('')).
  TOSS_API_BASE_URL: Joi.string()
    .uri()
    .default('https://openapi.tossinvest.com'),
  TOSS_CLIENT_ID: Joi.string().allow('').optional(),
  TOSS_CLIENT_SECRET: Joi.string().allow('').optional(),
  TOSS_REQUEST_TIMEOUT_MS: Joi.number().integer().positive().default(10000),
  // 토스 현재가 체결시각 허용 신선도(ms). 초과/누락 시 KIS 현재가로 폴백한다.
  TOSS_PRICE_MAX_AGE_MS: Joi.number().integer().positive().default(300000),
  PRICE_POLL_TICK_MS: Joi.number().integer().positive().default(1000),
  PRICE_POLL_MAX_IN_FLIGHT: Joi.number().integer().positive().default(2),
  PRICE_POLL_FAILURE_BASE_DELAY_MS: Joi.number()
    .integer()
    .positive()
    .default(15000),
  PRICE_POLL_FAILURE_MAX_DELAY_MS: Joi.number()
    .integer()
    .positive()
    .default(120000),
  PRICE_POLL_WARN_COOLDOWN_MS: Joi.number().integer().positive().default(30000),
  // 체결통보 비활성화 시 주문체결 조회로 실제 체결 확정을 확인한다.
  ORDER_POLL_INITIAL_DELAY_MS: Joi.number().integer().positive().default(2000),
  ORDER_POLL_INTERVAL_MS: Joi.number().integer().positive().default(5000),
  ORDER_POLL_MAX_ATTEMPTS: Joi.number().integer().positive().default(24),
  // 일봉 스캔 후보의 실매수는 KIS 실시간 체결을 집계한 완성 1분봉 신호로 제한한다.
  INTRADAY_SCALPING_MIN_CANDLES: Joi.number()
    .integer()
    .min(5)
    .max(60)
    .default(5),
  INTRADAY_SCALPING_MAX_TICK_AGE_MS: Joi.number()
    .integer()
    .positive()
    .default(90000),
  INTRADAY_SCALPING_MIN_EXECUTION_STRENGTH: Joi.number()
    .positive()
    .default(100),
  INTRADAY_SCALPING_MAX_SPREAD_PCT: Joi.number()
    .positive()
    .max(5)
    .default(0.35),
  INTRADAY_SCALPING_MIN_VOLUME_RATIO: Joi.number().positive().default(1.0),

  // Sprint3 VI/상하한가 처리 — 기본 OFF, 토글 ON 시에만 신규 주문 게이트 적용
  VI_HANDLING_ENABLED: Joi.boolean().default(false),
  VI_CLEAR_TIMEOUT_MS: Joi.number().integer().positive().default(150000),
  VI_LIMIT_NEAR_PCT: Joi.number().positive().default(29.5),
  VI_STOPLOSS_LIMIT_ORDER: Joi.boolean().default(true),
  VI_REEVAL_DEBOUNCE_MS: Joi.number().integer().positive().default(1000),
  NXT_HANDLING_ENABLED: Joi.boolean().default(false),

  // RabbitMQ
  RMQ_URL: Joi.string().default('amqp://alpha:alpha1234@localhost:5672'),

  // 예약 스캔 실행 사용자 — 미설정 시 예약 스캔 스킵
  SCHEDULED_TRADER_USER_ID: Joi.number().integer().positive().optional(),

  // Sprint3 포트폴리오 레이어 — 기본 OFF, 토글 ON 시에만 신규 경로 적용
  REGIME_SCALING_ENABLED: Joi.boolean().default(false),
  CORRELATION_CAP_ENABLED: Joi.boolean().default(false),
  REGIME_MIN_HOLDINGS_FLOOR: Joi.number().integer().positive().default(3),
  REGIME_AMOUNT_FLOOR: Joi.number().positive().default(0.4),
  MAX_PER_CLUSTER: Joi.number().integer().positive().default(2),

  // 공격형/보수형 매매 손잡이 (미설정 시 기존 동작 동일)
  // SCAN_FORCE_FIXED_TP_SL=true 면 그리드서치·ATR동적 우회하고 아래 고정 TP/SL 사용.
  SCAN_FORCE_FIXED_TP_SL: Joi.boolean().default(false),
  // 익절은 양수, 손절은 음수여야 함(부호 뒤집힘=진입 즉시 청산 footgun 차단). 범위는 가격제한폭 ±30% 이내.
  SCAN_AUTO_TAKE_PROFIT_PCT: Joi.number().greater(0).max(30).default(2.5),
  SCAN_AUTO_STOP_LOSS_PCT: Joi.number().less(0).min(-30).default(-2.0),
  // 일봉 매수 신호 최소 강도(낮출수록 공격적). 스캔 후보 + 비스켈핑 실거래 진입 게이트 공통.
  MIN_BUY_SIGNAL_STRENGTH: Joi.number().min(0).max(1).default(0.65),
  // 동시 보유 종목 상한.
  MAX_CONCURRENT_HOLDINGS: Joi.number().integer().positive().default(15),
  // R기반 사이징 거래당 리스크 %(높일수록 포지션 큼).
  R_RISK_PCT: Joi.number().positive().default(0.5),
});
