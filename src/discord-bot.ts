export const isDiscordChannelType = (channelType: string): boolean =>
  channelType === 'discord' || channelType.startsWith('discord-');

export function discordBotTokenKey(channelType: string): string {
  if (channelType === 'discord') return 'DISCORD_BOT_TOKEN';
  return `DISCORD_BOT_TOKEN_${channelType.slice('discord-'.length).toUpperCase().replace(/-/g, '_')}`;
}

export const discordApiBase = (): string => process.env.DISCORD_API_URL || 'https://discord.com/api/v10';
