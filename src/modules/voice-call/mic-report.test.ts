import { describe, expect, it } from 'vitest';

import { micReport, micReportPageScript } from './mic-report.js';

const onPage = new Function(
  'track',
  'ua',
  `${micReportPageScript()}\nreturn pageMicReport(track, ua, MIC_SETTINGS);`,
) as (track: unknown, ua: string) => Record<string, unknown>;

const UA = {
  androidWebView:
    'Mozilla/5.0 (Linux; Android 14; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  androidSamsung:
    'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
  iosSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  iosChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1',
  iosInApp:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  desktop:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  unknown: 'ExampleBot/1.0',
};

describe('the call page’s microphone report, run from the source the page embeds', () => {
  it.each([
    ['androidWebView', 'android-webview'],
    ['androidChrome', 'android-chrome'],
    ['androidSamsung', 'other'],
    ['iosSafari', 'ios-safari'],
    ['iosChrome', 'ios-other'],
    ['iosInApp', 'ios-other'],
    ['desktop', 'desktop'],
    ['unknown', 'other'],
  ] as const)('names the %s user agent %s and sends nothing of the agent string itself', (name, browser) => {
    expect(onPage(null, UA[name])).toEqual({ browser });
  });

  it('sends only the boolean settings it was asked for, leaving out what the browser omits', () => {
    const track = {
      getSettings: () => ({
        echoCancellation: false,
        noiseSuppression: true,
        deviceId: 'device-0f3a',
        groupId: 'group-77c1',
        label: 'Example Headset Mic',
        sampleRate: 48000,
      }),
    };
    expect(onPage(track, UA.androidWebView)).toEqual({
      browser: 'android-webview',
      echoCancellation: false,
      noiseSuppression: true,
    });
  });

  it('still reports the browser when reading the settings throws', () => {
    const track = {
      getSettings: () => {
        throw new Error('not supported');
      },
    };
    expect(onPage(track, UA.desktop)).toEqual({ browser: 'desktop' });
  });
});

describe('micReport', () => {
  it('keeps the known boolean settings and a known browser, dropping every other key and type', () => {
    expect(
      micReport({
        echoCancellation: true,
        noiseSuppression: 'true',
        autoGainControl: 0,
        voiceIsolation: false,
        browser: 'android-webview',
        userAgent: 'Mozilla/5.0 (Linux; Android 14; K; wv)',
        label: 'Example Headset Mic',
      }),
    ).toEqual({ echoCancellation: true, voiceIsolation: false, browser: 'android-webview' });
  });

  it.each([['firefox'], ['Android-WebView'], [true], [null]])('drops a browser outside the enum: %s', (browser) => {
    expect(micReport({ autoGainControl: true, browser })).toEqual({ autoGainControl: true });
  });

  it.each([[null], ['echoCancellation'], [42]])('reads nothing from a body that is not an object: %s', (raw) => {
    expect(micReport(raw)).toEqual({});
  });
});
