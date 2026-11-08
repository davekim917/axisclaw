/**
 * A core whose verdict binds a draft but which exports no way to re-read it: the hook must refuse the approved send
 * rather than send a draft it cannot confirm.
 */
export function evaluateEmailSend(): { action: 'gate'; label: string; summary: string; draft: unknown } {
  return {
    action: 'gate',
    label: 'NO-CHECK email label',
    summary: 'NO-CHECK email summary',
    draft: { draftId: 'r-stub-draft', messageId: 'm-shown', userId: 'me', credentialsFile: '/x.json' },
  };
}
