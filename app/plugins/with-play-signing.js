const { withAppBuildGradle } = require('@expo/config-plugins');

// Keep release signing in generated native projects after Expo prebuild.
function patchGradle(input) {
    let source = input;
    if (source.includes('ADDA_UPLOAD_STORE_FILE')) return source;
    const debugConfig = `        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }`;
    if (!source.includes(debugConfig)) throw new Error('Cannot locate Android debug signing config');
    source = source.replace(debugConfig, `${debugConfig}
        release {
            def uploadStore = System.getenv('ADDA_UPLOAD_STORE_FILE')
            def uploadStorePassword = System.getenv('ADDA_UPLOAD_STORE_PASSWORD')
            def uploadKeyAlias = System.getenv('ADDA_UPLOAD_KEY_ALIAS')
            def uploadKeyPassword = System.getenv('ADDA_UPLOAD_KEY_PASSWORD')
            if (uploadStore) storeFile file(uploadStore)
            if (uploadStorePassword) storePassword uploadStorePassword
            if (uploadKeyAlias) keyAlias uploadKeyAlias
            if (uploadKeyPassword) keyPassword uploadKeyPassword
        }`);
    const releaseStart = source.indexOf('        release {', source.indexOf('    buildTypes {'));
    const debugSigning = source.indexOf('signingConfig signingConfigs.debug', releaseStart);
    if (releaseStart < 0 || debugSigning < 0) throw new Error('Cannot locate Android release signing config');
    source = source.slice(0, debugSigning) + source.slice(debugSigning).replace(
      'signingConfig signingConfigs.debug',
      `if (!System.getenv('ADDA_UPLOAD_STORE_FILE') || !System.getenv('ADDA_UPLOAD_STORE_PASSWORD') ||
                !System.getenv('ADDA_UPLOAD_KEY_ALIAS') || !System.getenv('ADDA_UPLOAD_KEY_PASSWORD')) {
                throw new GradleException('ADDA upload signing environment variables are required for release builds')
            }
            signingConfig signingConfigs.release`
    );
    return source;
}

function withPlaySigning(config) {
  return withAppBuildGradle(config, (mod) => {
    mod.modResults.contents = patchGradle(mod.modResults.contents);
    return mod;
  });
}

withPlaySigning.patchGradle = patchGradle;
module.exports = withPlaySigning;
