/**
 * Logger module
 */
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV === 'development' ? {
    target: 'pino-pretty',
    options: {
      colorize: true
    }
  } : undefined
});

export const log = (message: string, ...args: any[]) => {
  logger.info(message, ...args);
};

export const logError = (error: unknown, message?: string) => {
  logger.error(error, message);
};

export const logWarn = (message: string, ...args: any[]) => {
  logger.warn(message, ...args);
};

export const logInfo = (message: string, ...args: any[]) => {
  logger.info(message, ...args);
};

export const logDebug = (message: string, ...args: any[]) => {
  logger.debug(message, ...args);
};

export default logger;