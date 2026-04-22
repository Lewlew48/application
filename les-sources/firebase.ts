import Constants from 'expo-constants';

type FirebaseConfig = {
  databaseURL: string;
};

type FirebaseExtra = Partial<FirebaseConfig>;
const DEFAULT_DATABASE_URL = 'https://les-sources-66f43-default-rtdb.firebaseio.com';

type ConstantsWithLegacyManifest = typeof Constants & {
  manifest?: {
    extra?: FirebaseExtra;
  };
  manifest2?: {
    extra?: {
      expoClient?: {
        extra?: FirebaseExtra;
      };
    };
  };
};

const constantsWithLegacyManifest = Constants as ConstantsWithLegacyManifest;
const extraFromExpoConfig = (Constants.expoConfig?.extra ?? {}) as FirebaseExtra;
const extraFromManifest = (constantsWithLegacyManifest.manifest?.extra ?? {}) as FirebaseExtra;
const extraFromManifest2 =
  (constantsWithLegacyManifest.manifest2?.extra?.expoClient?.extra ?? {}) as FirebaseExtra;

const resolvedExtra: FirebaseExtra = {
  ...extraFromManifest,
  ...extraFromManifest2,
  ...extraFromExpoConfig,
};

const globalEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;

const databaseUrlRaw =
  process.env.EXPO_PUBLIC_FIREBASE_DATABASE_URL ??
  globalEnv?.EXPO_PUBLIC_FIREBASE_DATABASE_URL ??
  resolvedExtra.databaseURL ??
  DEFAULT_DATABASE_URL;

const normalizeDatabaseUrl = (value: string) => value.trim().replace(/\/+$/, '');
const databaseUrl = normalizeDatabaseUrl(databaseUrlRaw);

const buildDatabasePath = (path: string) => {
  const normalizedPath = path.replace(/^\/+|\/+$/g, '');
  return `${normalizeDatabaseUrl(databaseUrl)}/${normalizedPath}.json`;
};

export const cloudSyncEnabled = databaseUrl.trim().length > 0;

export const readCloudValue = async <T>(path: string): Promise<T | null> => {
  if (!cloudSyncEnabled) {
    return null;
  }

  const response = await fetch(buildDatabasePath(path));
  if (!response.ok) {
    throw new Error(`Impossible de lire ${path}`);
  }

  return (await response.json()) as T | null;
};

export const writeCloudValue = async (path: string, value: unknown) => {
  if (!cloudSyncEnabled) {
    return;
  }

  const response = await fetch(buildDatabasePath(path), {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(value),
  });

  if (!response.ok) {
    throw new Error(`Impossible d'ecrire ${path}`);
  }
};

export const deleteCloudValue = async (path: string) => {
  if (!cloudSyncEnabled) {
    return;
  }

  const response = await fetch(buildDatabasePath(path), {
    method: 'DELETE',
  });

  if (!response.ok) {
    throw new Error(`Impossible de supprimer ${path}`);
  }
};
