import fs from 'node:fs';
import path from 'node:path';

/**
 * Log em arquivo com rotacao. A escrita e sincrona de proposito: ela so
 * acontece em erro/excecao, e nesse momento o evento ja se perdeu se a
 * gravacao falhar. Nunca lanca — um log quebrado nao pode derrubar o app.
 */
export function openLog(filePath, { maxBytes = 1_000_000, now = () => new Date(), keep = 1 } = {}) {
  const rotate = () => {
    let size;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      return;
    }
    if (size < maxBytes) return;
    try {
      for (let i = keep; i > 1; i -= 1) {
        try {
          fs.renameSync(`${filePath}.${i - 1}`, `${filePath}.${i}`);
        } catch {
          /* ainda nao existe */
        }
      }
      fs.renameSync(filePath, `${filePath}.1`);
    } catch {
      /* se nao der para rotacionar, o append segue no arquivo atual */
    }
  };

  const write = (level, message) => {
    const text = typeof message === 'string' ? message : String(message);
    const line = `${now().toISOString()} [${level}] ${text}\n`;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      rotate();
      fs.appendFileSync(filePath, line, 'utf8');
    } catch {
      /* sem log: segue o jogo */
    }
  };

  return {
    file: filePath,
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
    exception: (label, err) => write('error', `${label}: ${err?.stack ?? err}`),
  };
}

/** Achata os argumentos de console.* numa linha (Error vira stack). */
export function formatArgs(args) {
  return (args ?? [])
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      if (arg instanceof Error) return arg.stack ?? String(arg);
      if (arg && typeof arg === 'object') {
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      }
      return String(arg);
    })
    .join(' ');
}
