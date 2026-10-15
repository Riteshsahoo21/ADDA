import { AvatarStyle } from './avatarStyle';
import { loadBundledGlb } from '@/three/loaders/loadBundledGlb';

/** Static requires let Metro package all offline avatars for Android. */
export function loadAvatar(style: AvatarStyle) {
  if (style.body === 'white_top_woman') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return loadBundledGlb(require('../../../assets/models/avatar-white-top-woman.glb'), {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      moduleId: require('../../../assets/textures/avatar-white-top-woman.rgba'),
      images: require('../../../assets/textures/avatar-white-top-woman.json'),
    });
  }
  if (style.body === 'nepali_woman') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return loadBundledGlb(require('../../../assets/models/avatar-nepali-woman.glb'), {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      moduleId: require('../../../assets/textures/avatar-nepali-woman.rgba'),
      images: require('../../../assets/textures/avatar-nepali-woman.json'),
    });
  }
  if (style.body === 'chinese_woman') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return loadBundledGlb(require('../../../assets/models/avatar-chinese-woman.glb'), {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      moduleId: require('../../../assets/textures/avatar-chinese-woman.rgba'),
      images: require('../../../assets/textures/avatar-chinese-woman.json'),
    });
  }
  if (style.body === 'woman') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return loadBundledGlb(require('../../../assets/models/avatar-woman.glb'), {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      moduleId: require('../../../assets/textures/avatar-woman.rgba'),
      images: require('../../../assets/textures/avatar-woman.json'),
    });
  }
  if (style.body === 'self') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return loadBundledGlb(require('../../../assets/models/avatar-self.glb'), {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      moduleId: require('../../../assets/textures/avatar-self.rgba'),
      images: require('../../../assets/textures/avatar-self.json'),
    });
  }
  if (style.body === 'photo_boy') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return loadBundledGlb(require('../../../assets/models/avatar-photo-boy.glb'), {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      moduleId: require('../../../assets/textures/avatar-photo-boy.rgba'),
      images: require('../../../assets/textures/avatar-photo-boy.json'),
    });
  }
  if (style.body === 'uncle') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return loadBundledGlb(require('../../../assets/models/avatar-uncle.glb'), {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      moduleId: require('../../../assets/textures/avatar-uncle.rgba'),
      images: require('../../../assets/textures/avatar-uncle.json'),
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return loadBundledGlb(require('../../../assets/models/avatar-man.glb'), {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    moduleId: require('../../../assets/textures/avatar-man.rgba'),
    images: require('../../../assets/textures/avatar-man.json'),
  });
}

export function avatarScale() {
  return 1.0;
}
