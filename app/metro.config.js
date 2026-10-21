const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.resolver.assetExts.push('glb');
config.resolver.assetExts.push('rgba');
module.exports = config;
