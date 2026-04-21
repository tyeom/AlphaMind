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

  // RabbitMQ
  RMQ_URL: Joi.string().default('amqp://alpha:alpha1234@localhost:5672'),

  // 예약 스캔 실행 사용자 — 미설정 시 예약 스캔 스킵
  SCHEDULED_TRADER_USER_ID: Joi.number().integer().positive().optional(),
});
