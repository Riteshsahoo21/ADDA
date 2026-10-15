const { execFileSync } = require('node:child_process');

try {
  const devices = execFileSync('adb', ['devices'], { encoding: 'utf8', timeout: 5000 });
  if (!/^\S+\s+device\s*$/m.test(devices)) {
    console.log('[ADDA USB] No authorized Android device. Connect the phone and approve USB debugging.');
    process.exit(0);
  }
  execFileSync('adb', ['reverse', 'tcp:8081', 'tcp:8081'], { stdio: 'inherit', timeout: 5000 });
  execFileSync('adb', ['reverse', 'tcp:3000', 'tcp:3000'], { stdio: 'inherit', timeout: 5000 });
  console.log('[ADDA USB] Metro port 8081 and Auth port 3000 are forwarded over USB.');
} catch (error) {
  console.log('[ADDA USB] Could not run adb reverse. Run `adb devices` and `adb reverse tcp:8081 tcp:8081` manually.');
}
