export type AvatarBody = 'man' | 'uncle' | 'photo_boy' | 'self' | 'woman' | 'chinese_woman' | 'nepali_woman' | 'white_top_woman';

export type AvatarStyle = { body: AvatarBody };

export const DEFAULT_AVATAR_STYLE: AvatarStyle = { body: 'man' };

export const AVATAR_NAMES: Record<AvatarBody, string> = {
  man: 'Kabir',
  uncle: 'Rajesh',
  photo_boy: 'Aryan',
  self: 'Aditya',
  woman: 'Ananya',
  chinese_woman: 'Mei',
  nepali_woman: 'Tara',
  white_top_woman: 'Zara',
};

export const AVATAR_TAGLINES: Record<AvatarBody, string> = {
  man: 'Authentic Casual',
  uncle: 'Everyday Classic',
  photo_boy: 'Smart Casual',
  self: 'Urban Sleek',
  woman: 'Black Denim',
  chinese_woman: 'Modern Streetwear',
  nepali_woman: 'Traditional Red',
  white_top_woman: 'Minimal Chic',
};
