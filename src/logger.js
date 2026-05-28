import pino from 'pino';
import { config } from './config.js';

const isDev = process.env.NODE_ENV !== 'production';

export const logger = pino({
  level: config.LOG_LEVEL,
  base: { hub: config.HUB_NAME },
  transport: isDev
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } }
    : undefined,
});
