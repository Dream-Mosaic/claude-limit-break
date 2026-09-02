export type Sink = (line: string) => void;

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export function createLogger(name: string, sink: Sink): Logger {
  const write = (level: string, msg: string) => {
    sink(`${new Date().toISOString()} [${name}] ${level.padEnd(5)} ${msg}`);
  };
  return {
    info: (m) => write('INFO', m),
    warn: (m) => write('WARN', m),
    error: (m) => write('ERROR', m),
  };
}
