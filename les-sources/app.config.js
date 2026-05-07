const baseConfig = require('./app.json').expo;

const DEFAULT_DATABASE_URL = 'https://les-sources-66f43-default-rtdb.firebaseio.com';

module.exports = ({ config }) => {
  const databaseUrlFromEnv = process.env.EXPO_PUBLIC_FIREBASE_DATABASE_URL?.trim();
  const databaseURL = databaseUrlFromEnv || baseConfig.extra?.databaseURL || DEFAULT_DATABASE_URL;
  const plugins = [
    ...(config.plugins ?? baseConfig.plugins ?? []),
    [
      'expo-location',
      {
        locationAlwaysAndWhenInUsePermission:
          "L'application utilise votre position en permanence pour afficher les personnes sur la carte, même lorsque l'écran est verrouillé.",
        locationWhenInUsePermission:
          "L'application utilise votre position pour afficher votre emplacement sur la carte et suivre les événements.",
        isIosBackgroundLocationEnabled: true,
        isAndroidBackgroundLocationEnabled: true,
      },
    ],
  ];

  return {
    ...baseConfig,
    ...config,
    plugins,
    extra: {
      ...baseConfig.extra,
      ...config.extra,
      databaseURL,
    },
  };
};