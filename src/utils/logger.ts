export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
}

const serialize = (context?: Record<string, unknown>): string => {
  if (!context || Object.keys(context).length === 0) {
    return "";
  }

  return ` ${JSON.stringify(context)}`;
};

export const consoleLogger: Logger = {
  info(message, context) {
    // eslint-disable-next-line no-console
    console.log(`[INFO] ${message}${serialize(context)}`);
  },
  warn(message, context) {
    // eslint-disable-next-line no-console
    console.warn(`[WARN] ${message}${serialize(context)}`);
  },
  error(message, context) {
    // eslint-disable-next-line no-console
    console.error(`[ERROR] ${message}${serialize(context)}`);
  },
  debug(message, context) {
    // eslint-disable-next-line no-console
    console.debug(`[DEBUG] ${message}${serialize(context)}`);
  }
};
