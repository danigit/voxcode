import * as vscode from 'vscode';
import { VoxCodeClient } from './bridge/client';
import { DictationStyle } from './bridge/protocol';
import { FocusTracker } from './focus/focusTracker';
import { GhostTextManager } from './decorations/ghostText';
import { TextDispatcher } from './injector/textDispatcher';
import { AutoSpacer } from './injector/autoSpacer';
import { ProcessSupervisor } from './supervisor/processSupervisor';
import { CudaManager } from './supervisor/cudaManager';
import { extLog, initLogger, disposeLogger } from './logger';

let supervisor: ProcessSupervisor | null = null;
let client: VoxCodeClient | null = null;
let statusBarItem: vscode.StatusBarItem | null = null;
let focusTracker: FocusTracker | null = null;
let ghostTextManager: GhostTextManager | null = null;
let extensionContext: vscode.ExtensionContext | null = null;

let isRecording = false;
let isLocalRecording = false;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extensionContext = context;
  // Initialize log channel
  const logChannel = vscode.window.createOutputChannel('VoxCode', { log: true });
  initLogger(logChannel);
  context.subscriptions.push(logChannel);

  extLog('INFO', 'VoxCode extension activate() called');
  console.log('[VoxCode] Activating VoxCode extension...');

  // Initialize focus tracker and ghost text decorator
  focusTracker = new FocusTracker();
  ghostTextManager = new GhostTextManager();

  // Create Status Bar Item
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  updateStatusBar('offline');
  statusBarItem.show();

  context.subscriptions.push(statusBarItem);
  context.subscriptions.push(focusTracker);
  context.subscriptions.push(ghostTextManager);

  // Initialize Process Supervisor
  supervisor = new ProcessSupervisor(context);
  context.subscriptions.push(supervisor);

  // Initialize Bridge Client
  const workspaceName = vscode.workspace.name || 'VSCode';
  client = new VoxCodeClient({
    workspaceName,
  });

  context.subscriptions.push({
    dispose: () => {
      client?.dispose();
    },
  });

  // Setup client event handlers
  setupClientEvents(context);

  // Register commands
  registerCommands(context);

  // Listen to configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration('voxcode.serverUrl')) {
        const voxConfig = vscode.workspace.getConfiguration('voxcode');
        const customUrl = voxConfig.get<string>('serverUrl');
        if (customUrl && supervisor?.getMode() === 'OFFLINE') {
          client?.updateConfig(
            customUrl,
            vscode.workspace.name || 'VSCode'
          );
        }
      }

      if (e.affectsConfiguration('voxcode.device')) {
        const voxConfig = vscode.workspace.getConfiguration('voxcode');
        const newDevice = voxConfig.get<string>('device', 'cpu');
        if (newDevice === 'cuda') {
          if (!CudaManager.isNvidiaGpuPresent()) {
            vscode.window.showInformationMessage(
              'VoxCode: No NVIDIA GPU / driver detected on this machine. CUDA acceleration requires an NVIDIA graphics card.'
            );
          } else if (!CudaManager.isCudaRuntimeInstalled(context)) {
            vscode.window
              .showInformationMessage(
                'VoxCode: NVIDIA GPU detected, but CUDA 12 runtime is required for GPU acceleration. Download and set up now?',
                'Download CUDA Runtime',
                'Keep Using CPU'
              )
              .then(async (action) => {
                if (action === 'Download CUDA Runtime') {
                  await vscode.commands.executeCommand('voxcode.installCudaRuntime');
                }
              });
          } else if (supervisor && supervisor.isRunning()) {
            await supervisor.restart();
          }
        } else if (supervisor && supervisor.isRunning()) {
          await supervisor.restart();
        }
      } else if (
        e.affectsConfiguration('voxcode.modelSize') ||
        e.affectsConfiguration('voxcode.computeType')
      ) {
        if (supervisor && supervisor.isRunning()) {
          await supervisor.restart();
        }
      }
    })
  );

  // Run Process Supervisor: Connect to running managed daemon or launch standalone daemon
  await startSupervisorAndClient();

  console.log('[VoxCode] VoxCode extension activated successfully.');
}

