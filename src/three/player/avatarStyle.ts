export type AvatarBody = 'man' | 'uncle' | 'photo_boy' | 'self' | 'woman' | 'chinese_woman' | 'nepali_woman' | 'white_top_woman';

export type AvatarStyle = { body: AvatarBody };

export const DEFAULT_AVATAR_STYLE: AvatarStyle = { body: 'man' };
