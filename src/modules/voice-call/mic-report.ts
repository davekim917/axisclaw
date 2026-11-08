import { log } from '../../log.js';

const MIC_SETTINGS = ['echoCancellation', 'noiseSuppression', 'autoGainControl', 'voiceIsolation'] as const;
const BROWSERS = ['android-webview', 'android-chrome', 'ios-safari', 'ios-other', 'desktop', 'other'] as const;
export const MIC_REPORT_MAX_BYTES = 1024;

type MicSetting = (typeof MIC_SETTINGS)[number];
type MicReport = Partial<Record<MicSetting, boolean>> & { browser?: (typeof BROWSERS)[number] };

function browserKind(ua: string): string {
  if (/Android/.test(ua)) {
    if (/; wv\)/.test(ua)) return 'android-webview';
    return /Chrome\//.test(ua) && !/SamsungBrowser|EdgA|OPR\/|Firefox/.test(ua) ? 'android-chrome' : 'other';
  }
  if (/iPhone|iPad|iPod/.test(ua))
    return /Version\/[\d.]+ .*Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua) ? 'ios-safari' : 'ios-other';
  return /Windows|Macintosh|CrOS|X11|Linux/.test(ua) ? 'desktop' : 'other';
}

function pageMicReport(
  track: { getSettings(): Record<string, unknown> } | null | undefined,
  ua: string,
  keys: readonly string[],
): Record<string, boolean | string> {
  const report: Record<string, boolean | string> = { browser: browserKind(ua) };
  try {
    const settings = track ? track.getSettings() : {};
    for (const key of keys) if (typeof settings[key] === 'boolean') report[key] = settings[key];
  } catch {
    /* the browser kind alone is still worth reporting */
  }
  return report;
}

export const micReportPageScript = (): string =>
  `${browserKind.toString()}\n${pageMicReport.toString()}\nconst MIC_SETTINGS = ${JSON.stringify(MIC_SETTINGS)};`;

export function micReport(raw: unknown): MicReport {
  if (!raw || typeof raw !== 'object') return {};
  const given = raw as Record<string, unknown>;
  const report: MicReport = {};
  for (const key of MIC_SETTINGS) if (typeof given[key] === 'boolean') report[key] = given[key];
  if ((BROWSERS as readonly unknown[]).includes(given.browser)) report.browser = given.browser as MicReport['browser'];
  return report;
}

export function logMicReport(callId: string, body: string): void {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return;
  }
  const report = micReport(raw);
  if (Object.keys(report).length > 0) log.info('Voice call: microphone', { callId: callId.slice(0, 8), ...report });
}
