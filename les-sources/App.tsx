import AsyncStorage from '@react-native-async-storage/async-storage';
import * as DocumentPicker from 'expo-document-picker';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { activateKeepAwake, deactivateKeepAwake } from 'expo-keep-awake';
import { StatusBar } from 'expo-status-bar';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  LayoutChangeEvent,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import {
  cloudSyncEnabled,
  deleteCloudValue,
  readCloudValue,
  writeCloudValue,
} from './firebase';

type Role = 'admin' | 'admin_global' | 'admin_manifestation' | 'benevole' | 'participant';
type Page = 'manifestations' | 'admin' | 'carte' | 'compte';

type Manifestation = {
  id: string;
  name: string;
  createdAt: number;
};

type User = {
  id: string;
  username: string;
  password: string;
  role: Role;
  manifestationId?: string;
  preferredMapType?: MapType;
};

type UserLocation = {
  userId: string;
  username: string;
  latitude: number;
  longitude: number;
  heading?: number;
  isFollowingEvent?: boolean;
  followingEventId?: string;
  manifestationId: string;
  timestamp: number;
};

type EventTrackPoint = {
  latitude: number;
  longitude: number;
};

type EventItem = {
  id: string;
  manifestationId: string;
  name: string;
  date: string;
  startTime: string;
  endTime: string;
  gpxText: string;
  showForVolunteers: boolean;
};

type VisibleEvent = {
  event: EventItem;
  index: number;
  points: EventTrackPoint[];
};

type EventPickerTarget = 'date' | null;
type MapType = 'standard' | 'satellite' | 'hybrid';
type NavigationMode = 'normal';

type TrackingSession = {
  userId: string;
  username: string;
  role: Role;
  manifestationId: string;
  activeEventId?: string | null;
};

type AppDataCache = {
  manifestations: Manifestation[];
  users: User[];
  userLocations: UserLocation[];
  events: EventItem[];
  emergencyAlerts: EmergencyAlert[];
};

type SavedAuthSession = {
  userId: string;
  manifestationId: string | null;
  page: Page;
  savedAt: number;
};

type EmergencyAlert = {
  id: string;
  userId: string;
  username: string;
  manifestationId: string;
  eventId: string;
  eventName: string;
  timestamp: number;
};

const CLOUD_USERS_PATH = 'users';
const CLOUD_MANIFESTATIONS_PATH = 'manifestations';
const CLOUD_LOCATIONS_PATH = 'locations';
const CLOUD_EVENTS_PATH = 'events';
const CLOUD_EMERGENCY_ALERTS_PATH = 'emergencyAlerts';
const BACKGROUND_LOCATION_TASK_NAME = 'les-sources-background-location';
const TRACKING_SESSION_STORAGE_KEY = '@les-sources/tracking-session';
const APP_DATA_CACHE_STORAGE_KEY = '@les-sources/app-data-cache';
const AUTH_SESSION_STORAGE_KEY = '@les-sources/auth-session';
const DEFAULT_MANIFESTATION_ID = 'manifestation-1';
const DEFAULT_MANIFESTATIONS: Manifestation[] = [
  {
    id: DEFAULT_MANIFESTATION_ID,
    name: 'Manifestation principale',
    createdAt: Date.now(),
  },
];
const MENDE_REGION = {
  latitude: 44.5186,
  longitude: 3.5017,
};

const mapsModule =
  Platform.OS === 'web'
    ? null
    : (() => {
        try {
          return require('react-native-maps');
        } catch {
          return null;
        }
      })();
const MapView = mapsModule?.default;
const Marker = mapsModule?.Marker;
const Polyline = mapsModule?.Polyline;
const canRenderNativeMap = Boolean(MapView && Marker && Polyline);

const DEFAULT_USERS: User[] = [
  {
    id: 'admin-1',
    username: 'admin',
    password: 'admin',
    role: 'admin',
    manifestationId: DEFAULT_MANIFESTATION_ID,
  },
];

const DEFAULT_MAP_REGION = {
  latitude: 48.8566,
  longitude: 2.3522,
  latitudeDelta: 0.0922,
  longitudeDelta: 0.0421,
};

const EVENT_COLORS = ['#ef4444', '#2563eb', '#f59e0b', '#A7C7E7', '#8b5cf6'];
const EARTH_RADIUS_METERS = 6371000;

const formatTime = (date: Date) => {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
};

const mergeDateAndTime = (dateSource: Date, timeSource: Date) => {
  const merged = new Date(dateSource);
  merged.setHours(timeSource.getHours(), timeSource.getMinutes(), 0, 0);
  return merged;
};

const toRadians = (value: number) => (value * Math.PI) / 180;

const haversineDistanceMeters = (
  pointA: { latitude: number; longitude: number },
  pointB: { latitude: number; longitude: number }
) => {
  const lat1 = toRadians(pointA.latitude);
  const lat2 = toRadians(pointB.latitude);
  const deltaLat = toRadians(pointB.latitude - pointA.latitude);
  const deltaLng = toRadians(pointB.longitude - pointA.longitude);

  const a =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
};

const bearingDegrees = (
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number }
) => {
  const fromLat = toRadians(from.latitude);
  const fromLng = toRadians(from.longitude);
  const toLat = toRadians(to.latitude);
  const toLng = toRadians(to.longitude);
  const y = Math.sin(toLng - fromLng) * Math.cos(toLat);
  const x =
    Math.cos(fromLat) * Math.sin(toLat) -
    Math.sin(fromLat) * Math.cos(toLat) * Math.cos(toLng - fromLng);
  return (Math.atan2(y, x) * 180) / Math.PI + 360;
};

const normalizeDegrees = (degrees: number) => {
  const normalized = degrees % 360;
  return normalized < 0 ? normalized + 360 : normalized;
};

const pointToSegmentDistanceMeters = (
  point: { latitude: number; longitude: number },
  segStart: { latitude: number; longitude: number },
  segEnd: { latitude: number; longitude: number }
) => {
  const latRef = toRadians(point.latitude);
  const project = (candidate: { latitude: number; longitude: number }) => {
    const x =
      toRadians(candidate.longitude - point.longitude) * Math.cos(latRef) * EARTH_RADIUS_METERS;
    const y = toRadians(candidate.latitude - point.latitude) * EARTH_RADIUS_METERS;
    return { x, y };
  };

  const pointProjected = { x: 0, y: 0 };
  const startProjected = project(segStart);
  const endProjected = project(segEnd);

  const segmentX = endProjected.x - startProjected.x;
  const segmentY = endProjected.y - startProjected.y;
  const segmentLengthSquared = segmentX * segmentX + segmentY * segmentY;

  if (segmentLengthSquared === 0) {
    return Math.sqrt(startProjected.x * startProjected.x + startProjected.y * startProjected.y);
  }

  const projectionFactor =
    ((pointProjected.x - startProjected.x) * segmentX +
      (pointProjected.y - startProjected.y) * segmentY) /
    segmentLengthSquared;
  const clamped = Math.max(0, Math.min(1, projectionFactor));

  const closestX = startProjected.x + clamped * segmentX;
  const closestY = startProjected.y + clamped * segmentY;
  return Math.sqrt(closestX * closestX + closestY * closestY);
};

const distanceToPolylineMeters = (
  point: { latitude: number; longitude: number },
  polyline: EventTrackPoint[]
) => {
  if (polyline.length < 2) {
    return Number.POSITIVE_INFINITY;
  }

  let minimumDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < polyline.length - 1; i += 1) {
    const currentDistance = pointToSegmentDistanceMeters(point, polyline[i], polyline[i + 1]);
    if (currentDistance < minimumDistance) {
      minimumDistance = currentDistance;
    }
  }

  return minimumDistance;
};

const routeLengthMeters = (points: EventTrackPoint[]) => {
  if (points.length < 2) {
    return 0;
  }

  let sum = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    sum += haversineDistanceMeters(points[i], points[i + 1]);
  }
  return sum;
};

const formatKm = (distanceMeters: number) => `${(distanceMeters / 1000).toFixed(2)} km`;

const formatElapsedTime = (seconds: number) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
};

const getDirectionArrow = (degrees: number) => {
  const normalized = normalizeDegrees(degrees);
  if (normalized < 22.5 || normalized >= 337.5) return '↑';
  if (normalized < 67.5) return '↗';
  if (normalized < 112.5) return '→';
  if (normalized < 157.5) return '↘';
  if (normalized < 202.5) return '↓';
  if (normalized < 247.5) return '↙';
  if (normalized < 292.5) return '←';
  return '↖';
};

const getLocalDateKey = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const isValidDateInput = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

const isValidTimeInput = (value: string) => /^\d{2}:\d{2}$/.test(value);

const valuesFromRecord = <T,>(value: unknown): T[] => {
  if (!value || typeof value !== 'object') {
    return [];
  }

  return Object.values(value as Record<string, T>);
};

const mapById = <T extends { id: string }>(items: T[]) => {
  return items.reduce<Record<string, T>>((record, item) => {
    record[item.id] = item;
    return record;
  }, {});
};

const mapLocationsByUserId = (items: UserLocation[]) => {
  return items.reduce<Record<string, UserLocation>>((record, item) => {
    record[item.userId] = item;
    return record;
  }, {});
};

const persistBackgroundLocation = async (
  session: TrackingSession,
  latitude: number,
  longitude: number,
  heading?: number,
  followingEventId?: string
) => {
  const cloudLocations = await readCloudValue<Record<string, UserLocation>>(CLOUD_LOCATIONS_PATH);
  const existingLocations = valuesFromRecord<UserLocation>(cloudLocations);
  const existingIndex = existingLocations.findIndex((location) => location.userId === session.userId);

  const nextLocation: UserLocation = {
    userId: session.userId,
    username: session.username,
    latitude,
    longitude,
    heading,
    isFollowingEvent: Boolean(followingEventId),
    followingEventId,
    manifestationId: session.manifestationId || DEFAULT_MANIFESTATION_ID,
    timestamp: Date.now(),
  };

  const nextLocations = [...existingLocations];
  if (existingIndex >= 0) {
    nextLocations[existingIndex] = nextLocation;
  } else {
    nextLocations.push(nextLocation);
  }

  await writeCloudValue(CLOUD_LOCATIONS_PATH, mapLocationsByUserId(nextLocations));
};

if (Platform.OS !== 'web') {
  TaskManager.defineTask(
    BACKGROUND_LOCATION_TASK_NAME,
    async (taskData) => {
      const { data, error } = taskData as {
        data?: { locations?: Location.LocationObject[] };
        error: TaskManager.TaskManagerError | null;
      };

    if (error) {
      console.error('Erreur localisation arrière-plan:', error);
      return;
    }

    const locations = (data as { locations?: Location.LocationObject[] } | undefined)?.locations;
    if (!locations?.length) {
      return;
    }

    try {
      const sessionRaw = await AsyncStorage.getItem(TRACKING_SESSION_STORAGE_KEY);
      if (!sessionRaw) {
        return;
      }

      const session = JSON.parse(sessionRaw) as TrackingSession;
      const latestLocation = locations[locations.length - 1];
      const heading =
        typeof latestLocation.coords.heading === 'number' && latestLocation.coords.heading >= 0
          ? latestLocation.coords.heading
          : undefined;

      await persistBackgroundLocation(
        session,
        latestLocation.coords.latitude,
        latestLocation.coords.longitude,
        heading,
        session.role === 'participant' ? session.activeEventId ?? undefined : undefined
      );
    } catch (taskError) {
      console.error('Erreur mise à jour position arrière-plan:', taskError);
    }
    }
  );
}

const normalizeRole = (role: string | undefined): Role => {
  if (role === 'admin_global' || role === 'admin_manifestation' || role === 'benevole' || role === 'participant') {
    return role;
  }

  return 'admin';
};

const isGlobalAdminRole = (role: Role) => role === 'admin' || role === 'admin_global';

const isManifestationAdminRole = (role: Role) => role === 'admin' || role === 'admin_manifestation';

const getRoleLabel = (role: Role) => {
  switch (role) {
    case 'admin':
    case 'admin_global':
      return 'admin global';
    case 'admin_manifestation':
      return 'admin manifestation';
    case 'benevole':
      return 'bénévole';
    case 'participant':
      return 'participant';
    default:
      return role;
  }
};

const normalizeManifestationName = (value: string) => value.trim().replace(/\s+/g, ' ');

const defaultManifestation = (): Manifestation => ({
  id: DEFAULT_MANIFESTATION_ID,
  name: 'Manifestation principale',
  createdAt: Date.now(),
});

const normalizeUser = (user: User): User => ({
  ...user,
  role: normalizeRole(user.role),
});

const assignDefaultManifestation = <T extends { manifestationId?: string }>(item: T) => ({
  ...item,
  manifestationId: item.manifestationId ?? DEFAULT_MANIFESTATION_ID,
});

const parseGpxTrackPoints = (gpxText: string): EventTrackPoint[] => {
  const points: EventTrackPoint[] = [];
  const trackPointPattern = /<trkpt\b[^>]*\blat="([^"]+)"[^>]*\blon="([^"]+)"[^>]*>/gi;
  let match: RegExpExecArray | null;

  while ((match = trackPointPattern.exec(gpxText)) !== null) {
    const latitude = Number.parseFloat(match[1]);
    const longitude = Number.parseFloat(match[2]);

    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      points.push({ latitude, longitude });
    }
  }

  return points;
};

const isEventVisibleForUser = (event: EventItem, role: Role) => {
  const isToday = event.date === getLocalDateKey(new Date());

  if (isToday) {
    return true;
  }

  if (event.showForVolunteers) {
    return isManifestationAdminRole(role) || role === 'benevole';
  }

  return false;
};

