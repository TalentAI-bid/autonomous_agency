import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  ...(isDev
    ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
    : {}),
  redact: ['password', 'passwordHash', 'token', 'refreshToken', 'authorization'],
  serializers: {
    err: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
});

export default logger;
