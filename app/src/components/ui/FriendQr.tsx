import { useMemo } from 'react';
import QRCode from 'qrcode';
import Svg, { Path } from 'react-native-svg';
import { colors } from '@/constants/theme';

export function FriendQr({ code, size = 230 }: { code: string; size?: number }) {
  const qr = useMemo(() => {
    const modules = QRCode.create(`adda:friend:v1:${code}`, { errorCorrectionLevel: 'M' }).modules;
    const path: string[] = [];
    for (let y = 0; y < modules.size; y++) {
      for (let x = 0; x < modules.size; x++) {
        if (modules.get(x, y)) path.push(`M${x + 4} ${y + 4}h1v1h-1z`);
      }
    }
    return { path: path.join(''), extent: modules.size + 8 };
  }, [code]);
  return <Svg width={size} height={size} viewBox={`0 0 ${qr.extent} ${qr.extent}`}>
    <Path d={qr.path} fill={colors.primaryDark} />
  </Svg>;
}
