import chalk, { Chalk, type ChalkInstance } from 'chalk';
import ora, { type Ora } from 'ora';

export interface LoggerOptions {
  jsonMode: boolean;
  quiet: boolean;
  verbose: boolean;
  command: string;
}

export interface Logger {
  error(msg: string): void;
  warn(msg: string): void;
  info(msg: string): void;
  debug(msg: string): void;
  startSpinner(msg: string): void;
  stopSpinner(success?: boolean): void;
  updateSpinner(msg: string): void;
  progress(current: number, total: number, msg: string): void;
}

export class LoggerImpl implements Logger {
  private readonly options: LoggerOptions;
  private readonly chalk: ChalkInstance;
  private spinner: Ora | null = null;
  private readonly isTTY: boolean;
  private readonly isCI: boolean;
  private readonly useColor: boolean;

  constructor(options: LoggerOptions) {
    this.options = options;
    this.isTTY = Boolean(process.stdout.isTTY);
    this.isCI = Boolean(process.env['CI']);
    this.useColor = this.isTTY && !process.env['NO_COLOR'];

    this.chalk = this.useColor ? chalk : new Chalk({ level: 0 });
  }

  error(msg: string): void {
    const formatted = this.format('error', msg);
    process.stderr.write(formatted + '\n');
  }

  warn(msg: string): void {
    if (this.options.jsonMode) {
      // In JSON mode, warn+ goes to stderr
      const formatted = this.format('warn', msg);
      process.stderr.write(formatted + '\n');
      return;
    }
    if (this.options.quiet) return;
    const formatted = this.format('warn', msg);
    process.stderr.write(formatted + '\n');
  }

  info(msg: string): void {
    if (this.options.jsonMode) return;
    if (this.options.quiet) return;
    const formatted = this.format('info', msg);
    process.stdout.write(formatted + '\n');
  }

  debug(msg: string): void {
    if (this.options.jsonMode) return;
    if (!this.options.verbose) return;
    const formatted = this.format('debug', msg);
    process.stdout.write(formatted + '\n');
  }

  startSpinner(msg: string): void {
    if (!this.canUseSpinner()) return;
    this.spinner = ora({ text: msg, color: 'cyan' }).start();
  }

  stopSpinner(success = true): void {
    if (!this.spinner) return;
    if (success) {
      this.spinner.succeed();
    } else {
      this.spinner.fail();
    }
    this.spinner = null;
  }

  updateSpinner(msg: string): void {
    if (this.options.jsonMode) return;
    if (this.options.quiet) return;
    if (this.spinner) {
      this.spinner.text = msg;
    }
  }

  progress(current: number, total: number, msg: string): void {
    if (this.options.jsonMode) return;
    if (this.options.quiet) return;

    const percent = total > 0 ? Math.round((current / total) * 100) : 0;
    const progressMsg = `[${current}/${total}] ${percent}% ${msg}`;

    if (this.spinner) {
      this.spinner.text = progressMsg;
    } else {
      this.info(progressMsg);
    }
  }

  private canUseSpinner(): boolean {
    return this.isTTY && !this.options.jsonMode && !this.isCI;
  }

  private format(level: 'error' | 'warn' | 'info' | 'debug', msg: string): string {
    if (this.options.jsonMode) {
      // In JSON mode, just output the raw message (only error/warn reach here)
      return msg;
    }

    const prefix = this.options.command ? `[${this.options.command}] ` : '';

    switch (level) {
      case 'error':
        return `${prefix}${this.chalk.red('error')} ${msg}`;
      case 'warn':
        return `${prefix}${this.chalk.yellow('warn')} ${msg}`;
      case 'info':
        return `${prefix}${this.chalk.blue('info')} ${msg}`;
      case 'debug':
        return `${prefix}${this.chalk.gray('debug')} ${msg}`;
    }
  }
}

export function createLogger(options: Partial<LoggerOptions> = {}): Logger {
  return new LoggerImpl({
    jsonMode: options.jsonMode ?? false,
    quiet: options.quiet ?? false,
    verbose: options.verbose ?? false,
    command: options.command ?? '',
  });
}
