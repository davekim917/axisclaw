import { isChannelVariant } from '../../types.js';
import { APPROVAL_RESOLUTION_MAX_UNITS } from './primitive.js';

/**
 * The longest message each platform shows whole: Discord's 1900 units, and Slack's Block Kit section cap of 3000 less
 * the adapter's headroom. Copied from the adapters' maxTextLength because adapters are skill-installed and may be
 * absent. A platform not listed gets Discord's, the smallest.
 */
export const PLATFORM_TEXT_MAX: Record<string, number> = { discord: 1900, slack: 2800 };

/** Release cards have always had this on Discord. An answer line over 100 units cuts the end of the body there. */
const DISCORD_CARD_TEXT_MAX = 1800;
/** The resolved edit, `title\n\nquestion\n\n<resolution line>`, drops the bold markers and fits Slack's limit. */
const SLACK_CARD_TEXT_MAX = PLATFORM_TEXT_MAX.slack - APPROVAL_RESOLUTION_MAX_UNITS - '\n\n'.length + '****'.length;
/**
 * Slack's outbound transform runs after the bridge measures an edit, and turns `#name` into a `[#name](<workspace
 * url>/archives/<id>)` link and `@name` into `<@<user id>>`. With a 21-character workspace subdomain on an enterprise
 * domain, a link grows by about 75 units.
 */
const SLACK_LINK_GROWTH = 80;
const SLACK_LINKABLE_RE = /(?<!\w)[#@]/g;

function isSlack(channelType: string | null | undefined): boolean {
  return !!channelType && (channelType === 'slack' || isChannelVariant(channelType, 'slack'));
}

/** The longest card, measured as posted (`**title**\n\nquestion`), a channel type shows whole. Unknown: Discord's. */
export function cardTextBudget(channelType: string | null | undefined): number {
  return isSlack(channelType) ? SLACK_CARD_TEXT_MAX : DISCORD_CARD_TEXT_MAX;
}

/** How many units a card is over what the channel type shows whole, including once resolved on Slack; ≤ 0 fits. */
export function cardOverrun(channelType: string | null | undefined, title: string, question: string): number {
  const posted = `**${title}**\n\n${question}`;
  const growth = isSlack(channelType) ? (posted.match(SLACK_LINKABLE_RE)?.length ?? 0) * SLACK_LINK_GROWTH : 0;
  return posted.length + growth - cardTextBudget(channelType);
}
