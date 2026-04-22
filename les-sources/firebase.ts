import Constants from 'expo-constants';
import { FirebaseApp, getApps, initializeApp } from 'firebase/app';
import { Database, getDatabase } from 'firebase/database';

type FirebaseConfig = {
  apiKey: string;
  authDomain: string;
  databaseURL: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
};

type FirebaseExtra = Partial<FirebaseConfig>;

const extraConfig = (Constants.expoConfig?.extra ?? {}) as FirebaseExtra;

const firebaseConfig: FirebaseConfig = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY ?? extraConfig.apiKey ?? '',
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN ?? extraConfig.authDomain ?? '',
  databaseURL: process.env.EXPO_PUBLIC_FIREBASE_DATABASE_URL ?? extraConfig.databaseURL ?? '',
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID ?? extraConfig.projectId ?? '',
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET ?? extraConfig.storageBucket ?? '',
  messagingSenderId:
    process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? extraConfig.messagingSenderId ?? '',
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID ?? extraConfig.appId ?? '',
};

const hasFirebaseConfig = Object.values(firebaseConfig).every(
  (value) => typeof value === 'string' && value.trim().length > 0
);

let app: FirebaseApp | null = null;
let db: Database | null = null;

if (hasFirebaseConfig) {
  app = getApps().length > 0 ? getApps()[0] : initializeApp(firebaseConfig);
  db = getDatabase(app);
}

export const firebaseDatabase = db;
export const isFirebaseEnabled = hasFirebaseConfig;
