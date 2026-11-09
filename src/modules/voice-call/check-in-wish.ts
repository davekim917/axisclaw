const ME = '(?:me|us)';

/**
 * Said by someone on the call, each of these turns the spoken check-ins off for the rest of the call. Every phrase
 * names the caller as the one being updated: "stop the updates" is as often about a dashboard or a deploy.
 */
const STOP_CHECK_IN_PHRASES: readonly RegExp[] = [
  new RegExp(`\\b(?:stop|quit) (?:updating|checking in with|checking in on) ${ME}\\b`, 'g'),
  new RegExp(`\\bstop (?:giving|sending) ${ME} (?:any )?(?:status )?updates\\b`, 'g'),
  new RegExp(`\\bno more (?:status )?updates for ${ME}\\b`, 'g'),
];

/** Said by someone on the call, each of these turns the spoken check-ins back on. */
const RESUME_CHECK_IN_PHRASES: readonly RegExp[] = [
  new RegExp(`\\bkeep ${ME} (?:posted|updated)\\b`, 'g'),
  new RegExp(`\\b(?:start|keep|resume) (?:updating|checking in with|checking in on) ${ME}\\b`, 'g'),
];

/** A word anywhere earlier in the same clause that makes the phrase something other than a request. */
const NOT_A_REQUEST_IN_CLAUSE =
  /\b(?:not|never|why|no need|[a-z]+n't|dont|didnt|doesnt|wont|wouldnt|shouldnt|cant|couldnt|isnt|arent)\b/;

const CLAUSE_BREAK = '|';

const normalize = (said: string) =>
  said
    .toLocaleLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[.?!,;:]+/g, ` ${CLAUSE_BREAK} `)
    .replace(/[^\p{L}\p{N}'| ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Whether what a caller has said so far asks for the spoken check-ins to stop ('off') or resume ('on'): the last such
 * request wins, and null when it asks neither. Every phrase names the caller, and a match stands whatever words follow
 * it, so a request is acted on before its turn ends.
 */
export function checkInWish(said: string): 'off' | 'on' | null {
  const text = normalize(said);
  let wish: 'off' | 'on' | null = null;
  let at = -1;
  for (const [phrases, meaning] of [
    [STOP_CHECK_IN_PHRASES, 'off'],
    [RESUME_CHECK_IN_PHRASES, 'on'],
  ] as const) {
    for (const phrase of phrases) {
      for (const match of text.matchAll(phrase)) {
        const before = text.slice(0, match.index);
        if (NOT_A_REQUEST_IN_CLAUSE.test(before.slice(before.lastIndexOf(CLAUSE_BREAK) + 1))) continue;
        if (match.index > at) {
          at = match.index;
          wish = meaning;
        }
      }
    }
  }
  return wish;
}