const normalizeStoredAppData = (rawValue: string | null): AppDataCache | null => {
  if (!rawValue) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawValue) as Partial<AppDataCache>;

    return {
      manifestations: Array.isArray(parsed.manifestations)
        ? parsed.manifestations.map((manifestation) => ({
            ...manifestation,
            name: normalizeManifestationName(String(manifestation.name ?? '')) || 'Manifestation sans nom',
          }))
        : [],
      users: Array.isArray(parsed.users) ? parsed.users.map(normalizeUser) : [],
      userLocations: Array.isArray(parsed.userLocations) ? parsed.userLocations.map(assignDefaultManifestation) : [],
      events: Array.isArray(parsed.events) ? parsed.events.map(assignDefaultManifestation) : [],
      emergencyAlerts: Array.isArray(parsed.emergencyAlerts)
        ? parsed.emergencyAlerts.map(assignDefaultManifestation)
        : [],
    };
  } catch {
    return null;
  }
};

const normalizeSavedAuthSession = (rawValue: string | null): SavedAuthSession | null => {
  if (!rawValue) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawValue) as Partial<SavedAuthSession>;

    if (typeof parsed.userId !== 'string' || !parsed.userId) {
      return null;
    }

    const page = parsed.page;
    const normalizedPage: Page =
      page === 'manifestations' || page === 'admin' || page === 'carte' || page === 'compte'
        ? page
        : 'carte';

    return {
      userId: parsed.userId,
      manifestationId: typeof parsed.manifestationId === 'string' ? parsed.manifestationId : null,
      page: normalizedPage,
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : Date.now(),
    };
  } catch {
    return null;
  }
};

const persistAppDataCache = async (cache: AppDataCache) => {
  try {
    await AsyncStorage.setItem(APP_DATA_CACHE_STORAGE_KEY, JSON.stringify(cache));
  } catch (error) {
    console.error('Erreur sauvegarde cache local:', error);
  }
};