async function startSupervisorAndClient(): Promise<void> {
  if (!supervisor) {
    return;
  }

  if (!client || (client as any).isDisposed) {
    const workspaceName = vscode.workspace.name || 'VSCode';
    client = new VoxCodeClient({ workspaceName });
    if (extensionContext) {
      setupClientEvents(extensionContext);
    }
  }

  updateStatusBar('offline');
  try {
    const result = await supervisor.start();
    if (result.mode !== 'OFFLINE') {
      client.updateConfig(
        result.serverUrl,
        vscode.workspace.name || 'VSCode',
        result.token,
        'managed'
      );
      client.connect();
    } else {
      updateStatusBar('offline');
    }
  } catch (err: any) {
    extLog('ERROR', 'Failed to start daemon supervisor', { error: err.message });
    updateStatusBar('offline');
    const msg = err?.message || 'Failed to start daemon.';
    vscode.window.showErrorMessage(`VoxCode: ${msg}`, 'Show Logs').then((choice) => {
      if (choice === 'Show Logs') {
        supervisor?.showLogs();
      }
    });
  }
}

function setupClientEvents(context: vscode.ExtensionContext): void {
  if (!client) {
    return;
  }

  client.on('connectionChanged', ({ connected, authenticated }) => {
    extLog('INFO', 'Client connectionChanged', { connected, authenticated });
    vscode.commands.executeCommand(
      'setContext',
      'voxcode.connected',
      connected && authenticated
    );

    if (!connected || !authenticated) {
      supervisor?.handleClientDisconnect();
      updateStatusBar('offline');
      setRecordingState(false);
      ghostTextManager?.clear();

      // Check auto-start daemon configuration
      const voxConfig = vscode.workspace.getConfiguration('voxcode');
      const autoStart = voxConfig.get<boolean>('autoStartDaemon', false);
      if (autoStart && supervisor && !supervisor.isRunning()) {
        startSupervisorAndClient();
      }
    } else {
      updateStatusBar('ready');
      extLog('INFO', 'VoxCode Bridge ready and authenticated');
    }
  });

  let hasShownCudaWarning = false;

  client.on('authenticated', (version: string) => {
    extLog('INFO', `Handshake confirmed with daemon version ${version}`);
    console.log(`[VoxCode] Handshake confirmed with daemon version ${version}`);
    updateStatusBar('ready');
  });

  client.on('statusChanged', (state: string, metadata?: any) => {
    extLog('INFO', `statusChanged event received: ${state}`, metadata);

    if (metadata?.fallback_reason && !hasShownCudaWarning) {
      hasShownCudaWarning = true;
      vscode.window
        .showWarningMessage(
          `VoxCode: CUDA was requested, but initialization failed (${metadata.fallback_reason}). The engine fell back to CPU.`,
          'Download CUDA Runtime',
          'Show Logs'
        )
        .then(async (choice) => {
          if (choice === 'Download CUDA Runtime') {
            await vscode.commands.executeCommand('voxcode.installCudaRuntime');
          } else if (choice === 'Show Logs') {
            supervisor?.showLogs();
          }
        });
    }

    switch (state) {
      case 'idle':
        isLocalRecording = false;
        setRecordingState(false);
        ghostTextManager?.clear();
        if (client?.isAuthenticated) {
          updateStatusBar('ready', metadata);
        }
        break;

      case 'loading_model':
        isLocalRecording = false;
        setRecordingState(false);
        ghostTextManager?.clear();
        updateStatusBar('loading_model', metadata);
        break;

      case 'listening':
        // State transition to listening may occur via extension command OR via global Shift+Space!
        updateStatusBar('listening', metadata);
        if (isLocalRecording) {
          setRecordingState(true);
        } else {
          // External dictation; do NOT set voxcode.isRecording context to avoid hijacking Escape
          setRecordingState(false);
          if (vscode.window.state.focused) {
            focusTracker?.getOrSnapshot();
          }
        }
        break;

      case 'transcribing':
        isLocalRecording = false;
        setRecordingState(false);
        ghostTextManager?.clear();
        updateStatusBar('transcribing', metadata);
        break;

      case 'error':
        isLocalRecording = false;
        setRecordingState(false);
        ghostTextManager?.clear();
        updateStatusBar('error', metadata);
        break;
    }
  });

  client.on('partialTranscript', (text: string, clientId?: string | null) => {
    // If broadcast without clientId, only show if window is focused
    if (!clientId && !vscode.window.state.focused) {
      return;
    }
    const snapshot = focusTracker?.getOrSnapshot();
    if (snapshot?.kind === 'terminal') {
      ghostTextManager?.clear();
      return;
    }
    if (snapshot?.kind === 'editor') {
      ghostTextManager?.update(text, snapshot.editor, snapshot.selections);
    } else {
      ghostTextManager?.update(text);
    }
  });

  client.on('transcript', async (event) => {
    // 1. Multi-window broadcast check
    if (event.client_id && event.client_id !== client?.clientId) {
      extLog('DEBUG', 'Ignoring transcript event targeted to another client', {
        targetClient: event.client_id,
        currentClient: client?.clientId,
      });
      return;
    }

    if (!event.client_id && !vscode.window.state.focused) {
      extLog('INFO', 'Ignoring broadcast transcript event because window is not focused');
      ghostTextManager?.clear();
      isLocalRecording = false;
      setRecordingState(false);
      focusTracker?.clearSnapshot();
      return;
    }

    // 2. Sanitize logging: string length at INFO, full text at DEBUG
    extLog('INFO', 'Transcript event received from daemon', {
      textLength: event.text ? event.text.length : 0,
      handled_by_daemon: event.handled_by_daemon,
      source: event.source,
      client_id: event.client_id,
    });
    extLog('DEBUG', 'Transcript event text', { text: event.text });

    ghostTextManager?.clear();
    isLocalRecording = false;
    setRecordingState(false);
    updateStatusBar('ready');

    // Only inject if not already handled by daemon Win32 typing
    if (!event.handled_by_daemon) {
      const snapshot = focusTracker?.getOrSnapshot() || { kind: 'none' };
      extLog('INFO', 'Dispatching transcript to target', {
        snapshotKind: snapshot.kind,
      });
      const success = await TextDispatcher.dispatch(event.text, snapshot);
      extLog('INFO', 'TextDispatcher.dispatch result', { success });
    } else {
      extLog('INFO', 'Transcript marked as handled_by_daemon, skipping extension injection');
    }

    focusTracker?.clearSnapshot();
  });

  client.on('daemonError', (code: string, message: string) => {
    console.error(`[VoxCode] Daemon error [${code}]:`, message);
    ghostTextManager?.clear();
    isLocalRecording = false;
    setRecordingState(false);
    if (code === 'MODEL_LOADING') {
      updateStatusBar('loading_model');
      vscode.window.showInformationMessage(`VoxCode: ${message}`);
      return;
    }
    updateStatusBar('error');
    vscode.window.showErrorMessage(`VoxCode Error (${code}): ${message}`);
  });
}

