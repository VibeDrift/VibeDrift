// Single structured-logging helper used by every module in this library.

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  readonly [key: string]: string | number | boolean | null;
}

export interface LogRecord {
  readonly level: LogLevel;
  readonly message: string;
  readonly timestamp: string;
  readonly fields: LogFields;
}

function buildRecord(level: LogLevel, message: string, fields: LogFields): LogRecord {
  return {
    level,
    message,
    timestamp: new Date().toISOString(),
    fields,
  };
}

export function logDebug(message: string, fields: LogFields = {}): LogRecord {
  const record = buildRecord("debug", message, fields);
  emit(record);
  return record;
}

export function logInfo(message: string, fields: LogFields = {}): LogRecord {
  const record = buildRecord("info", message, fields);
  emit(record);
  return record;
}

export function logWarn(message: string, fields: LogFields = {}): LogRecord {
  const record = buildRecord("warn", message, fields);
  emit(record);
  return record;
}

export function logError(message: string, fields: LogFields = {}): LogRecord {
  const record = buildRecord("error", message, fields);
  emit(record);
  return record;
}

function emit(record: LogRecord): void {
  const line = JSON.stringify(record);
  process.stdout.write(`${line}\n`);
}
