import * as winston from 'winston';
import 'winston-daily-rotate-file';
import { WinstonModule } from 'nest-winston';

export function createWinstonLogger(serviceName: string) {
  const logDir = `logs`;

  const dailyRotateTransport = new winston.transports.DailyRotateFile({
    dirname: logDir,
    filename: `${serviceName}-%DATE%.log`,
    datePattern: 'YYYY-MM-DD',
    maxFiles: '14d',
    zippedArchive: true,
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.json(),
    ),
  });

  const errorRotateTransport = new winston.transports.DailyRotateFile({
    dirname: logDir,
    filename: `${serviceName}-error-%DATE%.log`,
    datePattern: 'YYYY-MM-DD',
    maxFiles: '14d',
    zippedArchive: true,
    level: 'error',
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.json(),
    ),
  });

  const consoleTransport = new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.printf(
        ({ timestamp, level, message, context, ...meta }) => {
          const ctx = context ? `[${context}]` : '';
          const metaStr = Object.keys(meta).length
            ? ` ${JSON.stringify(meta)}`
            : '';
          return `${timestamp} ${level} ${ctx} ${message}${metaStr}`;
        },
      ),
    ),
  });

  return WinstonModule.createLogger({
    transports: [consoleTransport, dailyRotateTransport, errorRotateTransport],
  });
}