function registerCommands(context: vscode.ExtensionContext): void {
  // 1. Toggle Dictation (Ctrl+Alt+V)
  const toggleHandler = (args?: { target?: 'editor' | 'terminal' }) => {
    if (args?.target === 'terminal') {
      focusTracker?.markTerminalFocused();
    } else if (args?.target === 'editor') {
      focusTracker?.markEditorFocused();
    }

    if (isRecording) {
      stopRecording();
    } else {
      startRecording(args?.target);
    }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('voxcode.toggleDictation', toggleHandler)
  );

  // 2. Start Dictation
  const startHandler = (args?: { target?: 'editor' | 'terminal' }) => {
    if (args?.target === 'terminal') {
      focusTracker?.markTerminalFocused();
    } else if (args?.target === 'editor') {
      focusTracker?.markEditorFocused();
    }
    startRecording(args?.target);
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('voxcode.startRecording', startHandler)
  );

  // 3. Stop Dictation
  const stopHandler = () => {
    stopRecording();
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('voxcode.stopRecording', stopHandler)
  );

  // 4. Cancel Dictation (Escape)
  const cancelHandler = () => {
    cancelDictation();
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('voxcode.cancelDictation', cancelHandler)
  );

  // 5. Start Daemon
  const startDaemonHandler = async () => {
    vscode.window.showInformationMessage('Starting VoxCode daemon...');
    await startSupervisorAndClient();
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('voxcode.startDaemon', startDaemonHandler)
  );

  // 6. Restart Daemon
  const restartDaemonHandler = async () => {
    vscode.window.showInformationMessage('Restarting VoxCode daemon...');
    try {
      updateStatusBar('offline');
      client?.dispose();
      const result = await supervisor?.restart();
      if (result && result.mode !== 'OFFLINE') {
        client = new VoxCodeClient({
          workspaceName: vscode.workspace.name || 'VSCode',
        });
        setupClientEvents(context);
        client.updateConfig(
          result.serverUrl,
          vscode.workspace.name || 'VSCode',
          result.token,
          'managed'
        );
        client.connect();
      } else {
        updateStatusBar('offline');
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to restart daemon: ${err.message}`);
      updateStatusBar('offline');
    }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('voxcode.restartDaemon', restartDaemonHandler)
  );

  // 7. Show Daemon Logs
  const showLogsHandler = () => {
    supervisor?.showLogs();
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('voxcode.showDaemonLogs', showLogsHandler)
  );

  // 8. Reconnect to Bridge
  const reconnectHandler = () => {
    vscode.window.showInformationMessage('Reconnecting to VoxCode Bridge...');
    client?.reconnect();
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('voxcode.reconnect', reconnectHandler)
  );

  // 9. Configure Keyboard Shortcut
  const configKeybindingHandler = () => {
    vscode.commands.executeCommand(
      'workbench.action.openGlobalKeybindings',
      'voxcode.toggleDictation'
    );
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('voxcode.configureKeybinding', configKeybindingHandler)
  );

  // 10. Handle Error
  const errorHandler = async () => {
    const choice = await vscode.window.showErrorMessage(
      'VoxCode daemon encountered an issue initializing or running.',
      'Restart Daemon',
      'Show Logs'
    );
    if (choice === 'Restart Daemon') {
      vscode.commands.executeCommand('voxcode.restartDaemon');
    } else if (choice === 'Show Logs') {
      vscode.commands.executeCommand('voxcode.showDaemonLogs');
    }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('voxcode.handleError', errorHandler)
  );

  // 11. Install NVIDIA CUDA Runtime
  const installCudaHandler = async () => {
    if (!CudaManager.isNvidiaGpuPresent()) {
      const proceed = await vscode.window.showWarningMessage(
        'VoxCode: No NVIDIA GPU / driver was detected on this machine. CUDA acceleration requires an NVIDIA graphics card. Do you still want to proceed with downloading CUDA runtime?',
        'Yes, Download Anyway',
        'Cancel'
      );
      if (proceed !== 'Yes, Download Anyway') {
        return;
      }
    }
    await CudaManager.installCudaRuntime(context, supervisor || undefined);
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('voxcode.installCudaRuntime', installCudaHandler)
  );
}

function startRecording(targetHint?: 'editor' | 'terminal'): void {
  if (!client || !client.isAuthenticated) {
    vscode.window
      .showWarningMessage(
        'VoxCode daemon is offline.',
        'Start Daemon',
        'Reconnect'
      )
      .then((selection) => {
        if (selection === 'Start Daemon') {
          vscode.commands.executeCommand('voxcode.startDaemon');
        } else if (selection === 'Reconnect') {
          vscode.commands.executeCommand('voxcode.reconnect');
        }
      });
    return;
  }

  // Snapshot active editor / terminal focus and cursor selections
  const snapshot = focusTracker?.snapshot(targetHint) || { kind: 'none' };
  if (snapshot.kind === 'none') {
    console.warn('[VoxCode] No active editor or terminal in focus to record for.');
  } else if (snapshot.kind === 'terminal') {
    // Clear any editor ghost text immediately when terminal is targeted
    ghostTextManager?.clear();
  }

  // Determine code vs prose style
  const voxConfig = vscode.workspace.getConfiguration('voxcode');
  const codeMode = voxConfig.get<boolean>('codeMode', true);
  let style: DictationStyle = 'code';

  if (snapshot.kind === 'editor') {
    const isCode = AutoSpacer.isCodeDocument(snapshot.editor.document, codeMode);
    style = isCode ? 'code' : 'prose';
  } else if (snapshot.kind === 'terminal') {
    style = 'code';
  }

  isLocalRecording = true;
  setRecordingState(true);
  updateStatusBar('listening');
  client.startRecording(style);
}

function stopRecording(): void {
  if (!client) {
    return;
  }
  isLocalRecording = false;
  setRecordingState(false);
  updateStatusBar('transcribing');
  client.stopRecording();
}

function cancelDictation(): void {
  if (!client) {
    return;
  }
  isLocalRecording = false;
  setRecordingState(false);
  ghostTextManager?.clear();
  focusTracker?.clearSnapshot();
  updateStatusBar(client.isAuthenticated ? 'ready' : 'offline');
  client.cancelRecording();
}

function setRecordingState(recording: boolean): void {
  isRecording = recording;
  vscode.commands.executeCommand(
    'setContext',
    'voxcode.isRecording',
    recording
  );
}

type StatusBarState = 'offline' | 'loading_model' | 'ready' | 'listening' | 'transcribing' | 'error';

interface StatusMetadata {
  device?: string;
  compute_type?: string;
  model?: string;
  fallback_reason?: string | null;
}

let lastStatusMetadata: StatusMetadata = {};

function updateStatusBar(state: StatusBarState, metadata?: StatusMetadata): void {
  if (!statusBarItem) {
    return;
  }

  if (metadata) {
    lastStatusMetadata = { ...lastStatusMetadata, ...metadata };
  }

  const dev = lastStatusMetadata.device || client?.activeDevice;
  const isCuda = dev === 'cuda';
  const hasFallback = Boolean(lastStatusMetadata.fallback_reason || client?.cudaFallbackReason);
  const model = lastStatusMetadata.model || client?.activeModel;
  const hotkey = process.platform === 'darwin' ? 'Cmd+Option+V' : 'Ctrl+Alt+V';

  switch (state) {
    case 'offline':
      statusBarItem.text = '$(mic-off) VoxCode: Offline';
      statusBarItem.tooltip =
        'VoxCode Daemon is offline. Click to launch daemon.';
      statusBarItem.command = 'voxcode.startDaemon';
      statusBarItem.backgroundColor = undefined;
      break;

    case 'loading_model':
      statusBarItem.text = '$(sync~spin) VoxCode: Loading Model...';
      statusBarItem.tooltip =
        'VoxCode is downloading and initializing the speech model (one-time setup). Click to view logs.';
      statusBarItem.command = 'voxcode.showDaemonLogs';
      statusBarItem.backgroundColor = undefined;
      break;

    case 'ready':
      if (hasFallback) {
        statusBarItem.text = '$(mic) VoxCode: Ready (CPU Fallback)';
        statusBarItem.tooltip =
          `VoxCode Ready on CPU (${model || 'model'}).\nWarning: CUDA failed (${lastStatusMetadata.fallback_reason || client?.cudaFallbackReason}). Click to start dictation (${hotkey}).`;
      } else if (isCuda) {
        statusBarItem.text = '$(mic) VoxCode: Ready (CUDA)';
        statusBarItem.tooltip =
          `VoxCode Ready on NVIDIA GPU (${model || 'model'} / ${lastStatusMetadata.compute_type || client?.activeComputeType || 'float16'}). Click to start dictation (${hotkey}).`;
      } else {
        statusBarItem.text = '$(mic) VoxCode: Ready (CPU)';
        statusBarItem.tooltip =
          `VoxCode Ready on CPU (${model || 'model'} / ${lastStatusMetadata.compute_type || client?.activeComputeType || 'int8'}). Click to start dictation (${hotkey}).`;
      }
      statusBarItem.command = 'voxcode.toggleDictation';
      statusBarItem.backgroundColor = undefined;
      break;

    case 'listening':
      statusBarItem.text = '$(record) VoxCode: Listening...';
      statusBarItem.tooltip = 'VoxCode is listening. Click to finish speech.';
      statusBarItem.command = 'voxcode.stopRecording';
      statusBarItem.backgroundColor = new vscode.ThemeColor(
        'statusBarItem.warningBackground'
      );
      break;

    case 'transcribing':
      const transDev = isCuda ? 'GPU' : 'CPU';
      statusBarItem.text = `$(loading~spin) VoxCode: Transcribing (${transDev})...`;
      statusBarItem.tooltip = `Whisper speech-to-text inference in progress on ${transDev}...`;
      statusBarItem.command = undefined;
      statusBarItem.backgroundColor = undefined;
      break;

    case 'error':
      statusBarItem.text = '$(error) VoxCode: Error';
      statusBarItem.tooltip = 'VoxCode encountered an error. Click for diagnosis and restart options.';
      statusBarItem.command = 'voxcode.handleError';
      statusBarItem.backgroundColor = new vscode.ThemeColor(
        'statusBarItem.errorBackground'
      );
      break;
  }
}

export function deactivate(): void {
  ghostTextManager?.dispose();
  focusTracker?.dispose();
  client?.dispose();
  supervisor?.dispose();
  statusBarItem?.dispose();
  disposeLogger();
}
