import type { ContainerConfig } from '../../container-config.js';

// Three labels at least: that refuses a suffix like co.uk with no suffix list to go stale.
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){2,}[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The hosts whose session a takeover of `site` also hands over, from `browserSso` in container.json. A takeover with a
 * broken entry is refused rather than run narrower: the owner would sign in for a session the agent never gets.
 * Other sites are not judged, so a typo in one entry cannot change what an unlisted site does.
 */
export function browserSsoHosts(config: Pick<ContainerConfig, 'browserSso'>, site: string): string[] {
  const { browserSso } = config;
  if (browserSso === undefined) return [];
  if (browserSso === null || typeof browserSso !== 'object' || Array.isArray(browserSso)) {
    throw new Error('container.json browserSso must map a site name to a list of host names.');
  }
  if (!Object.hasOwn(browserSso, site)) return [];
  const hosts: unknown = browserSso[site];
  if (!Array.isArray(hosts)) throw new Error(`container.json browserSso["${site}"] must be a list of host names.`);
  for (const host of hosts) {
    if (typeof host !== 'string' || !HOST_RE.test(host)) {
      throw new Error(
        `container.json browserSso["${site}"]: ${JSON.stringify(host)} is not an exact lowercase host name of ` +
          'at least three labels.',
      );
    }
  }
  return [...new Set(hosts as string[])];
}

const lastTwoLabels = (host: string) => host.split('.').slice(-2).join('.');

/**
 * Refuses an unlisted takeover whose `hostname` could receive a provider's cookies, which it would otherwise file in the
 * shared directory under a name of the agent's choosing. A cookie scoped to a parent domain reaches every host below it,
 * and without a suffix list the last two labels are the only safe bound on that parent.
 */
export function refuseListedProvider(
  config: Pick<ContainerConfig, 'browserSso'>,
  extraHosts: readonly string[],
  hostname: string,
): void {
  if (extraHosts.length > 0) return;
  const browserSso: Record<string, unknown> = config.browserSso ?? {};
  const base = lastTwoLabels(hostname.replace(/\.+$/, ''));
  const covers = (hosts: unknown) =>
    Array.isArray(hosts) && hosts.some((listed) => typeof listed === 'string' && lastTwoLabels(listed) === base);
  const site = Object.keys(browserSso).find((key) => covers(browserSso[key]));
  if (site !== undefined) {
    throw new Error(`${hostname} shares a sign-in with --site ${site}. Use --site ${site} and the app's own URL.`);
  }
}