const persistAuthSession = async (session: SavedAuthSession | null) => {
  try {
    if (!session) {
      await AsyncStorage.removeItem(AUTH_SESSION_STORAGE_KEY);
      return;
    }

    await AsyncStorage.setItem(AUTH_SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch (error) {
    console.error('Erreur sauvegarde session locale:', error);
  }
};

export default function App() {
  const useCloudSync = cloudSyncEnabled;
  const [manifestations, setManifestations] = useState<Manifestation[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [currentPage, setCurrentPage] = useState<Page>('carte');
  const [currentManifestationId, setCurrentManifestationId] = useState<string | null>(null);

  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');

  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<Role>('participant');

  const [manifestationName, setManifestationName] = useState('');

  const [userLocations, setUserLocations] = useState<UserLocation[]>([]);
  const [currentLocation, setCurrentLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const [events, setEvents] = useState<EventItem[]>([]);

  const [eventName, setEventName] = useState('');
  const [eventDate, setEventDate] = useState('');
  const [eventGpxText, setEventGpxText] = useState('');
  const [eventGpxFileName, setEventGpxFileName] = useState('');
  const [eventVisibleForVolunteers, setEventVisibleForVolunteers] = useState(false);
  const [eventDateValue, setEventDateValue] = useState<Date | null>(null);
  const [eventPickerTarget, setEventPickerTarget] = useState<EventPickerTarget>(null);
  const [eventPickerValue, setEventPickerValue] = useState(new Date());

  const [mapType, setMapType] = useState<MapType>('standard');
  const [accountMapType, setAccountMapType] = useState<MapType>('standard');

  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [activeEventId, setActiveEventId] = useState<string | null>(null);
  const [navigationMode, setNavigationMode] = useState<NavigationMode>('normal');
  const [nextWaypointIndex, setNextWaypointIndex] = useState(0);
  const [distanceTravelledMeters, setDistanceTravelledMeters] = useState(0);
  const [navigationStartedAt, setNavigationStartedAt] = useState<number | null>(null);
  const [currentSpeedKmh, setCurrentSpeedKmh] = useState(0);
  const [currentHeading, setCurrentHeading] = useState(0);
  const [offRouteDistanceMeters, setOffRouteDistanceMeters] = useState(0);
  const [showOffRouteAlert, setShowOffRouteAlert] = useState(false);
  const [emergencyAlerts, setEmergencyAlerts] = useState<EmergencyAlert[]>([]);
  const [emergencyCountdown, setEmergencyCountdown] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [mapContainerHeight, setMapContainerHeight] = useState(0);
  const [mapNoticeLayout, setMapNoticeLayout] = useState<{ y: number; height: number } | null>(null);
  const [adminEmergencyLayout, setAdminEmergencyLayout] = useState<{ y: number; height: number } | null>(null);
  const [participantPanelLayout, setParticipantPanelLayout] = useState<{ y: number; height: number } | null>(null);
  const [navigationStatsLayout, setNavigationStatsLayout] = useState<{ y: number; height: number } | null>(null);
  const [isOffline, setIsOffline] = useState(false);
  const [lastKnownUserLocations, setLastKnownUserLocations] = useState<UserLocation[]>([]);

  const mapRef = useRef<any>(null);
  const previousNavigationPositionRef = useRef<{ latitude: number; longitude: number } | null>(null);
  const currentHeadingRef = useRef(0);
  const navigationModeRef = useRef<NavigationMode>('normal');
  const nextWaypointIndexRef = useRef(0);
  const showOffRouteAlertRef = useRef(false);
  const activeEventPointsRef = useRef<EventTrackPoint[]>([]);

  const [accountUsername, setAccountUsername] = useState('');
  const [accountPassword, setAccountPassword] = useState('');

  const restoreSavedSession = (session: SavedAuthSession | null, nextUsers: User[]) => {
    if (!session) {
      return;
    }

    const restoredUser = nextUsers.find((user) => user.id === session.userId);
    if (!restoredUser) {
      return;
    }

    setCurrentUser(restoredUser);
    setCurrentPage(session.page ?? (isGlobalAdminRole(restoredUser.role) ? 'manifestations' : 'carte'));
    setCurrentManifestationId(session.manifestationId ?? restoredUser.manifestationId ?? DEFAULT_MANIFESTATION_ID);
  };

  useEffect(() => {
    let isMounted = true;
    let savedSession: SavedAuthSession | null = null;

    const applyLoadedData = async (loadedData: AppDataCache, source: 'cache' | 'cloud') => {
      const nextManifestations = loadedData.manifestations.length > 0 ? loadedData.manifestations : DEFAULT_MANIFESTATIONS;
      const nextUsers = loadedData.users.length > 0 ? loadedData.users : DEFAULT_USERS;
      const nextLocations = loadedData.userLocations;
      const nextEvents = loadedData.events;
      const nextAlerts = [...loadedData.emergencyAlerts]
        .sort((left, right) => right.timestamp - left.timestamp)
        .slice(0, 50);

      if (!isMounted) {
        return nextUsers;
      }

      setManifestations(nextManifestations);
      setUsers(nextUsers);
      setUserLocations(nextLocations);
      setLastKnownUserLocations(nextLocations);
      setEvents(nextEvents);
      setEmergencyAlerts(nextAlerts);

      if (source === 'cloud') {
        await persistAppDataCache({
          manifestations: nextManifestations,
          users: nextUsers,
          userLocations: nextLocations,
          events: nextEvents,
          emergencyAlerts: nextAlerts,
        });
      }

      return nextUsers;
    };

    const syncFromCloud = async () => {
      try {
        const [cloudManifestations, cloudUsers, cloudLocations, cloudEvents, cloudAlerts] = await Promise.all([
          readCloudValue<Record<string, Manifestation>>(CLOUD_MANIFESTATIONS_PATH),
          readCloudValue<Record<string, User>>(CLOUD_USERS_PATH),
          readCloudValue<Record<string, UserLocation>>(CLOUD_LOCATIONS_PATH),
          readCloudValue<Record<string, EventItem>>(CLOUD_EVENTS_PATH),
          readCloudValue<Record<string, EmergencyAlert>>(CLOUD_EMERGENCY_ALERTS_PATH),
        ]);

        if (!isMounted) {
          return;
        }

        const parsedManifestations = valuesFromRecord<Manifestation>(cloudManifestations).map((item) => ({
          ...item,
          name: normalizeManifestationName(item.name) || 'Manifestation sans nom',
        }));
        const nextManifestations = parsedManifestations.length > 0 ? parsedManifestations : DEFAULT_MANIFESTATIONS;
        if (parsedManifestations.length === 0) {
          await writeCloudValue(CLOUD_MANIFESTATIONS_PATH, mapById(nextManifestations));
        }

        const parsedUsers = valuesFromRecord<User>(cloudUsers).map(normalizeUser);
        const hasAdmin = parsedUsers.some((user: User) => user.username === 'admin' && user.role === 'admin');
        const nextUsers =
          parsedUsers.length === 0
            ? DEFAULT_USERS
            : hasAdmin
              ? parsedUsers.map((user) =>
                  user.role === 'admin' && !user.manifestationId
                    ? { ...user, manifestationId: DEFAULT_MANIFESTATION_ID }
                    : user
                )
              : [...parsedUsers, ...DEFAULT_USERS];

        const normalizedUsers = nextUsers.map((user) =>
          isGlobalAdminRole(user.role) && user.role !== 'admin'
            ? user
            : assignDefaultManifestation(user)
        );

        if (parsedUsers.length === 0 || !hasAdmin || normalizedUsers.some((user) => !isGlobalAdminRole(user.role) && !user.manifestationId)) {
          await writeCloudValue(CLOUD_USERS_PATH, mapById(normalizedUsers));
        }

        const parsedLocations = valuesFromRecord<UserLocation>(cloudLocations).map(assignDefaultManifestation);
        const parsedEvents = valuesFromRecord<EventItem>(cloudEvents).map(assignDefaultManifestation);
        const parsedAlerts = valuesFromRecord<EmergencyAlert>(cloudAlerts).map(assignDefaultManifestation);

        const hasLegacyLocations = parsedLocations.some((location) => !location.manifestationId);
        const hasLegacyEvents = parsedEvents.some((event) => !event.manifestationId);
        const hasLegacyAlerts = parsedAlerts.some((alert) => !alert.manifestationId);

        if (hasLegacyLocations) {
          await writeCloudValue(CLOUD_LOCATIONS_PATH, mapLocationsByUserId(parsedLocations));
        }
        if (hasLegacyEvents) {
          await writeCloudValue(CLOUD_EVENTS_PATH, mapById(parsedEvents));
        }
        if (hasLegacyAlerts) {
          await writeCloudValue(CLOUD_EMERGENCY_ALERTS_PATH, mapById(parsedAlerts));
        }

        const nextAlerts = [...parsedAlerts].sort((left, right) => right.timestamp - left.timestamp).slice(0, 50);

        if (!isMounted) {
          return;
        }

        setManifestations(nextManifestations);
        setUsers(normalizedUsers);
        setUserLocations(parsedLocations);
        setLastKnownUserLocations(parsedLocations);
        setEvents(parsedEvents);
        setEmergencyAlerts(nextAlerts);

        await persistAppDataCache({
          manifestations: nextManifestations,
          users: normalizedUsers,
          userLocations: parsedLocations,
          events: parsedEvents,
          emergencyAlerts: nextAlerts,
        });

        if (savedSession) {
          const restoredUser = normalizedUsers.find((user) => user.id === savedSession?.userId);
          if (restoredUser) {
            setCurrentUser(restoredUser);
            setCurrentPage(savedSession.page ?? (isGlobalAdminRole(restoredUser.role) ? 'manifestations' : 'carte'));
            setCurrentManifestationId(savedSession.manifestationId ?? restoredUser.manifestationId ?? DEFAULT_MANIFESTATION_ID);
          } else {
            setCurrentUser(null);
            setCurrentManifestationId(null);
            await persistAuthSession(null);
          }
        }

        setIsOffline(false);
      } catch {
        // Ignore cloud sync errors and keep the last good state.
        setIsOffline(true);
      }
    };

    const bootstrap = async () => {
      try {
        const [storedDataRaw, storedSessionRaw] = await Promise.all([
          AsyncStorage.getItem(APP_DATA_CACHE_STORAGE_KEY),
          AsyncStorage.getItem(AUTH_SESSION_STORAGE_KEY),
        ]);

        savedSession = normalizeSavedAuthSession(storedSessionRaw);

        const cachedData = normalizeStoredAppData(storedDataRaw) ?? {
          manifestations: DEFAULT_MANIFESTATIONS,
          users: DEFAULT_USERS,
          userLocations: [],
          events: [],
          emergencyAlerts: [],
        };

        const nextUsers = await applyLoadedData(cachedData, 'cache');
        restoreSavedSession(savedSession, nextUsers);

        if (useCloudSync) {
          await syncFromCloud();
        }
      } catch {
        setIsOffline(true);
      } finally {
        if (isMounted) {
          setIsReady(true);
        }
      }
    };

    bootstrap();
    const syncInterval = useCloudSync ? setInterval(syncFromCloud, 2000) : undefined;

    return () => {
      isMounted = false;
      if (syncInterval) {
        clearInterval(syncInterval);
      }
    };
  }, [useCloudSync]);

  useEffect(() => {
    if (!currentUser) {
      setAccountUsername('');
      setAccountPassword('');
      setAccountMapType('standard');
      setMapType('standard');
      setCurrentManifestationId(null);
      return;
    }

    setAccountUsername(currentUser.username);
    setAccountPassword(currentUser.password);
    setAccountMapType(currentUser.preferredMapType ?? 'standard');
    setMapType(currentUser.preferredMapType ?? 'standard');
    if (!isGlobalAdminRole(currentUser.role)) {
      setCurrentManifestationId(currentUser.manifestationId ?? DEFAULT_MANIFESTATION_ID);
    }
  }, [currentUser]);

  useEffect(() => {
    if (!currentManifestationId && currentUser && !isGlobalAdminRole(currentUser.role)) {
      setCurrentManifestationId(currentUser.manifestationId ?? DEFAULT_MANIFESTATION_ID);
    }
  }, [currentManifestationId, currentUser]);

  useEffect(() => {
    setSelectedEventId(null);
    setActiveEventId(null);
    setNavigationMode('normal');
    setNextWaypointIndex(0);
    setDistanceTravelledMeters(0);
    setNavigationStartedAt(null);
    setCurrentSpeedKmh(0);
    setOffRouteDistanceMeters(0);
    setShowOffRouteAlert(false);
    setEmergencyCountdown(null);
    previousNavigationPositionRef.current = null;
  }, [currentManifestationId]);

  const canViewGlobalAdmins = currentUser ? isGlobalAdminRole(currentUser.role) : false;

  const sortedUsers = useMemo(() => {
    const visibleUsers = currentManifestationId
      ? users.filter(
          (user) =>
            user.manifestationId === currentManifestationId &&
            (canViewGlobalAdmins || !isGlobalAdminRole(user.role))
        )
      : users.filter((user) => isGlobalAdminRole(user.role));

    return [...visibleUsers].sort((a, b) => {
      if (a.role !== b.role) {
        return isGlobalAdminRole(a.role) ? -1 : 1;
      }
      return a.username.localeCompare(b.username);
    });
  }, [canViewGlobalAdmins, currentManifestationId, users]);

  const currentManifestation = useMemo(() => {
    if (!currentManifestationId) {
      return null;
    }

    return manifestations.find((manifestation) => manifestation.id === currentManifestationId) ?? null;
  }, [currentManifestationId, manifestations]);

  const currentManifestationUsers = useMemo(() => {
    if (!currentManifestationId) {
      return [] as User[];
    }

    return users.filter(
      (user) => user.manifestationId === currentManifestationId && (canViewGlobalAdmins || !isGlobalAdminRole(user.role))
    );
  }, [canViewGlobalAdmins, currentManifestationId, users]);

  const currentManifestationEvents = useMemo(() => {
    if (!currentManifestationId) {
      return [] as EventItem[];
    }

    return events.filter((event) => event.manifestationId === currentManifestationId);
  }, [currentManifestationId, events]);

  const currentManifestationLocations = useMemo(() => {
    if (!currentManifestationId) {
      return [] as UserLocation[];
    }

    return userLocations.filter((location) => location.manifestationId === currentManifestationId);
  }, [currentManifestationId, userLocations]);

  const currentManifestationAlerts = useMemo(() => {
    if (!currentManifestationId) {
      return [] as EmergencyAlert[];
    }

    return emergencyAlerts.filter((alert) => alert.manifestationId === currentManifestationId);
  }, [currentManifestationId, emergencyAlerts]);

  const currentManifestationCount = manifestations.length;

  const persistUsers = async (nextUsers: User[]) => {
    setUsers(nextUsers);
    await persistAppDataCache({
      manifestations,
      users: nextUsers,
      userLocations,
      events,
      emergencyAlerts,
    });

    if (!useCloudSync || isOffline) {
      return;
    }

    try {
      await writeCloudValue(CLOUD_USERS_PATH, mapById(nextUsers));
      setIsOffline(false);
    } catch {
      setIsOffline(true);
    }
  };

  const persistEvents = async (nextEvents: EventItem[]) => {
    setEvents(nextEvents);
    await persistAppDataCache({
      manifestations,
      users,
      userLocations,
      events: nextEvents,
      emergencyAlerts,
    });

    if (!useCloudSync || isOffline) {
      return;
    }

    try {
      await writeCloudValue(CLOUD_EVENTS_PATH, mapById(nextEvents));
      setIsOffline(false);
    } catch {
      setIsOffline(true);
    }
  };

  const persistEmergencyAlerts = async (nextAlerts: EmergencyAlert[]) => {
    setEmergencyAlerts(nextAlerts);
    await persistAppDataCache({
      manifestations,
      users,
      userLocations,
      events,
      emergencyAlerts: nextAlerts,
    });

    if (!useCloudSync || isOffline) {
      return;
    }

    try {
      await writeCloudValue(CLOUD_EMERGENCY_ALERTS_PATH, mapById(nextAlerts));
      setIsOffline(false);
    } catch {
      setIsOffline(true);
    }
  };

  const persistUserLocations = async (nextLocations: UserLocation[]) => {
    setUserLocations(nextLocations);
    setLastKnownUserLocations(nextLocations);
    await persistAppDataCache({
      manifestations,
      users,
      userLocations: nextLocations,
      events,
      emergencyAlerts,
    });

    if (!useCloudSync || isOffline) {
      return;
    }

    try {
      await writeCloudValue(CLOUD_LOCATIONS_PATH, mapLocationsByUserId(nextLocations));
      setIsOffline(false);
    } catch {
      setIsOffline(true);
    }
  };

  const persistManifestations = async (nextManifestations: Manifestation[]) => {
    setManifestations(nextManifestations);
    await persistAppDataCache({
      manifestations: nextManifestations,
      users,
      userLocations,
      events,
      emergencyAlerts,
    });

    if (!useCloudSync || isOffline) {
      return;
    }

    try {
      await writeCloudValue(CLOUD_MANIFESTATIONS_PATH, mapById(nextManifestations));
      setIsOffline(false);
    } catch {
      setIsOffline(true);
    }
  };

  const handleCreateManifestation = async () => {
    const name = normalizeManifestationName(manifestationName);
    if (!name) {
      Alert.alert('Erreur', 'Le nom de la manifestation est obligatoire.');
      return;
    }

    const nextManifestation: Manifestation = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      createdAt: Date.now(),
    };

    await persistManifestations([...manifestations, nextManifestation]);
    setManifestationName('');
    setCurrentManifestationId(nextManifestation.id);
    setCurrentPage('carte');
  };

  const handleSelectManifestation = (manifestationId: string) => {
    setCurrentManifestationId(manifestationId);
    setCurrentPage('carte');
  };

  const handleDeleteManifestation = (manifestationId: string) => {
    if (manifestations.length <= 1) {
      Alert.alert('Action impossible', 'Au moins une manifestation doit rester disponible.');
      return;
    }

    const targetManifestation = manifestations.find((manifestation) => manifestation.id === manifestationId);
    if (!targetManifestation) {
      return;
    }

    Alert.alert(
      'Supprimer la manifestation',
      `Supprimer "${targetManifestation.name}" effacera aussi ses comptes, évènements, positions et alertes associés.`,
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Supprimer',
          style: 'destructive',
          onPress: async () => {
            const isDeletingCurrentUser = Boolean(
              currentUser &&
              currentUser.manifestationId === manifestationId &&
              !isGlobalAdminRole(currentUser.role)
            );

            const nextManifestations = manifestations.filter((manifestation) => manifestation.id !== manifestationId);
            const nextUsers = users
              .map((user) => {
                if (user.manifestationId !== manifestationId) {
                  return user;
                }

                return isGlobalAdminRole(user.role) ? { ...user, manifestationId: undefined } : null;
              })
              .filter((user): user is User => user !== null);
            const nextEvents = events.filter((event) => event.manifestationId !== manifestationId);
            const nextLocations = userLocations.filter((location) => location.manifestationId !== manifestationId);
            const nextAlerts = emergencyAlerts.filter((alert) => alert.manifestationId !== manifestationId);

            await persistAppDataCache({
              manifestations: nextManifestations,
              users: nextUsers,
              userLocations: nextLocations,
              events: nextEvents,
              emergencyAlerts: nextAlerts,
            });

            setManifestations(nextManifestations);
            setUsers(nextUsers);
            setUserLocations(nextLocations);
            setLastKnownUserLocations(nextLocations);
            setEvents(nextEvents);
            setEmergencyAlerts(nextAlerts);

            if (useCloudSync && !isOffline) {
              try {
                await Promise.all([
                  writeCloudValue(CLOUD_MANIFESTATIONS_PATH, mapById(nextManifestations)),
                  writeCloudValue(CLOUD_USERS_PATH, mapById(nextUsers)),
                  writeCloudValue(CLOUD_EVENTS_PATH, mapById(nextEvents)),
                  writeCloudValue(CLOUD_LOCATIONS_PATH, mapLocationsByUserId(nextLocations)),
                  writeCloudValue(CLOUD_EMERGENCY_ALERTS_PATH, mapById(nextAlerts)),
                ]);
                setIsOffline(false);
              } catch {
                setIsOffline(true);
              }
            }

            if (currentUser && currentUser.manifestationId === manifestationId) {
              if (isGlobalAdminRole(currentUser.role)) {
                const detachedUser = { ...currentUser, manifestationId: undefined };
                const nextSelectedManifestation =
                  currentManifestationId === manifestationId ? nextManifestations[0]?.id ?? null : currentManifestationId;
                setCurrentUser(detachedUser);
                await persistAuthSession({
                  userId: detachedUser.id,
                  manifestationId: nextSelectedManifestation,
                  page: currentPage,
                  savedAt: Date.now(),
                });
              } else {
                handleLogout();
              }
            }

            if (!isDeletingCurrentUser && currentManifestationId === manifestationId) {
              setCurrentManifestationId(nextManifestations[0]?.id ?? null);
            }
          },
        },
      ]
    );
  };

  const handlePickGpxFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['application/gpx+xml', 'application/xml', 'text/xml', 'text/plain'],
        copyToCacheDirectory: true,
        multiple: false,
      });

      if (result.canceled || !result.assets || result.assets.length === 0) {
        return;
      }

      const asset = result.assets[0];
      const fileName = asset.name ?? 'fichier.gpx';
      if (!fileName.toLowerCase().endsWith('.gpx')) {
        Alert.alert('Erreur', 'Choisis un fichier .gpx.');
        return;
      }

      const response = await fetch(asset.uri);
      if (!response.ok) {
        throw new Error('Impossible de lire le fichier GPX.');
      }
      const gpxText = await response.text();

      setEventGpxText(gpxText);
      setEventGpxFileName(fileName);
    } catch {
      Alert.alert('Erreur', 'Impossible de lire le fichier GPX.');
    }
  };

  const openEventDatePicker = () => {
    setEventPickerTarget('date');
    setEventPickerValue(eventDateValue ?? new Date());
  };

  const handleEventPickerChange = (pickerEvent: DateTimePickerEvent, selectedValue?: Date) => {
    if (pickerEvent.type === 'dismissed' || !selectedValue) {
      setEventPickerTarget(null);
      return;
    }

    if (eventPickerTarget === 'date') {
      setEventDateValue(selectedValue);
      setEventDate(getLocalDateKey(selectedValue));
    }

    setEventPickerTarget(null);
  };

  const updateUserLocation = async (
    userId: string,
    username: string,
    latitude: number,
    longitude: number,
    heading?: number,
    followingEventId?: string
  ) => {
    const manifestationId = currentManifestationId ?? DEFAULT_MANIFESTATION_ID;
    const existingIndex = userLocations.findIndex((loc: UserLocation) => loc.userId === userId);
    const newLocation: UserLocation = {
      userId,
      username,
      latitude,
      longitude,
      heading,
      isFollowingEvent: Boolean(followingEventId),
      followingEventId,
      manifestationId,
      timestamp: Date.now(),
    };

    let updatedLocations: UserLocation[];
    if (existingIndex >= 0) {
      updatedLocations = [...userLocations];
      updatedLocations[existingIndex] = newLocation;
    } else {
      updatedLocations = [...userLocations, newLocation];
    }

    try {
      await persistUserLocations(updatedLocations);
      setIsOffline(false);
      setLastKnownUserLocations(updatedLocations);
    } catch (error) {
      setIsOffline(true);
      setUserLocations(updatedLocations);
      setLastKnownUserLocations(updatedLocations);
    }
  };

  const generateMockLocation = (previousLocation?: { latitude: number; longitude: number } | null) => {
    // Sur web/ordinateur, la position est simulée autour de Mende (48).
    const baseLat = previousLocation?.latitude ?? MENDE_REGION.latitude;
    const baseLng = previousLocation?.longitude ?? MENDE_REGION.longitude;
    const offset = previousLocation ? 0.0015 : 0.01;
    return {
      latitude: baseLat + (Math.random() - 0.5) * offset,
      longitude: baseLng + (Math.random() - 0.5) * offset,
    };
  };

  const requestLocationPermission = async () => {
    if (Platform.OS === 'web') {
      return true;
    }

    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert(
          'Permission refusee',
          'Autorisation de localisation necessaire pour utiliser la carte.'
        );
        return false;
      }
      return true;
    } catch (error) {
      console.error('Erreur permission:', error);
      return false;
    }
  };

  const startLocationTracking = async () => {
    if (Platform.OS === 'web') {
      const simulatedLocation = generateMockLocation(currentLocation);
      setCurrentLocation(simulatedLocation);
      setCurrentSpeedKmh(4 + Math.random() * 2);

      if (currentUser) {
        await updateUserLocation(
          currentUser.id,
          currentUser.username,
          simulatedLocation.latitude,
          simulatedLocation.longitude,
          currentHeadingRef.current,
          currentUser.role === 'participant' ? activeEventId ?? undefined : undefined
        );
      }
      return;
    }

    const hasPermission = await requestLocationPermission();
    if (!hasPermission) return;

    try {
      const location = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });
      const newLoc = {
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
      };
      setCurrentLocation(newLoc);
      
      // Mettre à jour la position de l'utilisateur dans la base de données
      if (currentUser) {
        await updateUserLocation(
          currentUser.id,
          currentUser.username,
          newLoc.latitude,
          newLoc.longitude,
          currentHeadingRef.current,
          currentUser.role === 'participant' ? activeEventId ?? undefined : undefined
        );
      }
    } catch (error) {
      console.error('Erreur geolocalisation:', error);
    }
  };

  const getMarkerColorByRole = (role: Role) => {
    if (role === 'participant') return '#ff8c42'; // Orange
    if (role === 'benevole') return '#4b7bff'; // Bleu
    return '#5F8FC9'; // Bleu pour admin
  };

  const handleCreateEvent = async () => {
    if (!currentManifestationId) {
      Alert.alert('Erreur', 'Sélectionne d abord une manifestation.');
      return;
    }

    const name = eventName.trim();
    const date = eventDate.trim();
    const gpxText = eventGpxText.trim();

    if (!name || !date || !gpxText) {
      Alert.alert('Erreur', 'Tous les champs de l évènement sont obligatoires.');
      return;
    }

    if (!isValidDateInput(date)) {
      Alert.alert('Erreur', 'La date doit etre au format YYYY-MM-DD.');
      return;
    }

    const parsedTrack = parseGpxTrackPoints(gpxText);
    if (parsedTrack.length < 2) {
      Alert.alert('Erreur', 'Le GPX doit contenir au moins deux points de trace valides.');
      return;
    }

    const nextEvent: EventItem = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      manifestationId: currentManifestationId,
      name,
      date,
      startTime: '',
      endTime: '',
      gpxText,
      showForVolunteers: eventVisibleForVolunteers,
    };

    const nextEvents = [...events, nextEvent];
    await persistEvents(nextEvents);
    setEventName('');
    setEventDate('');
    setEventGpxText('');
    setEventGpxFileName('');
    setEventVisibleForVolunteers(false);
    setEventDateValue(null);
    setEventPickerTarget(null);
  };

  const handleLogin = () => {
    const username = loginUsername.trim();
    const password = loginPassword.trim();

    const found = users.find((u: User) => u.username === username && u.password === password);
    if (!found) {
      Alert.alert('Connexion echouee', 'Identifiants invalides.');
      return;
    }

    setCurrentUser(found);
    setLoginPassword('');

    if (isGlobalAdminRole(found.role)) {
      setCurrentManifestationId(found.manifestationId ?? DEFAULT_MANIFESTATION_ID);
      setCurrentPage('manifestations');
      void persistAuthSession({
        userId: found.id,
        manifestationId: found.manifestationId ?? DEFAULT_MANIFESTATION_ID,
        page: 'manifestations',
        savedAt: Date.now(),
      });
      return;
    }

    const manifestationId = found.manifestationId ?? DEFAULT_MANIFESTATION_ID;
    setCurrentManifestationId(manifestationId);
    setCurrentPage('carte');
    void persistAuthSession({
      userId: found.id,
      manifestationId,
      page: 'carte',
      savedAt: Date.now(),
    });

    // Commencer à tracker la position GPS réelle
    startLocationTracking();
  };

  const handleLogout = () => {
    setCurrentUser(null);
    setLoginUsername('');
    setLoginPassword('');
    setCurrentPage('carte');
    setCurrentLocation(null);
    setCurrentManifestationId(null);
    void persistAuthSession(null);
  };

  const handleCreateUser = async () => {
    if (!currentUser || !currentManifestationId) {
      Alert.alert('Erreur', 'Sélectionne d abord une manifestation.');
      return;
    }

    const username = newUsername.trim();
    const password = newPassword.trim();

    if (!username || !password) {
      Alert.alert('Erreur', 'Le nom d utilisateur et le mot de passe sont obligatoires.');
      return;
    }

    if (users.some((u: User) => u.username.toLowerCase() === username.toLowerCase())) {
      Alert.alert('Erreur', 'Ce nom d utilisateur existe deja.');
      return;
    }

    const nextUser: User = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      username,
      password,
      role: newRole,
      manifestationId: isGlobalAdminRole(newRole) ? undefined : currentManifestationId,
    };

    const nextUsers = [...users, nextUser];
    await persistUsers(nextUsers);
    setNewUsername('');
    setNewPassword('');
    setNewRole('participant');
  };

  const handleDeleteUser = async (userId: string) => {
    const target = users.find((u: User) => u.id === userId);
    if (!target) {
      return;
    }

    if (target.username === 'admin' && target.role === 'admin') {
      Alert.alert('Action impossible', 'Le compte admin par defaut ne peut pas etre supprime.');
      return;
    }

    const nextUsers = users.filter((u: User) => u.id !== userId);
    await persistUsers(nextUsers);

    const nextLocations = userLocations.filter((loc: UserLocation) => loc.userId !== userId);
    await persistUserLocations(nextLocations);

    if (useCloudSync) {
      await deleteCloudValue(`${CLOUD_LOCATIONS_PATH}/${userId}`);
    }

    if (currentUser?.id === userId) {
      handleLogout();
    }
  };

  const handleDeleteEvent = async (eventId: string) => {
    const nextEvents = events.filter((event) => event.id !== eventId);
    await persistEvents(nextEvents);

    if (activeEventId === eventId) {
      handleStopEventNavigation();
    }

    if (selectedEventId === eventId) {
      setSelectedEventId(null);
    }
  };

  const activeEvent = useMemo(() => {
    if (!activeEventId) {
      return null;
    }
    return currentManifestationEvents.find((event: EventItem) => event.id === activeEventId) ?? null;
  }, [activeEventId, currentManifestationEvents]);

  const activeEventPoints = useMemo(() => {
    if (!activeEvent) {
      return [] as EventTrackPoint[];
    }
    return parseGpxTrackPoints(activeEvent.gpxText);
  }, [activeEvent]);

  const activeRouteLengthMeters = useMemo(() => routeLengthMeters(activeEventPoints), [activeEventPoints]);
  const isParticipantNavigationActive = currentUser?.role === 'participant' && activeEventId !== null;

  const handleStartEventNavigation = () => {
    if (!selectedEventId || currentUser?.role !== 'participant') {
      return;
    }

    const eventToStart = currentManifestationEvents.find((event: EventItem) => event.id === selectedEventId);
    if (!eventToStart) {
      Alert.alert('Erreur', 'Évènement introuvable.');
      return;
    }

    const points = parseGpxTrackPoints(eventToStart.gpxText);
    if (points.length < 2) {
      Alert.alert('Erreur', 'Le parcours de cet évènement est invalide.');
      return;
    }

    setActiveEventId(eventToStart.id);
    setNavigationMode('normal');
    setDistanceTravelledMeters(0);
    setNavigationStartedAt(Date.now());
    previousNavigationPositionRef.current = currentLocation
      ? { latitude: currentLocation.latitude, longitude: currentLocation.longitude }
      : null;

    if (currentLocation) {
      let nearestIndex = 0;
      let nearestDistance = Number.POSITIVE_INFINITY;
      points.forEach((point, index) => {
        const distance = haversineDistanceMeters(currentLocation, point);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestIndex = index;
        }
      });
      setNextWaypointIndex(nearestIndex);
    } else {
      setNextWaypointIndex(0);
    }
  };

  const handleStopEventNavigation = () => {
    setActiveEventId(null);
    setNavigationMode('normal');
    setNextWaypointIndex(0);
    setDistanceTravelledMeters(0);
    setNavigationStartedAt(null);
    setCurrentSpeedKmh(0);
    setOffRouteDistanceMeters(0);
    setShowOffRouteAlert(false);
    setEmergencyCountdown(null);
    previousNavigationPositionRef.current = null;

    if (currentUser?.role === 'participant' && currentLocation) {
      updateUserLocation(
        currentUser.id,
        currentUser.username,
        currentLocation.latitude,
        currentLocation.longitude,
        currentHeadingRef.current,
        undefined
      );
    }
  };

  const triggerEmergency = async () => {
    if (!currentUser || !activeEvent || currentUser.role !== 'participant') {
      return;
    }

    const nextAlert: EmergencyAlert = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      userId: currentUser.id,
      username: currentUser.username,
      manifestationId: activeEvent.manifestationId,
      eventId: activeEvent.id,
      eventName: activeEvent.name,
      timestamp: Date.now(),
    };

    const nextAlerts = [nextAlert, ...emergencyAlerts].slice(0, 50);
    await persistEmergencyAlerts(nextAlerts);
    setEmergencyCountdown(5);
    Alert.alert('Urgence envoyee', 'Les administrateurs ont ete notifies. Appel auto dans 5 secondes.');
  };

  const handleDeleteEmergencyAlert = async (alertId: string) => {
    const nextAlerts = emergencyAlerts.filter((alert: EmergencyAlert) => alert.id !== alertId);
    await persistEmergencyAlerts(nextAlerts);
  };

  useEffect(() => {
    if (emergencyCountdown === null) {
      return;
    }

    if (emergencyCountdown <= 0) {
      setEmergencyCountdown(null);
      Linking.canOpenURL('tel:0788478285').then((canCall: boolean) => {
        if (canCall) {
          Linking.openURL('tel:0788478285');
        }
      });
      return;
    }

    const timer = setTimeout(() => {
      setEmergencyCountdown((previous: number | null) => (previous === null ? null : previous - 1));
    }, 1000);

    return () => clearTimeout(timer);
  }, [emergencyCountdown]);

  useEffect(() => {
    if (currentUser?.role !== 'participant' || !activeEventId) {
      deactivateKeepAwake('navigation-active');
      return;
    }

    activateKeepAwake('navigation-active');
    return () => {
      deactivateKeepAwake('navigation-active');
    };
  }, [currentUser?.role, activeEventId]);

  useEffect(() => {
    if (!currentUser) {
      return;
    }

    currentHeadingRef.current = currentHeading;
  }, [currentHeading]);

  useEffect(() => {
    if (!navigationStartedAt) {
      setElapsedSeconds(0);
      return;
    }

    const timer = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - navigationStartedAt) / 1000));
    }, 1000);

    return () => clearInterval(timer);
  }, [navigationStartedAt]);

  useEffect(() => {
    navigationModeRef.current = navigationMode;
  }, [navigationMode]);

  useEffect(() => {
    nextWaypointIndexRef.current = nextWaypointIndex;
  }, [nextWaypointIndex]);

  useEffect(() => {
    showOffRouteAlertRef.current = showOffRouteAlert;
  }, [showOffRouteAlert]);

  useEffect(() => {
    activeEventPointsRef.current = activeEventPoints;
  }, [activeEventPoints]);

  const fitNormalNavigationViewport = (
    locationPoint: { latitude: number; longitude: number } | null,
    routePoints: EventTrackPoint[],
    nextIndex: number,
    options?: { topPadding?: number; bottomPadding?: number }
  ) => {
    if (!mapRef.current || !locationPoint || routePoints.length < 2) {
      return;
    }

    const fromIndex = Math.min(Math.max(0, nextIndex), routePoints.length - 1);
    const nextPoints = routePoints.slice(fromIndex, Math.min(fromIndex + 10, routePoints.length));
    const pointsToFit = [locationPoint, ...nextPoints];

    if (pointsToFit.length < 2) {
      return;
    }

    const topPadding = options?.topPadding ?? 90;
    const bottomPadding = options?.bottomPadding ?? 150;

    mapRef.current.fitToCoordinates(pointsToFit, {
      edgePadding: {
        top: topPadding,
        right: 70,
        bottom: bottomPadding,
        left: 70,
      },
      animated: true,
    });
  };

  const handleRecenterMap = () => {
    if (!currentLocation) {
      return;
    }

    if (!mapRef.current) {
      if (Platform.OS === 'web') {
        const recenteredLocation = {
          latitude: MENDE_REGION.latitude,
          longitude: MENDE_REGION.longitude,
        };
        setCurrentLocation(recenteredLocation);
      }
      return;
    }

    mapRef.current.animateToRegion(
      {
        latitude: currentLocation.latitude,
        longitude: currentLocation.longitude,
        latitudeDelta: 0.04,
        longitudeDelta: 0.02,
      },
      500
    );
  };

  const extractLayout = (event: LayoutChangeEvent) => {
    const { y, height } = event.nativeEvent.layout;
    return { y, height };
  };

  const computeTopViewportPadding = () => {
    let coveredFromTop = 0;
    if (mapNoticeLayout) {
      coveredFromTop = Math.max(coveredFromTop, mapNoticeLayout.y + mapNoticeLayout.height);
    }
    if (adminEmergencyLayout) {
      coveredFromTop = Math.max(coveredFromTop, adminEmergencyLayout.y + adminEmergencyLayout.height);
    }
    return Math.max(90, Math.ceil(coveredFromTop) + 16);
  };

  const computeBottomViewportPadding = () => {
    if (mapContainerHeight <= 0) {
      return 150;
    }

    let coveredFromBottom = 0;
    if (participantPanelLayout) {
      coveredFromBottom = Math.max(coveredFromBottom, mapContainerHeight - participantPanelLayout.y);
    }
    if (navigationStatsLayout) {
      coveredFromBottom = Math.max(coveredFromBottom, mapContainerHeight - navigationStatsLayout.y);
    }

    return Math.max(150, Math.ceil(coveredFromBottom) + 16);
  };

  useEffect(() => {
    if (currentUser?.role !== 'participant' || !activeEventId) {
      return;
    }

    const topPadding = computeTopViewportPadding();
    const bottomPadding = computeBottomViewportPadding();
    fitNormalNavigationViewport(currentLocation, activeEventPoints, nextWaypointIndex, {
      topPadding,
      bottomPadding,
    });
  }, [
    activeEventId,
    activeEventPoints,
    currentLocation,
    currentUser?.role,
    mapContainerHeight,
    mapNoticeLayout,
    nextWaypointIndex,
    participantPanelLayout,
    adminEmergencyLayout,
    navigationStatsLayout,
  ]);

  useEffect(() => {
    if (!currentUser) {
      return;
    }

    let locationSubscription: Location.LocationSubscription | null = null;
    let headingSubscription: Location.LocationSubscription | null = null;
    let webSimulationTimer: ReturnType<typeof setInterval> | null = null;
    let isMounted = true;

    const startWatcher = async () => {
      const permission = await requestLocationPermission();
      if (!permission || !isMounted) {
        return;
      }

      if (Platform.OS === 'web') {
        let simulatedLocation = generateMockLocation(currentLocation);

        webSimulationTimer = setInterval(async () => {
          simulatedLocation = generateMockLocation(simulatedLocation);
          const simulatedHeading = normalizeDegrees(currentHeadingRef.current + (Math.random() - 0.5) * 25);

          setCurrentHeading(simulatedHeading);
          setCurrentSpeedKmh(3 + Math.random() * 4);
          setCurrentLocation(simulatedLocation);

          await updateUserLocation(
            currentUser.id,
            currentUser.username,
            simulatedLocation.latitude,
            simulatedLocation.longitude,
            simulatedHeading,
            currentUser.role === 'participant' ? activeEventId ?? undefined : undefined
          );
        }, 2000);

        return;
      }

      try {
        headingSubscription = await Location.watchHeadingAsync((heading: Location.LocationHeadingObject) => {
          const compassHeading = heading.trueHeading >= 0 ? heading.trueHeading : heading.magHeading;
          if (typeof compassHeading === 'number' && compassHeading >= 0) {
            setCurrentHeading(compassHeading);
          }
        });
      } catch (error) {
        console.error('Erreur boussole:', error);
      }

      locationSubscription = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.BestForNavigation,
          timeInterval: 1500,
          distanceInterval: 1,
        },
        async (location: Location.LocationObject) => {
          const updatedLocation = {
            latitude: location.coords.latitude,
            longitude: location.coords.longitude,
          };

          setCurrentLocation(updatedLocation);
          const speed = location.coords.speed ?? 0;
          setCurrentSpeedKmh(Math.max(0, speed * 3.6));

          if (typeof location.coords.heading === 'number' && location.coords.heading >= 0) {
            setCurrentHeading(location.coords.heading);
          }

          await updateUserLocation(
            currentUser.id,
            currentUser.username,
            updatedLocation.latitude,
            updatedLocation.longitude,
            typeof location.coords.heading === 'number' && location.coords.heading >= 0
              ? location.coords.heading
              : currentHeadingRef.current,
            currentUser.role === 'participant' ? activeEventId ?? undefined : undefined
          );

          const currentEventPoints = activeEventPointsRef.current;
          if (currentUser.role !== 'participant' || !activeEventId || currentEventPoints.length < 2) {
            return;
          }

          const previous = previousNavigationPositionRef.current;
          if (previous) {
            const stepDistance = haversineDistanceMeters(previous, updatedLocation);
            if (stepDistance <= 200) {
              setDistanceTravelledMeters((value: number) => value + stepDistance);
            }
          }
          previousNavigationPositionRef.current = updatedLocation;
          const currentTarget = currentEventPoints[Math.min(nextWaypointIndexRef.current, currentEventPoints.length - 1)];
          const distanceToTarget = haversineDistanceMeters(updatedLocation, currentTarget);
          if (distanceToTarget < 15 && nextWaypointIndexRef.current < currentEventPoints.length - 1) {
            setNextWaypointIndex((value: number) => Math.min(value + 1, currentEventPoints.length - 1));
          }

          const routeDistance = distanceToPolylineMeters(updatedLocation, currentEventPoints);
          setOffRouteDistanceMeters(routeDistance);

          if (routeDistance > 10 && !showOffRouteAlertRef.current) {
            setShowOffRouteAlert(true);
            Alert.alert('Alerte parcours', 'Tu t éloignes du parcours de plus de 10 m.');
          }

          if (routeDistance <= 10 && showOffRouteAlertRef.current) {
            setShowOffRouteAlert(false);
          }

          if (navigationModeRef.current === 'normal' && mapRef.current) {
            const topPadding = computeTopViewportPadding();
            const bottomPadding = computeBottomViewportPadding();
            fitNormalNavigationViewport(
              updatedLocation,
              currentEventPoints,
              nextWaypointIndexRef.current,
              {
                topPadding,
                bottomPadding,
              }
            );
          }
        }
      );
    };

    startWatcher();

    return () => {
      isMounted = false;
      if (webSimulationTimer) {
        clearInterval(webSimulationTimer);
      }
      if (locationSubscription) {
        locationSubscription.remove();
      }
      if (headingSubscription) {
        headingSubscription.remove();
      }
    };
  }, [
    activeEventId,
    adminEmergencyLayout,
    currentUser,
    emergencyAlerts.length,
    mapContainerHeight,
    mapNoticeLayout,
    participantPanelLayout,
  ]);

  const isParticipantNormalNavigation =
    currentUser?.role === 'participant' && activeEventId !== null;

  const handleUpdateAccount = async () => {
    if (!currentUser) {
      return;
    }

    const username = accountUsername.trim();
    const password = accountPassword.trim();

    if (!username || !password) {
      Alert.alert('Erreur', 'Le nom d utilisateur et le mot de passe sont obligatoires.');
      return;
    }

    const isDuplicateUsername = users.some(
      (u: User) => u.id !== currentUser.id && u.username.toLowerCase() === username.toLowerCase()
    );
    if (isDuplicateUsername) {
      Alert.alert('Erreur', 'Ce nom d utilisateur existe deja.');
      return;
    }

    const updatedUser: User = {
      ...currentUser,
      username,
      password,
      preferredMapType: accountMapType,
    };

    const nextUsers = users.map((u: User) => (u.id === currentUser.id ? updatedUser : u));
    await persistUsers(nextUsers);
    setCurrentUser(updatedUser);
    void persistAuthSession({
      userId: updatedUser.id,
      manifestationId: updatedUser.manifestationId ?? null,
      page: currentUser.role === 'participant' ? 'carte' : currentPage,
      savedAt: Date.now(),
    });

    if (currentUser.username !== username) {
      const nextLocations = userLocations.map((loc: UserLocation) =>
        loc.userId === currentUser.id ? { ...loc, username } : loc
      );
      await persistUserLocations(nextLocations);
    }

    Alert.alert('Succès', 'Ton compte a ete mis a jour.');
  };

  useEffect(() => {
    if (!isParticipantNormalNavigation || !mapRef.current || !currentLocation) {
      return;
    }

    const animationConfig = {
      bearing: normalizeDegrees(currentHeading),
      duration: 500,
    };

    if (mapRef.current.animateCamera) {
      mapRef.current.animateCamera(animationConfig, { duration: 500 });
    } else if (mapRef.current.setCamera) {
      mapRef.current.setCamera(animationConfig);
    }
  }, [currentHeading, isParticipantNormalNavigation, currentLocation]);

  const visibleEvents: VisibleEvent[] = useMemo(() => {
    if (!currentUser) {
      return [];
    }

    const nextVisibleEvents: VisibleEvent[] = [];

    currentManifestationEvents.forEach((event: EventItem) => {
      const points = parseGpxTrackPoints(event.gpxText);
      if (points.length >= 2 && isEventVisibleForUser(event, currentUser.role)) {
        nextVisibleEvents.push({
          event,
          index: nextVisibleEvents.length,
          points,
        });
      }
    });

    return nextVisibleEvents;
  }, [currentManifestationEvents, currentUser]);

  const sortedEvents = useMemo(() => {
    return [...currentManifestationEvents].sort((left, right) => {
      const leftStamp = `${left.date} ${left.startTime}`;
      const rightStamp = `${right.date} ${right.startTime}`;
      return leftStamp.localeCompare(rightStamp);
    });
  }, [currentManifestationEvents]);

  const selectedEvent = useMemo(() => {
    if (!selectedEventId) {
      return null;
    }
    return currentManifestationEvents.find((event: EventItem) => event.id === selectedEventId) ?? null;
  }, [currentManifestationEvents, selectedEventId]);

  const selectedEventPoints = useMemo(
    () => (selectedEvent ? parseGpxTrackPoints(selectedEvent.gpxText) : []),
    [selectedEvent]
  );

  const nextWaypoint = useMemo(() => {
    if (!activeEventPoints.length) {
      return null;
    }
    return activeEventPoints[Math.min(nextWaypointIndex, activeEventPoints.length - 1)] ?? null;
  }, [activeEventPoints, nextWaypointIndex]);

  const remainingDistanceMeters = useMemo(() => {
    if (!currentLocation || !nextWaypoint || activeEventPoints.length < 2) {
      return Math.max(0, activeRouteLengthMeters - distanceTravelledMeters);
    }

    let remaining = haversineDistanceMeters(currentLocation, nextWaypoint);
    for (let i = nextWaypointIndex; i < activeEventPoints.length - 1; i += 1) {
      remaining += haversineDistanceMeters(activeEventPoints[i], activeEventPoints[i + 1]);
    }
    return remaining;
  }, [
    activeEventPoints,
    activeRouteLengthMeters,
    currentLocation,
    distanceTravelledMeters,
    nextWaypoint,
    nextWaypointIndex,
  ]);

  const averageSpeedKmh = useMemo(() => {
    if (!navigationStartedAt) {
      return 0;
    }

    const elapsedHours = (Date.now() - navigationStartedAt) / 3600000;
    if (elapsedHours <= 0) {
      return 0;
    }

    return (distanceTravelledMeters / 1000) / elapsedHours;
  }, [distanceTravelledMeters, navigationStartedAt]);

  const directionToNextPoint = useMemo(() => {
    if (!currentLocation || !nextWaypoint) {
      return 0;
    }

    const bearing = bearingDegrees(currentLocation, nextWaypoint);
    return normalizeDegrees(bearing - currentHeading);
  }, [currentHeading, currentLocation, nextWaypoint]);

  const emergencyAlertsForAdmins = useMemo(
    () => currentManifestationAlerts.slice(0, 5),
    [currentManifestationAlerts]
  );

  const displayedUserLocations = isOffline ? lastKnownUserLocations : currentManifestationLocations;
  const visibleUserLocations = useMemo(() => {
    return displayedUserLocations.filter((location) => {
      const user = users.find((candidate) => candidate.id === location.userId);
      return user ? !isGlobalAdminRole(user.role) : false;
    });
  }, [displayedUserLocations, users]);

  const mapInitialRegion = currentLocation
    ? {
        latitude: currentLocation.latitude,
        longitude: currentLocation.longitude,
        latitudeDelta: isOffline ? 0.7 : 0.0922,
        longitudeDelta: isOffline ? 0.7 : 0.0421,
      }
    : DEFAULT_MAP_REGION;

  const showOfflineOverlay = currentPage === 'carte' && isOffline;
  const showMapNoticeOverlay = (!currentLocation && Platform.OS !== 'web') || Platform.OS === 'web';
  const showParticipantPanelOverlay =
    currentPage === 'carte' && currentUser?.role === 'participant';
  const showAdminEmergencyOverlay =
    currentPage === 'carte' && isManifestationAdminRole(currentUser?.role ?? 'participant') && emergencyAlertsForAdmins.length > 0;

  useEffect(() => {
    if (!showMapNoticeOverlay) {
      setMapNoticeLayout(null);
    }
    if (!showParticipantPanelOverlay) {
      setParticipantPanelLayout(null);
    }
    if (!showAdminEmergencyOverlay) {
      setAdminEmergencyLayout(null);
    }
  }, [showAdminEmergencyOverlay, showMapNoticeOverlay, showParticipantPanelOverlay]);

  const currentManifestationDisplayName = currentManifestation?.name ?? 'Aucune manifestation sélectionnée';
  const appLogoSource = require('./assets/logo intersport.bmp');

  if (!useCloudSync) {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={styles.screen}>
          <StatusBar style="dark" />
          <View style={styles.centered}>
            <Text style={styles.title}>Configuration requise</Text>
            <Text style={styles.subtitle}>
              Pour que comptes, évènements et positions soient communs entre tous les appareils
              (Android, iPhone, web), renseigne EXPO_PUBLIC_FIREBASE_DATABASE_URL ou expo.extra.databaseURL.
            </Text>
          </View>
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  if (!isReady) {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={styles.screen}>
          <StatusBar style="dark" />
          <View style={styles.centered}>
            <Image source={appLogoSource} style={styles.splashLogo} />
            <Text style={styles.title}>Chargement...</Text>
          </View>
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  if (!currentUser) {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={styles.screen}>
          <StatusBar style="dark" />
          <KeyboardAvoidingView
            style={styles.flex1}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            <View style={styles.authContainer}>
              <Image source={appLogoSource} style={styles.authLogo} />
              <Text style={styles.appName}>TOC Lozère</Text>
              <Text style={styles.subtitle}>Connexion</Text>

              <TextInput
                style={styles.input}
                placeholder="Nom d utilisateur"
                value={loginUsername}
                onChangeText={setLoginUsername}
                autoCapitalize="none"
              />
              <TextInput
                style={styles.input}
                placeholder="Mot de passe"
                value={loginPassword}
                onChangeText={setLoginPassword}
                secureTextEntry
              />

              <Pressable style={styles.button} onPress={handleLogin}>
                <Text style={styles.buttonText}>Se connecter</Text>
              </Pressable>
            </View>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.screen}>
      <StatusBar style="dark" />
      {!isParticipantNavigationActive && (
        <View style={styles.panelHeader}>
          <View>
            <Text style={styles.panelTitle}>Bonjour {currentUser.username}</Text>
            <Text style={styles.panelSubtitle}>
              {getRoleLabel(currentUser.role)}
              {currentManifestation ? ` · ${currentManifestation.name}` : ''}
            </Text>
          </View>
          <Pressable style={styles.headerActionButton} onPress={handleLogout}>
            <Text style={styles.headerActionButtonText}>Deconnexion</Text>
          </Pressable>
        </View>
      )}

      {/* Navigation tabs */}
      {!isParticipantNavigationActive && (
        <View style={styles.navTabs}>
          {isGlobalAdminRole(currentUser.role) && (
            <Pressable
              style={[styles.navTab, currentPage === 'manifestations' && styles.navTabActive]}
              onPress={() => setCurrentPage('manifestations')}
            >
              <Text
                style={[
                  styles.navTabText,
                  currentPage === 'manifestations' && styles.navTabTextActive,
                ]}
              >
                Manifestations
              </Text>
            </Pressable>
          )}
          <Pressable
            style={[styles.navTab, currentPage === 'carte' && styles.navTabActive]}
            onPress={() => setCurrentPage('carte')}
          >
            <Text style={[styles.navTabText, currentPage === 'carte' && styles.navTabTextActive]}>
              Carte
            </Text>
          </Pressable>
          <Pressable
            style={[styles.navTab, currentPage === 'compte' && styles.navTabActive]}
            onPress={() => setCurrentPage('compte')}
          >
            <Text style={[styles.navTabText, currentPage === 'compte' && styles.navTabTextActive]}>
              Mon Compte
            </Text>
          </Pressable>
          {isManifestationAdminRole(currentUser.role) && (
            <Pressable
              style={[styles.navTab, currentPage === 'admin' && styles.navTabActive]}
              onPress={() => setCurrentPage('admin')}
            >
              <Text style={[styles.navTabText, currentPage === 'admin' && styles.navTabTextActive]}>
                Admin
              </Text>
            </Pressable>
          )}
        </View>
      )}

      {/* Content pages */}
      {currentPage === 'manifestations' && isGlobalAdminRole(currentUser.role) ? (
        <ScrollView style={styles.pageContainer} contentContainerStyle={styles.pageContent}>
          <View style={styles.adminContainer}>
            <Text style={styles.sectionTitle}>Sélecteur de manifestation</Text>
            <Text style={styles.accountSubtitle}>
              {currentManifestation
                ? `Manifestation active: ${currentManifestation.name}`
                : 'Choisis une manifestation pour ouvrir son espace.'}
            </Text>

            <View style={styles.manifestationCreateCard}>
              <Text style={styles.sectionTitle}>Créer une manifestation</Text>
              <TextInput
                style={styles.input}
                placeholder="Nom de la manifestation"
                value={manifestationName}
                onChangeText={setManifestationName}
              />
              <Pressable style={styles.button} onPress={handleCreateManifestation}>
                <Text style={styles.buttonText}>Créer la manifestation</Text>
              </Pressable>
            </View>

            <Text style={styles.sectionTitle}>Manifestations existantes</Text>
            <View style={styles.listGap}>
              {manifestations.length === 0 ? (
                <Text style={styles.emptyText}>Aucune manifestation enregistrée.</Text>
              ) : (
                manifestations.map((manifestation) => {
                  const isSelected = manifestation.id === currentManifestationId;
                  return (
                    <View key={manifestation.id} style={styles.manifestationCard}>
                      <View>
                        <Text style={styles.userName}>{manifestation.name}</Text>
                        <Text style={styles.userRole}>
                          Créée le {new Date(manifestation.createdAt).toLocaleDateString()}
                        </Text>
                      </View>
                      <View style={styles.manifestationActions}>
                        <Pressable
                          style={[styles.manifestationActionButton, isSelected && styles.manifestationActionButtonActive]}
                          onPress={() => handleSelectManifestation(manifestation.id)}
                        >
                          <Text style={[styles.manifestationActionButtonText, isSelected && styles.manifestationActionButtonTextActive]}>
                            {isSelected ? 'Ouverte' : 'Ouvrir'}
                          </Text>
                        </Pressable>
                        <Pressable
                          style={styles.manifestationDeleteButton}
                          onPress={() => handleDeleteManifestation(manifestation.id)}
                        >
                          <Text style={styles.manifestationDeleteButtonText}>Supprimer</Text>
                        </Pressable>
                      </View>
                    </View>
                  );
                })
              )}
            </View>
          </View>
        </ScrollView>
      ) : currentPage === 'carte' ? (
        <View
          style={styles.carteContainer}
          onLayout={(event: LayoutChangeEvent) => {
            setMapContainerHeight(event.nativeEvent.layout.height);
          }}
        >
              {canRenderNativeMap ? (
                <MapView
                  ref={(instance: any) => {
                    mapRef.current = instance;
                  }}
                  style={styles.map}
                  initialRegion={mapInitialRegion}
                  mapType={mapType}
                  rotateEnabled={currentUser.role === 'participant' && activeEventId !== null}
                >
                  {currentLocation && !isGlobalAdminRole(currentUser.role) && (
                    isParticipantNormalNavigation ? (
                      <Marker
                        coordinate={{
                          latitude: currentLocation.latitude,
                          longitude: currentLocation.longitude,
                        }}
                        title="Ma position"
                        description={currentUser.username}
                        anchor={{ x: 0.5, y: 0.5 }}
                        flat
                        tracksViewChanges
                      >
                        <View style={styles.participantArrowContainer}>
                          <Text
                            style={[
                              styles.participantArrowGlyph,
                              {
                                color: '#2563eb',
                                /* Counter-rotate the glyph so it stays pointing up on screen
                                   while the map rotates to match the participant heading */
                                transform: [{ rotate: `${-normalizeDegrees(currentHeading)}deg` }],
                              },
                            ]}
                          >
                            ▲
                          </Text>
                        </View>
                      </Marker>
                    ) : (
                      <Marker
                        coordinate={{
                          latitude: currentLocation.latitude,
                          longitude: currentLocation.longitude,
                        }}
                        title="Ma position"
                        description={currentUser.username}
                        pinColor={getMarkerColorByRole(currentUser.role)}
                      />
                    )
                  )}

                  {visibleUserLocations.map((location: UserLocation) => {
                    if (location.userId === currentUser.id) return null;
                    const user = currentManifestationUsers.find((u: User) => u.id === location.userId);
                    if (!user) return null;

                    const isFollowingEventParticipant =
                      user.role === 'participant' && Boolean(location.isFollowingEvent);
                    const showFollowingArrowForSupervisor =
                      (isManifestationAdminRole(currentUser.role) || currentUser.role === 'benevole') &&
                      isFollowingEventParticipant;

                    if (isParticipantNormalNavigation && user.role !== 'participant') {
                      return null;
                    }

                    if (isParticipantNormalNavigation) {
                      return (
                        <Marker
                          key={location.userId}
                          coordinate={{
                            latitude: location.latitude,
                            longitude: location.longitude,
                          }}
                          title={location.username}
                          description="Participant"
                          anchor={{ x: 0.5, y: 0.5 }}
                          flat
                          tracksViewChanges
                        >
                          <View style={styles.participantArrowContainer}>
                            <Text
                              style={[
                                styles.participantArrowGlyph,
                                ({
                                  color: '#dc2626',
                                  /* Rotate other participants' glyphs relative to current heading
                                     so arrows point in their travel direction on screen */
                                  transform: [
                                    {
                                      rotate: `${normalizeDegrees((location.heading ?? 0) - currentHeading)}deg`,
                                    },
                                  ],
                                }),
                              ]}
                            >
                              ▲
                            </Text>
                          </View>
                        </Marker>
                      );
                    }

                    if (showFollowingArrowForSupervisor) {
                      return (
                        <Marker
                          key={location.userId}
                          coordinate={{
                            latitude: location.latitude,
                            longitude: location.longitude,
                          }}
                          title={location.username}
                          description="Participant en suivi d'évènement"
                          anchor={{ x: 0.5, y: 0.5 }}
                          flat
                          tracksViewChanges
                        >
                          <View style={styles.participantArrowContainer}>
                            <Text
                              style={[
                                styles.participantArrowGlyph,
                                {
                                  color: '#ff8c42',
                                  transform: [
                                    {
                                      rotate: `${normalizeDegrees((location.heading ?? 0) - currentHeading)}deg`,
                                    },
                                  ],
                                },
                              ]}
                            >
                              ▲
                            </Text>
                          </View>
                        </Marker>
                      );
                    }

                    return (
                      <Marker
                        key={location.userId}
                        coordinate={{
                          latitude: location.latitude,
                          longitude: location.longitude,
                        }}
                        title={location.username}
                        description={`Role: ${user.role}`}
                        pinColor={getMarkerColorByRole(user.role)}
                      />
                    );
                  })}

                  {visibleEvents.map((visibleEvent: VisibleEvent) => {
                    const { event, index, points } = visibleEvent;
                    const color = EVENT_COLORS[index % EVENT_COLORS.length];
                    const isSelected = event.id === selectedEventId;
                    const isActive = event.id === activeEventId;

                    return (
                      <Fragment key={`event-${event.id}`}>
                        <Polyline
                          key={`polyline-${event.id}`}
                          coordinates={points}
                          strokeColor={isActive ? '#FFFF00' : isSelected ? '#000000' : color}
                          strokeWidth={isSelected || isActive ? 6 : 4}
                        />
                        <Marker
                          key={`marker-${event.id}`}
                          coordinate={points[0]}
                          title={event.name}
                          description={`${event.date}${event.startTime ? ` ${event.startTime}` : ''}${event.endTime ? ` - ${event.endTime}` : ''}`}
                          pinColor={isActive ? '#FFFF00' : isSelected ? '#000000' : color}
                          onPress={() => {
                            if (currentUser.role === 'participant') {
                              setSelectedEventId(event.id);
                            }
                          }}
                        />
                      </Fragment>
                    );
                  })}
                </MapView>
              ) : (
                <View style={styles.mapWebFallback}>
                  <Text style={styles.mapWebFallbackTitle}>Mode Web ordinateur</Text>
                  <Text style={styles.mapWebFallbackText}>
                    Carte native indisponible ici. La position est simulée autour de Mende (48).
                  </Text>
                  {currentLocation && (
                    <Text style={styles.mapWebFallbackCoords}>
                      Position simulée: {currentLocation.latitude.toFixed(5)}, {currentLocation.longitude.toFixed(5)}
                    </Text>
                  )}
                </View>
              )}

              {currentLocation && !isParticipantNavigationActive && (
                <Pressable
                  style={[
                    styles.recenterButton,
                    currentUser.role === 'participant' && participantPanelLayout && {
                      bottom: 132 + participantPanelLayout.height + 20,
                    },
                  ]}
                  onPress={handleRecenterMap}
                >
                  <Text style={styles.recenterButtonText}>Recentrer</Text>
                </Pressable>
              )}

              {!currentLocation && Platform.OS !== 'web' && (
                <View
                  style={styles.mapNotice}
                  pointerEvents="none"
                  onLayout={(event: LayoutChangeEvent) => {
                    setMapNoticeLayout(extractLayout(event));
                  }}
                >
                  <Text style={styles.mapNoticeText}>
                    Position GPS indisponible. La carte affiche quand meme les évènements.
                  </Text>
                </View>
              )}

              {Platform.OS === 'web' && (
                <View
                  style={styles.mapNotice}
                  pointerEvents="none"
                  onLayout={(event: LayoutChangeEvent) => {
                    setMapNoticeLayout(extractLayout(event));
                  }}
                >
                  <Text style={styles.mapNoticeText}>
                    Session web détectée: position simulée sur Mende (48).
                  </Text>
                </View>
              )}

              {showOfflineOverlay && (
                <View style={styles.offlineNotice} pointerEvents="none">
                  <Text style={styles.offlineNoticeText}>
                    Mode hors connexion : dernières positions connues affichées.
                  </Text>
                </View>
              )}

              {currentUser.role === 'participant' && !activeEventId && (
                <View
                  style={[
                    styles.participantPanel,
                    activeEventId ? styles.participantPanelActive : undefined,
                  ]}
                  onLayout={(event: LayoutChangeEvent) => {
                    setParticipantPanelLayout(extractLayout(event));
                  }}
                >
                  {!activeEventId ? (
                    <>
                      <Text style={styles.participantPanelTitle}>Sélection de l'évènement</Text>
                      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.eventSelectorRow}>
                        {visibleEvents.map(({ event }) => (
                          <Pressable
                            key={event.id}
                            style={[
                              styles.eventSelectorCard,
                              selectedEventId === event.id && styles.eventSelectorCardActive,
                            ]}
                            onPress={() => setSelectedEventId(event.id)}
                          >
                            <Text style={styles.eventSelectorTitle}>{event.name}</Text>
                            <Text style={styles.eventSelectorMeta}>{event.date}</Text>
                          </Pressable>
                        ))}
                      </ScrollView>
                      {selectedEvent && (
                        <Pressable style={styles.button} onPress={handleStartEventNavigation}>
                          <Text style={styles.buttonText}>Lancer l'évènement</Text>
                        </Pressable>
                      )}
                    </>
                  ) : (
                    <>
                      <Text style={styles.participantPanelTitle}>{activeEvent?.name ?? 'Navigation en cours'}</Text>
                      <View style={styles.actionRow}>
                        <Pressable style={styles.urgencyButton} onPress={triggerEmergency}>
                          <Text style={styles.urgencyButtonText}>
                            Urgence {emergencyCountdown !== null ? `(${emergencyCountdown}s)` : ''}
                          </Text>
                        </Pressable>
                        <Pressable style={styles.secondaryButton} onPress={handleStopEventNavigation}>
                          <Text style={styles.secondaryButtonText}>Arrêter</Text>
                        </Pressable>
                      </View>
                    </>
                  )}
                </View>
              )}

              {isManifestationAdminRole(currentUser.role) && emergencyAlertsForAdmins.length > 0 && (
                <View
                  style={styles.adminEmergencyPanel}
                  onLayout={(event: LayoutChangeEvent) => {
                    setAdminEmergencyLayout(extractLayout(event));
                  }}
                >
                  <Text style={styles.adminEmergencyTitle}>Alertes urgences participants (appuie pour supprimer)</Text>
                  {emergencyAlertsForAdmins.map((alert) => (
                    <Pressable
                      key={alert.id}
                      style={styles.adminEmergencyItemButton}
                      onPress={() => handleDeleteEmergencyAlert(alert.id)}
                    >
                      <Text style={styles.adminEmergencyItem}>
                        {alert.username} - {alert.eventName} ({new Date(alert.timestamp).toLocaleTimeString()})
                      </Text>
                    </Pressable>
                  ))}
                </View>
              )}

              {/* Stats de navigation */}
              {isParticipantNavigationActive && (
                <View
                  style={styles.navigationStats}
                  onLayout={(event: LayoutChangeEvent) => {
                    setNavigationStatsLayout(extractLayout(event));
                  }}
                >
                  <View style={styles.statsRow}>
                    <View style={styles.statCard}>
                      <Text style={styles.statLabel}>Vitesse</Text>
                      <Text style={styles.statValue}>{currentSpeedKmh.toFixed(1)} km/h</Text>
                    </View>
                    <View style={styles.statCard}>
                      <Text style={styles.statLabel}>Distance</Text>
                      <Text style={styles.statValue}>{formatKm(distanceTravelledMeters)}</Text>
                    </View>
                  </View>
                  <View style={styles.statsRow}>
                    <View style={styles.statCard}>
                      <Text style={styles.statLabel}>Total</Text>
                      <Text style={styles.statValue}>{formatKm(activeRouteLengthMeters)}</Text>
                    </View>
                    <View style={styles.statCard}>
                      <Text style={styles.statLabel}>Moyenne</Text>
                      <Text style={styles.statValue}>{averageSpeedKmh.toFixed(1)} km/h</Text>
                    </View>
                  </View>
                  <View style={styles.statsRow}>
                    <View style={[styles.statCard, { flex: 1 }]}>
                      <Text style={styles.statLabel}>Temps</Text>
                      <Text style={styles.statValue}>{formatElapsedTime(elapsedSeconds)}</Text>
                    </View>
                    <Pressable style={styles.emergencyButtonSmall} onPress={triggerEmergency}>
                      <Text style={styles.emergencyButtonSmallText}>
                        Urgence {emergencyCountdown !== null ? `(${emergencyCountdown}s)` : ''}
                      </Text>
                    </Pressable>
                    <Pressable style={styles.stopButtonSmall} onPress={handleStopEventNavigation}>
                      <Text style={styles.stopButtonSmallText}>Arrêter</Text>
                    </Pressable>
                  </View>
                </View>
              )}

        </View>
      ) : currentPage === 'compte' ? (
        <ScrollView style={styles.pageContainer} contentContainerStyle={styles.pageContent}>
          <View style={styles.accountContainer}>
            <View style={styles.accountAvatar}>
              <View style={styles.accountAvatarHead} />
              <View style={styles.accountAvatarBody} />
            </View>
            <Text style={styles.accountTitle}>Mon Compte</Text>
            <Text style={styles.accountSubtitle}>Modifie ton nom d utilisateur et ton mot de passe.</Text>

            <TextInput
              style={styles.input}
              placeholder="Nouveau nom d utilisateur"
              value={accountUsername}
              onChangeText={setAccountUsername}
              autoCapitalize="none"
            />
            <TextInput
              style={styles.input}
              placeholder="Nouveau mot de passe"
              value={accountPassword}
              onChangeText={setAccountPassword}
              secureTextEntry
            />

            <View style={styles.eventFieldGroup}>
              <Text style={styles.eventFieldLabel}>Fond de carte</Text>
              <View style={styles.modeSwitchRow}>
                {(['standard', 'satellite', 'hybrid'] as MapType[]).map((type) => (
                  <Pressable
                    key={type}
                    style={[
                      styles.modeButton,
                      accountMapType === type && styles.modeButtonActive,
                    ]}
                    onPress={() => {
                      setAccountMapType(type);
                      setMapType(type);
                    }}
                  >
                    <Text
                      style={[
                        styles.modeButtonText,
                        accountMapType === type && styles.modeButtonTextActive,
                      ]}
                    >
                      {type === 'standard' ? 'Normal' : type === 'satellite' ? 'Satellite' : 'Hybride'}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>

            <Pressable style={styles.button} onPress={handleUpdateAccount}>
              <Text style={styles.buttonText}>Enregistrer mes modifications</Text>
            </Pressable>
          </View>
        </ScrollView>
      ) : isManifestationAdminRole(currentUser.role) ? (
        <ScrollView style={styles.pageContainer} contentContainerStyle={styles.pageContent}>
          <View style={styles.adminContainer}>
            <Text style={styles.sectionTitle}>Créer un évènement</Text>
            <TextInput
              style={styles.input}
              placeholder="Nom de l'évènement (ex: Trail des Sources)"
              value={eventName}
              onChangeText={setEventName}
            />
            <View style={styles.eventFieldGroup}>
              <Text style={styles.eventFieldLabel}>Date</Text>
              <Pressable
                style={styles.selectorField}
                onPress={openEventDatePicker}
              >
                <Text style={eventDate ? styles.selectorText : styles.selectorPlaceholderText}>
                  {eventDate || 'Sélectionner la date'}
                </Text>
              </Pressable>
            </View>
            <View style={styles.checkboxRow}>
              <Pressable
                style={[styles.checkbox, eventVisibleForVolunteers && styles.checkboxActive]}
                onPress={() => setEventVisibleForVolunteers((value) => !value)}
              >
                {eventVisibleForVolunteers ? <View style={styles.checkboxDot} /> : null}
              </Pressable>
              <Text style={styles.checkboxLabel}>Afficher pour bénévoles</Text>
            </View>
            <Pressable style={styles.secondaryButton} onPress={handlePickGpxFile}>
              <Text style={styles.secondaryButtonText}>Choisir un fichier GPX</Text>
            </Pressable>
            <Text style={styles.helperText}>
              {eventGpxFileName
                ? `Fichier sélectionné: ${eventGpxFileName}`
                : 'Aucun fichier sélectionné.'}
            </Text>
            <View style={styles.gpxPreviewBox}>
              <Text style={styles.gpxPreviewLabel}>Statut GPX</Text>
              <Text style={styles.gpxPreviewText} numberOfLines={3}>
                {eventGpxText ? 'Le fichier a été chargé et est prêt à être enregistré.' : 'En attente de sélection.'}
              </Text>
            </View>

            <Pressable style={styles.button} onPress={handleCreateEvent}>
              <Text style={styles.buttonText}>Creer l'évènement</Text>
            </Pressable>

            <Text style={styles.sectionTitle}>Évènements enregistrés</Text>
            {sortedEvents.length === 0 ? (
              <Text style={styles.emptyText}>Aucun évènement pour le moment.</Text>
            ) : (
              <View style={styles.eventList}>
                {sortedEvents.map((event) => {
                  const trackPoints = parseGpxTrackPoints(event.gpxText);
                  const visibilityLabel = event.showForVolunteers
                    ? 'Bénévoles + admins'
                    : 'Visible aujourd hui pour tous';
                  const isToday = event.date === getLocalDateKey(new Date());

                  return (
                    <View key={event.id} style={styles.eventCard}>
                      <View style={styles.eventCardHeader}>
                        <View style={styles.eventCardTitleBlock}>
                          <Text style={styles.eventCardTitle}>{event.name}</Text>
                          <Text style={styles.eventCardMeta}>
                            {event.date} {isToday ? '(aujourd hui)' : ''}
                          </Text>
                          {(event.startTime || event.endTime) ? (
                            <Text style={styles.eventCardMeta}>
                              {event.startTime}
                              {event.startTime && event.endTime ? ' - ' : ''}
                              {event.endTime}
                            </Text>
                          ) : null}
                        </View>
                        <View style={styles.eventHeaderActions}>
                          <View style={styles.eventBadge}>
                            <Text style={styles.eventBadgeText}>{visibilityLabel}</Text>
                          </View>
                          <Pressable
                            style={styles.deleteEventButton}
                            onPress={() => handleDeleteEvent(event.id)}
                          >
                            <Text style={styles.deleteEventButtonText}>Supprimer</Text>
                          </Pressable>
                        </View>
                      </View>
                      <Text style={styles.eventCardMeta}>{trackPoints.length} points GPX</Text>
                    </View>
                  );
                })}
              </View>
            )}

            <Text style={styles.sectionTitle}>Creer un utilisateur</Text>
            <TextInput
              style={styles.input}
              placeholder="Nom d utilisateur (ex: benevole01)"
              value={newUsername}
              onChangeText={setNewUsername}
              autoCapitalize="none"
            />
            <TextInput
              style={styles.input}
              placeholder="Mot de passe (min. 4 caracteres)"
              value={newPassword}
              onChangeText={setNewPassword}
              secureTextEntry
            />

            <View style={styles.roleRow}>
              <Text style={styles.roleLabel}>Role</Text>
              <View style={styles.roleButtonsWrap}>
                <Pressable
                  style={[styles.roleButton, newRole === 'participant' && styles.roleButtonActive]}
                  onPress={() => setNewRole('participant')}
                >
                  <Text
                    style={[
                      styles.roleButtonText,
                      newRole === 'participant' && styles.roleButtonTextActive,
                    ]}
                  >
                    participant
                  </Text>
                </Pressable>
                <Pressable
                  style={[styles.roleButton, newRole === 'benevole' && styles.roleButtonActive]}
                  onPress={() => setNewRole('benevole')}
                >
                  <Text
                    style={[
                      styles.roleButtonText,
                      newRole === 'benevole' && styles.roleButtonTextActive,
                    ]}
                  >
                    benevole
                  </Text>
                </Pressable>
                <Pressable
                  style={[styles.roleButton, newRole === 'admin_manifestation' && styles.roleButtonActive]}
                  onPress={() => setNewRole('admin_manifestation')}
                >
                  <Text
                    style={[
                      styles.roleButtonText,
                      newRole === 'admin_manifestation' && styles.roleButtonTextActive,
                    ]}
                  >
                    admin manifestation
                  </Text>
                </Pressable>
                {isGlobalAdminRole(currentUser.role) && (
                  <Pressable
                    style={[styles.roleButton, newRole === 'admin_global' && styles.roleButtonActive]}
                    onPress={() => setNewRole('admin_global')}
                  >
                    <Text
                      style={[
                        styles.roleButtonText,
                        newRole === 'admin_global' && styles.roleButtonTextActive,
                      ]}
                    >
                      admin global
                    </Text>
                  </Pressable>
                )}
              </View>
            </View>

            <Pressable style={styles.button} onPress={handleCreateUser}>
              <Text style={styles.buttonText}>Creer le compte</Text>
            </Pressable>

            <Text style={styles.sectionTitle}>Comptes utilisateurs</Text>
            <FlatList
              data={sortedUsers}
              keyExtractor={(item) => item.id}
              contentContainerStyle={styles.listGap}
              scrollEnabled={false}
              renderItem={({ item }) => (
                <View style={styles.userCard}>
                  <View>
                    <Text style={styles.userName}>{item.username}</Text>
                    <Text style={styles.userRole}>
                      {getRoleLabel(item.role)}
                      {item.manifestationId ? ` · ${currentManifestation?.name ?? item.manifestationId}` : ''}
                    </Text>
                  </View>
                  <Pressable
                    style={[
                      styles.deleteButton,
                      item.username === 'admin' && item.role === 'admin' && styles.deleteButtonDisabled,
                    ]}
                    onPress={() => handleDeleteUser(item.id)}
                    disabled={item.username === 'admin' && item.role === 'admin'}
                  >
                    <Text style={styles.deleteButtonText}>Supprimer</Text>
                  </Pressable>
                </View>
              )}
            />
          </View>
        </ScrollView>
      ) : (
        <ScrollView style={styles.pageContainer} contentContainerStyle={styles.pageContent}>
          <View style={styles.accountContainer}>
            <Text style={styles.accountTitle}>Acces refuse</Text>
            <Text style={styles.accountSubtitle}>Cette section est reservee aux administrateurs de manifestation.</Text>
          </View>
        </ScrollView>
      )}

      {eventPickerTarget && (
        <DateTimePicker
          value={eventPickerValue}
          mode={eventPickerTarget === 'date' ? 'date' : 'time'}
          is24Hour
          display={Platform.OS === 'ios' ? 'spinner' : 'default'}
          onChange={handleEventPickerChange}
        />
      )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#EAF4FF',
  },
  flex1: {
    flex: 1,
  },
  authContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
    gap: 12,
    backgroundColor: '#EAF4FF',
  },
  appName: {
    fontSize: 40,
    fontWeight: 'bold',
    color: '#5F8FC9',
    marginBottom: 10,
    textAlign: 'center',
  },
  authLogo: {
    width: 120,
    height: 120,
    marginBottom: 20,
    resizeMode: 'contain',
  },
  splashLogo: {
    width: 100,
    height: 100,
    marginBottom: 20,
    resizeMode: 'contain',
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#274B74',
  },
  subtitle: {
    fontSize: 16,
    color: '#5F8FC9',
    textAlign: 'center',
    marginBottom: 20,
  },
  input: {
    borderWidth: 1,
    borderColor: '#C9DEF5',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: '#FFFFFF',
    fontSize: 16,
    color: '#274B74',
    minHeight: 48,
    width: '100%',
    maxWidth: 420,
  },
  selectorField: {
    borderWidth: 1,
    borderColor: '#C9DEF5',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: '#FFFFFF',
    justifyContent: 'center',
    minHeight: 48,
    width: '100%',
    maxWidth: 420,
  },
  selectorText: {
    fontSize: 16,
    color: '#274B74',
  },
  selectorPlaceholderText: {
    fontSize: 16,
    color: '#5F8FC9',
  },
  button: {
    backgroundColor: '#5F8FC9',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 10,
    width: '100%',
    maxWidth: 420,
  },
  buttonText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 16,
  },
  secondaryButton: {
    borderWidth: 1,
    borderColor: '#5F8FC9',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 2,
    backgroundColor: '#FFFFFF',
    width: '100%',
    maxWidth: 420,
  },
  secondaryButtonText: {
    color: '#5F8FC9',
    fontWeight: '700',
    fontSize: 16,
  },
  headerActionButton: {
    borderWidth: 1,
    borderColor: '#C9DEF5',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 9,
    backgroundColor: '#FFFFFF',
    flexShrink: 0,
  },
  headerActionButtonText: {
    color: '#274B74',
    fontWeight: '700',
    fontSize: 14,
  },
  hintBox: {
    marginTop: 10,
    backgroundColor: '#DCEAFF',
    padding: 12,
    borderRadius: 10,
    gap: 2,
  },
  hint: {
    color: '#274B74',
    fontWeight: '600',
  },
  hintStrong: {
    color: '#274B74',
    fontWeight: '700',
  },
  panelHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#C9DEF5',
    backgroundColor: '#FFFFFF',
  },
  panelTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#274B74',
  },
  panelSubtitle: {
    fontSize: 14,
    color: '#5F8FC9',
    marginTop: 2,
  },
  adminContainer: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
    backgroundColor: '#EAF4FF',
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#274B74',
    marginBottom: 10,
    marginTop: 10,
  },
  roleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginVertical: 6,
  },
  roleLabel: {
    fontSize: 15,
    color: '#274B74',
    fontWeight: '600',
  },
  roleButtonsWrap: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
  },
  roleButton: {
    borderWidth: 1,
    borderColor: '#5F8FC9',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#FFFFFF',
    minWidth: 126,
    flexGrow: 1,
    alignItems: 'center',
  },
  roleButtonActive: {
    backgroundColor: '#5F8FC9',
    borderColor: '#5F8FC9',
  },
  roleButtonText: {
    color: '#5F8FC9',
    fontWeight: '600',
  },
  roleButtonTextActive: {
    color: '#FFFFFF',
  },
  listGap: {
    gap: 10,
    paddingBottom: 20,
  },
  manifestationCreateCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#C9DEF5',
    padding: 14,
    marginTop: 10,
    marginBottom: 8,
  },
  manifestationCard: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#C9DEF5',
    backgroundColor: '#FFFFFF',
    padding: 12,
    gap: 12,
  },
  manifestationActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  manifestationActionButton: {
    borderWidth: 1,
    borderColor: '#5F8FC9',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    backgroundColor: '#FFFFFF',
    minWidth: 110,
    alignItems: 'center',
    justifyContent: 'center',
  },
  manifestationActionButtonActive: {
    backgroundColor: '#DCEAFF',
    borderColor: '#5F8FC9',
  },
  manifestationActionButtonText: {
    color: '#5F8FC9',
    fontWeight: '700',
    fontSize: 14,
  },
  manifestationActionButtonTextActive: {
    color: '#274B74',
  },
  manifestationDeleteButton: {
    borderWidth: 1,
    borderColor: '#D32F2F',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    backgroundColor: '#FFFFFF',
    minWidth: 110,
    alignItems: 'center',
    justifyContent: 'center',
  },
  manifestationDeleteButtonText: {
    color: '#D32F2F',
    fontWeight: '700',
    fontSize: 14,
  },
  userCard: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#C9DEF5',
    backgroundColor: '#FFFFFF',
    padding: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  userName: {
    fontSize: 16,
    fontWeight: '700',
    color: '#274B74',
  },
  userRole: {
    fontSize: 14,
    color: '#5F8FC9',
    marginTop: 2,
  },
  deleteButton: {
    backgroundColor: '#FFCDD2',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  deleteButtonDisabled: {
    opacity: 0.45,
  },
  deleteButtonText: {
    color: '#B71C1C',
    fontWeight: '700',
    fontSize: 12,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
    gap: 8,
    backgroundColor: '#EAF4FF',
  },
  navTabs: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#C9DEF5',
  },
  navTab: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
    borderBottomWidth: 3,
    borderBottomColor: 'transparent',
  },
  navTabActive: {
    borderBottomColor: '#5F8FC9',
  },
  navTabText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#5F8FC9',
  },
  navTabTextActive: {
    color: '#274B74',
  },
  pageContainer: {
    flex: 1,
    backgroundColor: '#EAF4FF',
  },
  pageContent: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 20,
  },
  accountContainer: {
    flex: 1,
    alignItems: 'center',
    padding: 20,
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
  },
  accountAvatar: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: '#DCEAFF',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 20,
  },
  accountAvatarHead: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#5F8FC9',
  },
  accountAvatarBody: {
    width: 70,
    height: 40,
    backgroundColor: '#5F8FC9',
    borderBottomLeftRadius: 35,
    borderBottomRightRadius: 35,
  },
  accountTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#274B74',
    marginBottom: 4,
  },
  accountSubtitle: {
    fontSize: 15,
    color: '#5F8FC9',
    marginBottom: 20,
    textAlign: 'center',
  },
  carteContainer: {
    flex: 1,
    backgroundColor: '#EAF4FF',
  },
  map: {
    ...StyleSheet.absoluteFillObject,
  },
  mapWebFallback: {
    flex: 1,
    backgroundColor: '#102a43',
    borderWidth: 1,
    borderColor: '#486581',
    borderRadius: 12,
    margin: 12,
    padding: 16,
    justifyContent: 'center',
    gap: 8,
  },
  mapWebFallbackTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#274B74',
  },
  mapWebFallbackText: {
    fontSize: 14,
    color: '#5F8FC9',
    textAlign: 'center',
    paddingHorizontal: 20,
  },
  mapWebFallbackCoords: {
    fontSize: 12,
    color: '#5F8FC9',
    marginTop: 8,
  },
  recenterButton: {
    position: 'absolute',
    right: 16,
    bottom: 132,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: 'rgba(95, 143, 201, 0.95)',
    zIndex: 30,
    elevation: 8,
  },
  recenterButtonText: {
    color: '#ffffff',
    fontWeight: '600',
  },
  mapNotice: {
    position: 'absolute',
    top: 10,
    left: 10,
    right: 10,
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
    padding: 10,
    borderRadius: 8,
  },
  mapNoticeText: {
    color: '#274B74',
    textAlign: 'center',
  },
  participantPanel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(255, 255, 255, 0.95)',
    padding: 16,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    zIndex: 40,
    elevation: 5,
  },
  participantPanelActive: {
    backgroundColor: 'rgba(234, 244, 255, 0.98)',
  },
  participantPanelTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#274B74',
    marginBottom: 12,
  },
  eventSelectorRow: {
    gap: 12,
    paddingBottom: 12,
  },
  eventSelectorCard: {
    backgroundColor: '#FFFFFF',
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#C9DEF5',
  },
  eventSelectorCardActive: {
    backgroundColor: '#E8F1F9',
    borderColor: '#000000',
    borderWidth: 2,
  },
  eventSelectorTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#274B74',
  },
  eventSelectorMeta: {
    fontSize: 13,
    color: '#5F8FC9',
  },
  modeSwitchRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 12,
  },
  modeButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#5F8FC9',
  },
  modeButtonActive: {
    backgroundColor: '#5F8FC9',
  },
  modeButtonText: {
    color: '#5F8FC9',
    fontWeight: '600',
  },
  modeButtonTextActive: {
    color: '#FFFFFF',
  },
  navigationMetricsCard: {
    backgroundColor: '#FFFFFF',
    padding: 12,
    borderRadius: 10,
    marginBottom: 12,
    gap: 4,
  },
  navigationMetric: {
    fontSize: 15,
    color: '#274B74',
  },
  navigationMetricAlert: {
    fontSize: 15,
    color: '#B71C1C',
    fontWeight: '600',
  },
  actionRow: {
    flexDirection: 'row',
    gap: 12,
  },
  urgencyButton: {
    flex: 1,
    backgroundColor: '#D32F2F',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  urgencyButtonText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 14,
  },
  adminEmergencyPanel: {
    position: 'absolute',
    top: 10,
    left: 10,
    right: 10,
    backgroundColor: 'rgba(255, 205, 210, 0.95)',
    padding: 12,
    borderRadius: 8,
  },
  adminEmergencyTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#B71C1C',
    marginBottom: 8,
  },
  adminEmergencyItemButton: {
    paddingVertical: 4,
  },
  adminEmergencyItem: {
    color: '#B71C1C',
  },
  legend: {
    position: 'absolute',
    bottom: 10,
    left: 10,
    right: 10,
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
    padding: 10,
    borderRadius: 8,
    gap: 6,
    zIndex: 10,
    elevation: 2,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  legendColor: {
    width: 16,
    height: 16,
    borderRadius: 8,
  },
  legendText: {
    fontSize: 13,
    color: '#274B74',
  },
  participantArrowContainer: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  participantArrowGlyph: {
    fontSize: 28,
    textShadowColor: 'rgba(0, 0, 0, 0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  eventFieldGroup: {
    marginBottom: 10,
  },
  eventFieldLabel: {
    fontSize: 14,
    color: '#5F8FC9',
    marginBottom: 4,
  },
  fieldRow: {
    flexDirection: 'row',
    gap: 12,
  },
  halfInput: {
    flex: 1,
  },
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginVertical: 6,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#5F8FC9',
    justifyContent: 'center',
    alignItems: 'center',
  },
  offlineNotice: {
    position: 'absolute',
    top: 10,
    left: 10,
    right: 10,
    backgroundColor: 'rgba(255, 152, 0, 0.95)',
    padding: 10,
    borderRadius: 8,
    zIndex: 20,
  },
  offlineNoticeText: {
    color: '#FFFFFF',
    fontWeight: '700',
    textAlign: 'center',
  },
  checkboxActive: {
    backgroundColor: '#5F8FC9',
  },
  checkboxDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#FFFFFF',
  },
  checkboxLabel: {
    fontSize: 15,
    color: '#274B74',
  },
  helperText: {
    fontSize: 13,
    color: '#5F8FC9',
    marginTop: 4,
    marginBottom: 10,
  },
  gpxPreviewBox: {
    backgroundColor: '#FFFFFF',
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#C9DEF5',
    marginBottom: 12,
  },
  gpxPreviewLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#5F8FC9',
  },
  gpxPreviewText: {
    fontSize: 14,
    color: '#274B74',
    marginTop: 2,
  },
  eventList: {
    gap: 12,
    marginBottom: 20,
  },
  eventCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: '#C9DEF5',
  },
  eventCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 6,
  },
  eventCardTitleBlock: {
    flex: 1,
  },
  eventCardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#274B74',
  },
  eventCardMeta: {
    fontSize: 13,
    color: '#5F8FC9',
  },
  eventHeaderActions: {
    alignItems: 'flex-end',
    gap: 8,
  },
  eventBadge: {
    backgroundColor: '#DCEAFF',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
  },
  eventBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#5F8FC9',
  },
  deleteEventButton: {
    backgroundColor: '#FFCDD2',
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 6,
  },
  deleteEventButtonText: {
    color: '#B71C1C',
    fontWeight: '600',
    fontSize: 12,
  },
  emptyText: {
    textAlign: 'center',
    color: '#5F8FC9',
    marginVertical: 10,
  },
  navigationStats: {
    position: 'absolute',
    bottom: 10,
    left: 10,
    right: 10,
    backgroundColor: 'rgba(39, 75, 116, 0.95)',
    padding: 12,
    borderRadius: 12,
    gap: 10,
    zIndex: 35,
    elevation: 5,
  },
  statsRow: {
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'space-between',
  },
  statCard: {
    flex: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
  },
  statLabel: {
    fontSize: 11,
    color: 'rgba(255, 255, 255, 0.7)',
    fontWeight: '600',
    marginBottom: 4,
  },
  statValue: {
    fontSize: 14,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  emergencyButtonSmall: {
    backgroundColor: '#D32F2F',
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderRadius: 6,
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: 50,
  },
  emergencyButtonSmallText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 11,
    textAlign: 'center',
  },
  stopButtonSmall: {
    backgroundColor: '#5F8FC9',
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderRadius: 6,
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: 50,
  },
  stopButtonSmallText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 11,
    textAlign: 'center',
  },
});

