import type * as vscode from 'vscode';

let logChannel: vscode.LogOutputChannel | null = null;

export function initLogger(channel?: vscode.LogOutputChannel): vscode.LogOutputChannel | null {
  if (channel) {
    logChannel = channel;
  }
  return logChannel;
}

export function disposeLogger(): void {
  if (logChannel) {
    logChannel.dispose();
    logChannel = null;
  }
}

export function extLog(
  level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG',
  message: string,
  data?: any
): void {
  let formattedData = '';
  if (data !== undefined) {
    try {
      formattedData = ' ' + (typeof data === 'string' ? data : JSON.stringify(data));
    } catch {
      formattedData = ' [Unstringifiable data]';
    }
  }

  const logMessage = `${message}${formattedData}`;

  if (logChannel) {
    switch (level) {
      case 'ERROR':
        logChannel.error(logMessage);
        break;
      case 'WARN':
        logChannel.warn(logMessage);
        break;
      case 'DEBUG':
        logChannel.debug(logMessage);
        break;
      case 'INFO':
      default:
        logChannel.info(logMessage);
        break;
    }
  } else {
    // Fallback to console if channel not initialized (e.g. in test runner)
    const line = `[${new Date().toISOString()}] [${level}] ${logMessage}`;
    if (level === 'ERROR') {
      console.error(line);
    } else if (level === 'WARN') {
      console.warn(line);
    } else if (level === 'DEBUG') {
      console.debug(line);
    } else {
      console.log(line);
    }
  }
}

