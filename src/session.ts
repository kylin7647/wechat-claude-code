import { loadJson, saveJson } from './store.js';
import { join } from 'path';
import { mkdirSync } from 'fs';

const DATA_DIR = process.env.WCC_DATA_DIR || join(process.env.HOME!, '.wechat-claude-code');
const SESSIONS_DIR = join(DATA_DIR, 'sessions');

export type SessionState = 'idle' | 'processing' | 'waiting_permission';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface Session {
  sdkSessionId?: string;
  workingDirectory: string;
  model?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'auto';
  state: SessionState;
  chatHistory: ChatMessage[];
  maxHistoryLength?: number;
}

export interface PendingPermission {
  toolName: string;
  toolInput: string;
  resolve: (allowed: boolean) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_MAX_HISTORY = 100;

export function createSessionStore() {
  function getSessionPath(accountId: string): string {
    return join(SESSIONS_DIR, `${accountId}.json`);
  }

  function load(accountId: string, globalWorkingDirectory?: string): Session {
    const session = loadJson<Session>(getSessionPath(accountId), {
      workingDirectory: globalWorkingDirectory || process.cwd(),
      state: 'idle',
      chatHistory: [],
      maxHistoryLength: DEFAULT_MAX_HISTORY,
    });

    // If session has no working directory set, use global config
    if (!session.workingDirectory && globalWorkingDirectory) {
      session.workingDirectory = globalWorkingDirectory;
    }

    // Ensure chatHistory exists for backward compatibility
    if (!session.chatHistory) {
      session.chatHistory = [];
    }

    // Set default max history length if not set
    if (!session.maxHistoryLength) {
      session.maxHistoryLength = DEFAULT_MAX_HISTORY;
    }

    return session;
  }

  function save(accountId: string, session: Session): void {
    mkdirSync(SESSIONS_DIR, { recursive: true });

    // Trim chat history if it exceeds max length
    if (session.chatHistory.length > (session.maxHistoryLength || DEFAULT_MAX_HISTORY)) {
      session.chatHistory = session.chatHistory.slice(-(session.maxHistoryLength || DEFAULT_MAX_HISTORY));
    }

    saveJson(getSessionPath(accountId), session);
  }

  function clear(accountId: string, currentSession?: Session, globalWorkingDirectory?: string): Session {
    const session: Session = {
      workingDirectory: currentSession?.workingDirectory ?? globalWorkingDirectory ?? process.cwd(),
      model: currentSession?.model,
      permissionMode: currentSession?.permissionMode,
      state: 'idle',
      chatHistory: [],
      maxHistoryLength: currentSession?.maxHistoryLength || DEFAULT_MAX_HISTORY,
    };
    save(accountId, session);
    return session;
  }

  function addChatMessage(session: Session, role: 'user' | 'assistant', content: string): void {
    if (!session.chatHistory) {
      session.chatHistory = [];
    }
    session.chatHistory.push({
      role,
      content,
      timestamp: Date.now(),
    });

    // Trim if exceeds max length
    const maxLength = session.maxHistoryLength || DEFAULT_MAX_HISTORY;
    if (session.chatHistory.length > maxLength) {
      session.chatHistory = session.chatHistory.slice(-maxLength);
    }
  }

  function getChatHistoryText(session: Session, limit?: number): string {
    const history = session.chatHistory || [];
    const messages = limit ? history.slice(-limit) : history;

    if (messages.length === 0) {
      return '暂无对话记录';
    }

    const lines: string[] = [];
    for (const msg of messages) {
      const time = new Date(msg.timestamp).toLocaleString('zh-CN');
      const role = msg.role === 'user' ? '用户' : 'Claude';
      lines.push(`[${time}] ${role}:`);
      lines.push(msg.content);
      lines.push('');
    }

    return lines.join('\n');
  }

  return { load, save, clear, addChatMessage, getChatHistoryText };
}
