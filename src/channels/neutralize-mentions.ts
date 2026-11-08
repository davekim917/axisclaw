/**
 * For text that names someone without addressing them. The outbound mention rewriters cannot tell "@Name" in prose from
 * a live address, so a zero-width space after `@` (and after `<` for Slack `<!here>`/`<!subteam^…>`, Discord `<@&role>`)
 * breaks every rewriter while rendering identically.
 */
export const neutralizeMentions = (text: string): string =>
  text.replace(/@(?=[\w\p{L}])/gu, '@\u200b').replace(/<(?=[!@])/g, '<\u200b');
