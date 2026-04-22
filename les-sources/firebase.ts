import Constants from 'expo-constants';

type FirebaseConfig = {
  databaseURL: string;
};

type FirebaseExtra = Partial<FirebaseConfig>;

const extraConfig = (Constants.expoConfig?.extra ?? {}) as FirebaseExtra;

const databaseUrl = process.env.EXPO_PUBLIC_FIREBASE_DATABASE_URL ?? extraConfig.databaseURL ?? '';

const normalizeDatabaseUrl = (value: string) => value.replace(/\/$/, '');

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
