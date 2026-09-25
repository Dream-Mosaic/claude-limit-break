export interface Settings {
  enabled: boolean;
  autoResume: boolean;
  resumeMode: 'interactive' | 'headless';
  headlessPermissionMode: '' | 'default' | 'acceptEdits' | 'plan';
  claudeCommand: string;
  resumePrompt: string;
  maxResumeTokens: number;
  maxWaitHours: number;
  transcriptPollSeconds: number;
  randomDelayMinMinutes: number;
  randomDelayMaxMinutes: number;
  notify: boolean;
  alertSound: boolean;
  alertSoundFile: string;
  statusBar: 'always' | 'pending' | 'never';
  watchScope: 'machine' | 'workspace';
  checkForUpdates: boolean;
  onStale: 'notify' | 'reopen';
}

export interface ConfigSource {
  get<T>(key: string, fallback: T): T;
}

const RESUME_MODES = ['interactive', 'headless'] as const;
const PERMISSION_MODES = ['', 'default', 'acceptEdits', 'plan'] as const;
const STALE_ACTIONS = ['notify', 'reopen'] as const;
const STATUS_BAR_MODES = ['always', 'pending', 'never'] as const;
const WATCH_SCOPES = ['machine', 'workspace'] as const;

const oneOf = <T extends readonly string[]>(list: T, value: unknown, fallback: T[number]): T[number] =>
  (list as readonly string[]).includes(value as string) ? (value as T[number]) : fallback;

const atLeast = (value: unknown, floor: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(floor, value) : fallback;

const str = (value: unknown, fallback: string): string =>
  typeof value === 'string' ? value : fallback;

export function readSettings(c: ConfigSource): Settings {
  return {
    enabled: c.get('enabled', true),
    autoResume: c.get('autoResume', true),
    resumeMode: oneOf(RESUME_MODES, c.get('resumeMode', 'interactive'), 'interactive'),
    headlessPermissionMode: oneOf(PERMISSION_MODES, c.get('headlessPermissionMode', ''), ''),
    claudeCommand: str(c.get('claudeCommand', ''), ''),
    resumePrompt: str(
      c.get('resumePrompt', '[Limit Break] I hit my usage limit while you were working, but it has reset now. Please continue from where you left off.'),
      '[Limit Break] I hit my usage limit while you were working, but it has reset now. Please continue from where you left off.',
    ),
    maxResumeTokens: atLeast(c.get('maxResumeTokens', 500_000), 0, 500_000),
    maxWaitHours: atLeast(c.get('maxWaitHours', 24), 1, 24),
    transcriptPollSeconds: atLeast(c.get('transcriptPollSeconds', 5), 1, 5),
    randomDelayMinMinutes: atLeast(c.get('randomDelayMinMinutes', 5), 0, 5),
    randomDelayMaxMinutes: atLeast(c.get('randomDelayMaxMinutes', 30), 0, 30),
    notify: c.get('notify', true),
    alertSound: c.get('alertSound', true),
    alertSoundFile: str(c.get('alertSoundFile', ''), ''),
    onStale: oneOf(STALE_ACTIONS, c.get('onStale', 'notify'), 'notify'),
    statusBar: oneOf(STATUS_BAR_MODES, c.get('statusBar', 'always'), 'always'),
    watchScope: oneOf(WATCH_SCOPES, c.get('watchScope', 'machine'), 'machine'),
    checkForUpdates: c.get('checkForUpdates', false),
  };
}
