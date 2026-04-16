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
});
