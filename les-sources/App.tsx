import AsyncStorage from '@react-native-async-storage/async-storage';
import * as DocumentPicker from 'expo-document-picker';
import * as Location from 'expo-location';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { StatusBar } from 'expo-status-bar';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
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
import MapView, { Marker, Polyline } from 'react-native-maps';
import {
  cloudSyncEnabled,
  deleteCloudValue,
  readCloudValue,
  writeCloudValue,
} from './firebase';

type Role = 'admin' | 'benevole' | 'participant';
type Page = 'admin' | 'carte' | 'compte';

type User = {
  id: string;
  username: string;
  password: string;
  role: Role;
};

type UserLocation = {
  userId: string;
  username: string;
  latitude: number;
  longitude: number;
  heading?: number;
  timestamp: number;
};

type EventTrackPoint = {
  latitude: number;
  longitude: number;
};

type EventItem = {
  id: string;
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

type EventPickerTarget = 'date' | 'startTime' | 'endTime' | null;
type NavigationMode = 'normal' | 'focus';

type EmergencyAlert = {
  id: string;
  userId: string;
  username: string;
  eventId: string;
  eventName: string;
  timestamp: number;
};

const STORAGE_KEY = 'les-sources-users-v1';
const STORAGE_LOCATIONS_KEY = 'les-sources-locations-v1';
const STORAGE_EVENTS_KEY = 'les-sources-events-v1';
const STORAGE_EMERGENCY_ALERTS_KEY = 'les-sources-emergency-alerts-v1';
const CLOUD_USERS_PATH = 'users';
const CLOUD_LOCATIONS_PATH = 'locations';
const CLOUD_EVENTS_PATH = 'events';
const CLOUD_EMERGENCY_ALERTS_PATH = 'emergencyAlerts';

const DEFAULT_USERS: User[] = [
  {
    id: 'admin-1',
    username: 'admin',
    password: 'admin',
    role: 'admin',
  },
];

const DEFAULT_MAP_REGION = {
  latitude: 48.8566,
  longitude: 2.3522,
  latitudeDelta: 0.0922,
  longitudeDelta: 0.0421,
};

const EVENT_COLORS = ['#ef4444', '#2563eb', '#f59e0b', '#10b981', '#8b5cf6'];
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
    return role === 'admin' || role === 'benevole';
  }

  return false;
};

export default function App() {
  const useCloudSync = cloudSyncEnabled;
  const [users, setUsers] = useState<User[]>([]);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [currentPage, setCurrentPage] = useState<Page>('carte');

  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');

  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<Role>('participant');

  const [userLocations, setUserLocations] = useState<UserLocation[]>([]);
  const [currentLocation, setCurrentLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const [events, setEvents] = useState<EventItem[]>([]);

  const [eventName, setEventName] = useState('');
  const [eventDate, setEventDate] = useState('');
  const [eventStartTime, setEventStartTime] = useState('');
  const [eventEndTime, setEventEndTime] = useState('');
  const [eventGpxText, setEventGpxText] = useState('');
  const [eventGpxFileName, setEventGpxFileName] = useState('');
  const [eventVisibleForVolunteers, setEventVisibleForVolunteers] = useState(false);
  const [eventDateValue, setEventDateValue] = useState<Date | null>(null);
  const [eventStartTimeValue, setEventStartTimeValue] = useState<Date | null>(null);
  const [eventEndTimeValue, setEventEndTimeValue] = useState<Date | null>(null);
  const [eventPickerTarget, setEventPickerTarget] = useState<EventPickerTarget>(null);
  const [eventPickerValue, setEventPickerValue] = useState(new Date());

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

  const mapRef = useRef<MapView | null>(null);
  const previousNavigationPositionRef = useRef<{ latitude: number; longitude: number } | null>(null);
  const currentHeadingRef = useRef(0);
  const navigationModeRef = useRef<NavigationMode>('normal');
  const nextWaypointIndexRef = useRef(0);
  const showOffRouteAlertRef = useRef(false);
  const activeEventPointsRef = useRef<EventTrackPoint[]>([]);

  const [accountUsername, setAccountUsername] = useState('');
  const [accountPassword, setAccountPassword] = useState('');

  useEffect(() => {
    if (!useCloudSync) {
      loadUsers();
      loadUserLocations();
      loadEvents();
      loadEmergencyAlerts();
      return;
    }

    let isMounted = true;

    const syncFromCloud = async () => {
      try {
        const [cloudUsers, cloudLocations, cloudEvents, cloudAlerts] = await Promise.all([
          readCloudValue<Record<string, User>>(CLOUD_USERS_PATH),
          readCloudValue<Record<string, UserLocation>>(CLOUD_LOCATIONS_PATH),
          readCloudValue<Record<string, EventItem>>(CLOUD_EVENTS_PATH),
          readCloudValue<Record<string, EmergencyAlert>>(CLOUD_EMERGENCY_ALERTS_PATH),
        ]);

        if (!isMounted) {
          return;
        }

        const parsedUsers = valuesFromRecord<User>(cloudUsers);
        const hasAdmin = parsedUsers.some((user: User) => user.username === 'admin' && user.role === 'admin');
        const nextUsers = parsedUsers.length === 0 ? DEFAULT_USERS : hasAdmin ? parsedUsers : [...parsedUsers, ...DEFAULT_USERS];

        if (parsedUsers.length === 0 || !hasAdmin) {
          await writeCloudValue(CLOUD_USERS_PATH, mapById(nextUsers));
        }

        setUsers(nextUsers);
        setUserLocations(valuesFromRecord<UserLocation>(cloudLocations));
        setEvents(valuesFromRecord<EventItem>(cloudEvents));
        setEmergencyAlerts(
          valuesFromRecord<EmergencyAlert>(cloudAlerts)
            .sort((left, right) => right.timestamp - left.timestamp)
            .slice(0, 50)
        );
      } catch {
        // Ignore cloud sync errors and keep the last good state.
      } finally {
        if (isMounted) {
          setIsReady(true);
        }
      }
    };

    syncFromCloud();
    const syncInterval = setInterval(syncFromCloud, 2000);

    return () => {
      isMounted = false;
      clearInterval(syncInterval);
    };
  }, [useCloudSync]);

  useEffect(() => {
    if (!currentUser) {
      setAccountUsername('');
      setAccountPassword('');
      return;
    }

    setAccountUsername(currentUser.username);
    setAccountPassword(currentUser.password);
  }, [currentUser]);

  const sortedUsers = useMemo(() => {
    return [...users].sort((a, b) => {
      if (a.role !== b.role) {
        return a.role === 'admin' ? -1 : 1;
      }
      return a.username.localeCompare(b.username);
    });
  }, [users]);

  const loadUsers = async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (!raw) {
        setUsers(DEFAULT_USERS);
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_USERS));
      } else {
        const parsed: User[] = JSON.parse(raw);
        const hasAdmin = parsed.some((u: User) => u.username === 'admin' && u.role === 'admin');
        const nextUsers = hasAdmin ? parsed : [...parsed, ...DEFAULT_USERS];
        setUsers(nextUsers);
        if (!hasAdmin) {
          await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(nextUsers));
        }
      }
    } catch {
      setUsers(DEFAULT_USERS);
    } finally {
      setIsReady(true);
    }
  };

  const persistUsers = async (nextUsers: User[]) => {
    setUsers(nextUsers);
    if (useCloudSync) {
      await writeCloudValue(CLOUD_USERS_PATH, mapById(nextUsers));
      return;
    }

    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(nextUsers));
  };

  const loadUserLocations = async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_LOCATIONS_KEY);
      if (raw) {
        const parsed: UserLocation[] = JSON.parse(raw);
        setUserLocations(parsed);
      }
    } catch {
      // Ignore errors
    }
  };

  const loadEvents = async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_EVENTS_KEY);
      if (raw) {
        const parsed: EventItem[] = JSON.parse(raw);
        setEvents(parsed);
      }
    } catch {
      setEvents([]);
    }
  };

  const persistEvents = async (nextEvents: EventItem[]) => {
    setEvents(nextEvents);
    if (useCloudSync) {
      await writeCloudValue(CLOUD_EVENTS_PATH, mapById(nextEvents));
      return;
    }

    await AsyncStorage.setItem(STORAGE_EVENTS_KEY, JSON.stringify(nextEvents));
  };

  const loadEmergencyAlerts = async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_EMERGENCY_ALERTS_KEY);
      if (raw) {
        const parsed: EmergencyAlert[] = JSON.parse(raw);
        setEmergencyAlerts(parsed);
      }
    } catch {
      setEmergencyAlerts([]);
    }
  };

  const persistEmergencyAlerts = async (nextAlerts: EmergencyAlert[]) => {
    setEmergencyAlerts(nextAlerts);
    if (useCloudSync) {
      await writeCloudValue(CLOUD_EMERGENCY_ALERTS_PATH, mapById(nextAlerts));
      return;
    }

    await AsyncStorage.setItem(STORAGE_EMERGENCY_ALERTS_KEY, JSON.stringify(nextAlerts));
  };

  const persistUserLocations = async (nextLocations: UserLocation[]) => {
    setUserLocations(nextLocations);
    if (useCloudSync) {
      await writeCloudValue(CLOUD_LOCATIONS_PATH, mapLocationsByUserId(nextLocations));
      return;
    }

    await AsyncStorage.setItem(STORAGE_LOCATIONS_KEY, JSON.stringify(nextLocations));
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

  const openEventStartTimePicker = () => {
    setEventPickerTarget('startTime');
    setEventPickerValue(eventStartTimeValue ?? new Date());
  };

  const openEventEndTimePicker = () => {
    setEventPickerTarget('endTime');
    setEventPickerValue(eventEndTimeValue ?? new Date());
  };

  const handleEventPickerChange = (pickerEvent: DateTimePickerEvent, selectedValue?: Date) => {
    if (pickerEvent.type === 'dismissed' || !selectedValue) {
      setEventPickerTarget(null);
      return;
    }

    if (eventPickerTarget === 'date') {
      setEventDateValue(selectedValue);
      setEventDate(getLocalDateKey(selectedValue));

      if (eventStartTimeValue) {
        const mergedStart = mergeDateAndTime(selectedValue, eventStartTimeValue);
        setEventStartTimeValue(mergedStart);
        setEventStartTime(formatTime(mergedStart));
      }

      if (eventEndTimeValue) {
        const mergedEnd = mergeDateAndTime(selectedValue, eventEndTimeValue);
        setEventEndTimeValue(mergedEnd);
        setEventEndTime(formatTime(mergedEnd));
      }
    }

    if (eventPickerTarget === 'startTime') {
      const baseDate = eventDateValue ?? new Date();
      const mergedStart = mergeDateAndTime(baseDate, selectedValue);
      setEventStartTimeValue(mergedStart);
      setEventStartTime(formatTime(mergedStart));
    }

    if (eventPickerTarget === 'endTime') {
      const baseDate = eventDateValue ?? new Date();
      const mergedEnd = mergeDateAndTime(baseDate, selectedValue);
      setEventEndTimeValue(mergedEnd);
      setEventEndTime(formatTime(mergedEnd));
    }

    setEventPickerTarget(null);
  };

  const updateUserLocation = async (
    userId: string,
    username: string,
    latitude: number,
    longitude: number,
    heading?: number
  ) => {
    const existingIndex = userLocations.findIndex((loc: UserLocation) => loc.userId === userId);
    const newLocation: UserLocation = {
      userId,
      username,
      latitude,
      longitude,
      heading,
      timestamp: Date.now(),
    };

    let updatedLocations: UserLocation[];
    if (existingIndex >= 0) {
      updatedLocations = [...userLocations];
      updatedLocations[existingIndex] = newLocation;
    } else {
      updatedLocations = [...userLocations, newLocation];
    }

    await persistUserLocations(updatedLocations);
  };

  const generateMockLocation = () => {
    // Génère une position GPS simulée proche de Paris
    const baseLat = 48.8566;
    const baseLng = 2.3522;
    const offset = 0.01;
    return {
      latitude: baseLat + (Math.random() - 0.5) * offset,
      longitude: baseLng + (Math.random() - 0.5) * offset,
    };
  };

  const requestLocationPermission = async () => {
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
          currentHeadingRef.current
        );
      }
    } catch (error) {
      console.error('Erreur geolocalisation:', error);
    }
  };

  const getMarkerColorByRole = (role: Role) => {
    if (role === 'participant') return '#ff8c42'; // Orange
    if (role === 'benevole') return '#4b7bff'; // Bleu
    return '#0f766e'; // Vert pour admin
  };

  const handleCreateEvent = async () => {
    const name = eventName.trim();
    const date = eventDate.trim();
    const startTime = eventStartTime.trim();
    const endTime = eventEndTime.trim();
    const gpxText = eventGpxText.trim();

    if (!name || !date || !startTime || !endTime || !gpxText) {
      Alert.alert('Erreur', 'Tous les champs de l evenement sont obligatoires.');
      return;
    }

    if (!isValidDateInput(date)) {
      Alert.alert('Erreur', 'La date doit etre au format YYYY-MM-DD.');
      return;
    }

    if (!isValidTimeInput(startTime) || !isValidTimeInput(endTime)) {
      Alert.alert('Erreur', 'Les heures doivent etre au format HH:MM.');
      return;
    }

    const parsedTrack = parseGpxTrackPoints(gpxText);
    if (parsedTrack.length < 2) {
      Alert.alert('Erreur', 'Le GPX doit contenir au moins deux points de trace valides.');
      return;
    }

    const nextEvent: EventItem = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      date,
      startTime,
      endTime,
      gpxText,
      showForVolunteers: eventVisibleForVolunteers,
    };

    const nextEvents = [...events, nextEvent];
    await persistEvents(nextEvents);
    setEventName('');
    setEventDate('');
    setEventStartTime('');
    setEventEndTime('');
    setEventGpxText('');
    setEventGpxFileName('');
    setEventVisibleForVolunteers(false);
    setEventDateValue(null);
    setEventStartTimeValue(null);
    setEventEndTimeValue(null);
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
    setCurrentPage('carte');
    
    // Commencer à tracker la position GPS réelle
    startLocationTracking();
  };

  const handleLogout = () => {
    setCurrentUser(null);
    setLoginUsername('');
    setLoginPassword('');
    setCurrentPage('carte');
    setCurrentLocation(null);
  };

  const handleCreateUser = async () => {
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

    if (target.username === 'admin') {
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
    return events.find((event: EventItem) => event.id === activeEventId) ?? null;
  }, [activeEventId, events]);

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

    const eventToStart = events.find((event: EventItem) => event.id === selectedEventId);
    if (!eventToStart) {
      Alert.alert('Erreur', 'Evenement introuvable.');
      return;
    }

    const points = parseGpxTrackPoints(eventToStart.gpxText);
    if (points.length < 2) {
      Alert.alert('Erreur', 'Le parcours de cet evenement est invalide.');
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
  };

  const triggerEmergency = async () => {
    if (!currentUser || !activeEvent || currentUser.role !== 'participant') {
      return;
    }

    const nextAlert: EmergencyAlert = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      userId: currentUser.id,
      username: currentUser.username,
      eventId: activeEvent.id,
      eventName: activeEvent.name,
      timestamp: Date.now(),
    };

    const nextAlerts = [nextAlert, ...emergencyAlerts].slice(0, 50);
    await persistEmergencyAlerts(nextAlerts);
    setEmergencyCountdown(5);
    Alert.alert('Urgence envoyee', 'Les administrateurs ont ete notifies. Appel auto dans 5 secondes.');
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

    activateKeepAwakeAsync('navigation-active');
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
    nextIndex: number
  ) => {
    if (!mapRef.current || !locationPoint || routePoints.length < 2) {
      return;
    }

    const fromIndex = Math.min(Math.max(0, nextIndex), routePoints.length - 1);
    const nextPoints = routePoints.slice(fromIndex, Math.min(fromIndex + 7, routePoints.length));
    const pointsToFit = [locationPoint, ...nextPoints];

    if (pointsToFit.length < 2) {
      return;
    }

    mapRef.current.fitToCoordinates(pointsToFit, {
      edgePadding: {
        top: 90,
        right: 70,
        bottom: 190,
        left: 70,
      },
      animated: true,
    });
  };

  useEffect(() => {
    if (currentUser?.role !== 'participant' || !activeEventId || navigationMode !== 'normal') {
      return;
    }

    fitNormalNavigationViewport(currentLocation, activeEventPoints, nextWaypointIndex);
  }, [activeEventId, activeEventPoints, currentLocation, currentUser?.role, navigationMode, nextWaypointIndex]);

  useEffect(() => {
    if (!currentUser) {
      return;
    }

    let locationSubscription: Location.LocationSubscription | null = null;
    let headingSubscription: Location.LocationSubscription | null = null;
    let isMounted = true;

    const startWatcher = async () => {
      const permission = await requestLocationPermission();
      if (!permission || !isMounted) {
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
              : currentHeadingRef.current
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
            fitNormalNavigationViewport(
              updatedLocation,
              currentEventPoints,
              nextWaypointIndexRef.current
            );
          }
        }
      );
    };

    startWatcher();

    return () => {
      isMounted = false;
      if (locationSubscription) {
        locationSubscription.remove();
      }
      if (headingSubscription) {
        headingSubscription.remove();
      }
    };
  }, [
    activeEventId,
    currentUser,
  ]);

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
    };

    const nextUsers = users.map((u: User) => (u.id === currentUser.id ? updatedUser : u));
    await persistUsers(nextUsers);
    setCurrentUser(updatedUser);

    if (currentUser.username !== username) {
      const nextLocations = userLocations.map((loc: UserLocation) =>
        loc.userId === currentUser.id ? { ...loc, username } : loc
      );
      await persistUserLocations(nextLocations);
    }

    Alert.alert('Succès', 'Ton compte a ete mis a jour.');
  };

  const visibleEvents: VisibleEvent[] = useMemo(() => {
    if (!currentUser) {
      return [];
    }

    const nextVisibleEvents: VisibleEvent[] = [];

    events.forEach((event: EventItem) => {
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
  }, [currentUser, events]);

  const sortedEvents = useMemo(() => {
    return [...events].sort((left, right) => {
      const leftStamp = `${left.date} ${left.startTime}`;
      const rightStamp = `${right.date} ${right.startTime}`;
      return leftStamp.localeCompare(rightStamp);
    });
  }, [events]);

  const selectedEvent = useMemo(() => {
    if (!selectedEventId) {
      return null;
    }
    return events.find((event: EventItem) => event.id === selectedEventId) ?? null;
  }, [events, selectedEventId]);

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
    () => emergencyAlerts.slice(0, 5),
    [emergencyAlerts]
  );

  const isParticipantNormalNavigation =
    currentUser?.role === 'participant' && activeEventId !== null && navigationMode === 'normal';

  if (!isReady) {
    return (
      <SafeAreaView style={styles.screen}>
        <StatusBar style="dark" />
        <View style={styles.centered}>
          <Text style={styles.title}>Chargement...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!currentUser) {
    return (
      <SafeAreaView style={styles.screen}>
        <StatusBar style="dark" />
        <KeyboardAvoidingView
          style={styles.flex1}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.authContainer}>
            <Text style={styles.appName}>Les Sources</Text>
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
            <Text style={styles.panelSubtitle}>Role: {currentUser.role}</Text>
          </View>
          <Pressable style={styles.secondaryButton} onPress={handleLogout}>
            <Text style={styles.secondaryButtonText}>Deconnexion</Text>
          </Pressable>
        </View>
      )}

      {/* Navigation tabs */}
      {!isParticipantNavigationActive && (
        <View style={styles.navTabs}>
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
          {currentUser.role === 'admin' && (
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
      {currentPage === 'carte' ? (
        <View style={styles.carteContainer}>
          {currentUser.role === 'participant' && activeEventId && navigationMode === 'focus' ? (
            <View style={styles.focusContainer}>
              <View style={styles.focusEmergencyWrap}>
                <Pressable style={styles.focusUrgencyButton} onPress={triggerEmergency}>
                  <Text style={styles.focusUrgencyButtonText}>
                    Urgence {emergencyCountdown !== null ? `(${emergencyCountdown}s)` : ''}
                  </Text>
                </Pressable>
              </View>

              <Text style={styles.focusTitle}>Mode Focus</Text>
              <Text style={styles.focusSubtitle}>Suis la flèche selon le cap du téléphone</Text>

              <View style={styles.focusArrowFrame}>
                <View
                  style={[
                    styles.focusArrow,
                    {
                      transform: [{ rotate: `${directionToNextPoint}deg` }],
                    },
                  ]}
                />
              </View>

              <View style={styles.navigationMetricsCard}>
                <Text style={styles.navigationMetric}>Vitesse: {currentSpeedKmh.toFixed(1)} km/h</Text>
                <Text style={styles.navigationMetric}>Vitesse moyenne: {averageSpeedKmh.toFixed(1)} km/h</Text>
                <Text style={styles.navigationMetric}>Parcourus: {formatKm(distanceTravelledMeters)}</Text>
                <Text style={styles.navigationMetric}>Restants: {formatKm(Math.max(0, remainingDistanceMeters))}</Text>
                <Text style={styles.navigationMetricAlert}>
                  {offRouteDistanceMeters > 10
                    ? `Alerte éloignement: ${offRouteDistanceMeters.toFixed(1)} m`
                    : `Sur parcours (${offRouteDistanceMeters.toFixed(1)} m)`}
                </Text>
              </View>

              <View style={styles.modeSwitchRow}>
                <Pressable
                  style={[styles.modeButton, navigationMode === 'normal' && styles.modeButtonActive]}
                  onPress={() => setNavigationMode('normal')}
                >
                  <Text
                    style={[
                      styles.modeButtonText,
                      navigationMode === 'normal' && styles.modeButtonTextActive,
                    ]}
                  >
                    Mode normal
                  </Text>
                </Pressable>
                <Pressable
                  style={[styles.modeButton, navigationMode === 'focus' && styles.modeButtonActive]}
                  onPress={() => setNavigationMode('focus')}
                >
                  <Text
                    style={[
                      styles.modeButtonText,
                      navigationMode === 'focus' && styles.modeButtonTextActive,
                    ]}
                  >
                    Mode focus
                  </Text>
                </Pressable>
              </View>

              <Pressable style={styles.secondaryButton} onPress={handleStopEventNavigation}>
                <Text style={styles.secondaryButtonText}>Arrêter l'évènement</Text>
              </Pressable>
            </View>
          ) : (
            <>
              <MapView
                ref={(instance) => {
                  mapRef.current = instance;
                }}
                key={currentLocation ? `${currentLocation.latitude}-${currentLocation.longitude}` : 'default-map'}
                style={styles.map}
                initialRegion={
                  currentLocation
                    ? {
                        latitude: currentLocation.latitude,
                        longitude: currentLocation.longitude,
                        latitudeDelta: 0.0922,
                        longitudeDelta: 0.0421,
                      }
                    : DEFAULT_MAP_REGION
                }
                mapType="satellite"
                rotateEnabled={currentUser.role === 'participant' && activeEventId !== null}
              >
                {currentLocation && (
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
                              transform: [{ rotate: `${normalizeDegrees(currentHeading)}deg` }],
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

                {userLocations.map((location: UserLocation) => {
                  if (location.userId === currentUser.id) return null;
                  const user = users.find((u: User) => u.id === location.userId);
                  if (!user) return null;

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
                              {
                                color: '#dc2626',
                                transform: [{ rotate: `${normalizeDegrees(location.heading ?? 0)}deg` }],
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
                    <Fragment key={event.id}>
                      <Polyline
                        coordinates={points}
                        strokeColor={isSelected || isActive ? '#22c55e' : color}
                        strokeWidth={isSelected || isActive ? 6 : 4}
                      />
                      <Marker
                        coordinate={points[0]}
                        title={event.name}
                        description={`${event.date} ${event.startTime} - ${event.endTime}`}
                        pinColor={isSelected || isActive ? '#22c55e' : color}
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

              {!currentLocation && (
                <View style={styles.mapNotice} pointerEvents="none">
                  <Text style={styles.mapNoticeText}>
                    Position GPS indisponible. La carte affiche quand meme les evenements.
                  </Text>
                </View>
              )}

              {currentUser.role === 'participant' && (
                <View style={[styles.participantPanel, activeEventId && styles.participantPanelActive]}>
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
                      <View style={styles.modeSwitchRow}>
                        <Pressable
                          style={[styles.modeButton, navigationMode === 'normal' && styles.modeButtonActive]}
                          onPress={() => setNavigationMode('normal')}
                        >
                          <Text
                            style={[
                              styles.modeButtonText,
                              navigationMode === 'normal' && styles.modeButtonTextActive,
                            ]}
                          >
                            Mode normal
                          </Text>
                        </Pressable>
                        <Pressable
                          style={[styles.modeButton, navigationMode === 'focus' && styles.modeButtonActive]}
                          onPress={() => setNavigationMode('focus')}
                        >
                          <Text
                            style={[
                              styles.modeButtonText,
                              navigationMode === 'focus' && styles.modeButtonTextActive,
                            ]}
                          >
                            Mode focus
                          </Text>
                        </Pressable>
                      </View>

                      <View style={styles.navigationMetricsCard}>
                        <Text style={styles.navigationMetric}>Vitesse: {currentSpeedKmh.toFixed(1)} km/h</Text>
                        <Text style={styles.navigationMetric}>Vitesse moyenne: {averageSpeedKmh.toFixed(1)} km/h</Text>
                        <Text style={styles.navigationMetric}>Parcourus: {formatKm(distanceTravelledMeters)}</Text>
                        <Text style={styles.navigationMetric}>Restants: {formatKm(Math.max(0, remainingDistanceMeters))}</Text>
                        <Text style={styles.navigationMetric}>Direction: {getDirectionArrow(directionToNextPoint)} {Math.round(directionToNextPoint)}°</Text>
                        <Text style={styles.navigationMetricAlert}>
                          {offRouteDistanceMeters > 10
                            ? `Alerte éloignement: ${offRouteDistanceMeters.toFixed(1)} m`
                            : `Sur parcours (${offRouteDistanceMeters.toFixed(1)} m)`}
                        </Text>
                      </View>

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

              {currentUser.role === 'admin' && emergencyAlertsForAdmins.length > 0 && (
                <View style={styles.adminEmergencyPanel}>
                  <Text style={styles.adminEmergencyTitle}>Alertes urgences participants</Text>
                  {emergencyAlertsForAdmins.map((alert) => (
                    <Text key={alert.id} style={styles.adminEmergencyItem}>
                      {alert.username} - {alert.eventName} ({new Date(alert.timestamp).toLocaleTimeString()})
                    </Text>
                  ))}
                </View>
              )}

              {/* Légende */}
              {!isParticipantNavigationActive || navigationMode !== 'normal' ? (
                <View style={styles.legend}>
                  <View style={styles.legendItem}>
                    <View style={[styles.legendColor, { backgroundColor: '#ff8c42' }]} />
                    <Text style={styles.legendText}>Participant</Text>
                  </View>
                  <View style={styles.legendItem}>
                    <View style={[styles.legendColor, { backgroundColor: '#4b7bff' }]} />
                    <Text style={styles.legendText}>Bénévole</Text>
                  </View>
                  <View style={styles.legendItem}>
                    <View style={[styles.legendColor, { backgroundColor: '#0f766e' }]} />
                    <Text style={styles.legendText}>Admin</Text>
                  </View>
                  <View style={styles.legendItem}>
                    <View style={[styles.legendColor, { backgroundColor: '#ef4444' }]} />
                    <Text style={styles.legendText}>Evenement GPX</Text>
                  </View>
                </View>
              ) : null}
            </>
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

            <Pressable style={styles.button} onPress={handleUpdateAccount}>
              <Text style={styles.buttonText}>Enregistrer mes modifications</Text>
            </Pressable>
          </View>
        </ScrollView>
      ) : currentUser.role === 'admin' ? (
        <ScrollView style={styles.pageContainer} contentContainerStyle={styles.pageContent}>
          <View style={styles.adminContainer}>
            <Text style={styles.sectionTitle}>Creer un evenement</Text>
            <TextInput
              style={styles.input}
              placeholder="Nom de l evenement (ex: Trail des Sources)"
              value={eventName}
              onChangeText={setEventName}
            />
            <View style={styles.eventFieldGroup}>
              <Text style={styles.eventFieldLabel}>Date</Text>
              <Pressable
                style={[styles.selectorField, styles.selectorDateField]}
                onPress={openEventDatePicker}
              >
                <Text style={eventDate ? styles.selectorText : styles.selectorPlaceholderText}>
                  {eventDate || 'Sélectionner la date'}
                </Text>
              </Pressable>
            </View>
            <View style={styles.fieldRow}>
              <View style={[styles.eventFieldGroup, styles.halfInput]}>
                <Text style={styles.eventFieldLabel}>Heure de début</Text>
                <Pressable
                  style={styles.selectorField}
                  onPress={openEventStartTimePicker}
                >
                  <Text style={eventStartTime ? styles.selectorText : styles.selectorPlaceholderText}>
                    {eventStartTime || 'Choisir'}
                  </Text>
                </Pressable>
              </View>
              <View style={[styles.eventFieldGroup, styles.halfInput]}>
                <Text style={styles.eventFieldLabel}>Heure de fin</Text>
                <Pressable
                  style={styles.selectorField}
                  onPress={openEventEndTimePicker}
                >
                  <Text style={eventEndTime ? styles.selectorText : styles.selectorPlaceholderText}>
                    {eventEndTime || 'Choisir'}
                  </Text>
                </Pressable>
              </View>
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
              <Text style={styles.buttonText}>Creer l evenement</Text>
            </Pressable>

            <Text style={styles.sectionTitle}>Evenements enregistres</Text>
            {sortedEvents.length === 0 ? (
              <Text style={styles.emptyText}>Aucun evenement pour le moment.</Text>
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
                          <Text style={styles.eventCardMeta}>
                            {event.startTime} - {event.endTime}
                          </Text>
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
                  style={[styles.roleButton, newRole === 'admin' && styles.roleButtonActive]}
                  onPress={() => setNewRole('admin')}
                >
                  <Text style={[styles.roleButtonText, newRole === 'admin' && styles.roleButtonTextActive]}>
                    admin
                  </Text>
                </Pressable>
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
                    <Text style={styles.userRole}>Role: {item.role}</Text>
                  </View>
                  <Pressable
                    style={[
                      styles.deleteButton,
                      item.username === 'admin' && styles.deleteButtonDisabled,
                    ]}
                    onPress={() => handleDeleteUser(item.id)}
                    disabled={item.username === 'admin'}
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
            <Text style={styles.accountSubtitle}>Cette section est reservee aux administrateurs.</Text>
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
    backgroundColor: '#f5f7fb',
  },
  flex1: {
    flex: 1,
  },
  authContainer: {
    flex: 1,
    justifyContent: 'center',
    padding: 20,
    gap: 12,
  },
  appName: {
    fontSize: 34,
    fontWeight: '800',
    color: '#102a43',
    marginBottom: 6,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#102a43',
  },
  subtitle: {
    fontSize: 16,
    color: '#486581',
  },
  input: {
    borderWidth: 1,
    borderColor: '#bcccdc',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: '#ffffff',
    fontSize: 16,
  },
  selectorField: {
    borderWidth: 1,
    borderColor: '#bcccdc',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: '#ffffff',
    justifyContent: 'center',
    minHeight: 48,
  },
  selectorText: {
    fontSize: 16,
    color: '#102a43',
  },
  selectorPlaceholderText: {
    fontSize: 16,
    color: '#9aa5b1',
  },
  button: {
    backgroundColor: '#0f766e',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 2,
  },
  buttonText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 16,
  },
  secondaryButton: {
    borderWidth: 1,
    borderColor: '#9fb3c8',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 2,
    backgroundColor: '#ffffff',
  },
  secondaryButtonText: {
    color: '#334e68',
    fontWeight: '700',
    fontSize: 16,
  },
  hintBox: {
    marginTop: 10,
    backgroundColor: '#d9f99d',
    padding: 12,
    borderRadius: 10,
    gap: 2,
  },
  hint: {
    color: '#365314',
    fontWeight: '600',
  },
  hintStrong: {
    color: '#14532d',
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
    borderBottomColor: '#d9e2ec',
    backgroundColor: '#ffffff',
  },
  panelTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#102a43',
  },
  panelSubtitle: {
    fontSize: 14,
    color: '#627d98',
    marginTop: 2,
  },
  secondaryButton: {
    borderWidth: 1,
    borderColor: '#9fb3c8',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: '#ffffff',
  },
  secondaryButtonText: {
    color: '#334e68',
    fontWeight: '600',
  },
  adminContainer: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#102a43',
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
    color: '#334e68',
    fontWeight: '600',
  },
  roleButtonsWrap: {
    flexDirection: 'row',
    gap: 8,
  },
  roleButton: {
    borderWidth: 1,
    borderColor: '#9fb3c8',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: '#ffffff',
  },
  roleButtonActive: {
    backgroundColor: '#0f766e',
    borderColor: '#0f766e',
  },
  roleButtonText: {
    color: '#334e68',
    fontWeight: '600',
  },
  roleButtonTextActive: {
    color: '#ffffff',
  },
  listGap: {
    gap: 10,
    paddingBottom: 20,
  },
  userCard: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#d9e2ec',
    backgroundColor: '#ffffff',
    padding: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  userName: {
    fontSize: 16,
    fontWeight: '700',
    color: '#102a43',
  },
  userRole: {
    fontSize: 14,
    color: '#627d98',
    marginTop: 2,
  },
  deleteButton: {
    backgroundColor: '#fee2e2',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  deleteButtonDisabled: {
    opacity: 0.45,
  },
  deleteButtonText: {
    color: '#991b1b',
    fontWeight: '700',
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
    gap: 8,
  },
  navTabs: {
    flexDirection: 'row',
    backgroundColor: '#ffffff',
    borderBottomWidth: 1,
    borderBottomColor: '#d9e2ec',
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
    borderBottomColor: '#0f766e',
  },
  navTabText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#627d98',
  },
  navTabTextActive: {
    color: '#0f766e',
  },
  pageContainer: {
    flex: 1,
  },
  pageContent: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 20,
  },
  accountContainer: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#d9e2ec',
    backgroundColor: '#ffffff',
    padding: 16,
    gap: 10,
  },
  accountAvatar: {
    alignSelf: 'center',
    width: 84,
    height: 84,
    borderRadius: 42,
    borderWidth: 2,
    borderColor: '#0f766e',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
    backgroundColor: '#f0fdfa',
  },
  accountAvatarHead: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#0f766e',
    marginBottom: 6,
  },
  accountAvatarBody: {
    width: 34,
    height: 18,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    backgroundColor: '#0f766e',
  },
  accountTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#102a43',
    textAlign: 'center',
  },
  accountSubtitle: {
    fontSize: 14,
    color: '#627d98',
    textAlign: 'center',
    marginBottom: 8,
  },
  carteInfo: {
    fontSize: 14,
    color: '#627d98',
    marginBottom: 16,
    marginTop: 2,
  },
  locationCard: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#d9e2ec',
    backgroundColor: '#ffffff',
    padding: 14,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  locationCardLeft: {
    flex: 1,
  },
  locationName: {
    fontSize: 16,
    fontWeight: '700',
    color: '#102a43',
    marginBottom: 4,
  },
  locationCoords: {
    fontSize: 13,
    color: '#627d98',
    fontFamily: 'monospace',
  },
  locationTime: {
    fontSize: 12,
    color: '#9fb3c8',
    marginTop: 6,
  },
  locationIndicator: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#bcccdc',
    marginLeft: 12,
  },
  locationIndicatorCurrent: {
    backgroundColor: '#0f766e',
  },
  emptyText: {
    fontSize: 16,
    color: '#9fb3c8',
    textAlign: 'center',
    marginTop: 20,
  },
  carteContainer: {
    flex: 1,
    position: 'relative',
  },
  map: {
    flex: 1,
  },
  mapNotice: {
    position: 'absolute',
    top: 16,
    left: 16,
    right: 16,
    backgroundColor: 'rgba(16, 42, 67, 0.88)',
    borderRadius: 10,
    padding: 12,
  },
  mapNoticeText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 18,
  },
  mapPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f0f0f0',
  },
  mapPlaceholderText: {
    fontSize: 16,
    color: '#627d98',
  },
  legend: {
    position: 'absolute',
    bottom: 20,
    left: 16,
    right: 16,
    backgroundColor: 'rgba(255, 255, 255, 0.95)',
    borderRadius: 10,
    padding: 12,
    gap: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
    elevation: 5,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  legendColor: {
    width: 16,
    height: 16,
    borderRadius: 8,
  },
  legendText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#102a43',
  },
  participantPanel: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 118,
    backgroundColor: 'rgba(255, 255, 255, 0.97)',
    borderRadius: 12,
    padding: 10,
    gap: 8,
    borderWidth: 1,
    borderColor: '#d9e2ec',
  },
  participantPanelActive: {
    bottom: 8,
    paddingVertical: 8,
    gap: 6,
  },
  participantPanelTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#102a43',
  },
  eventSelectorRow: {
    gap: 8,
  },
  eventSelectorCard: {
    minWidth: 150,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#d9e2ec',
    padding: 10,
    backgroundColor: '#ffffff',
  },
  eventSelectorCardActive: {
    borderColor: '#0f766e',
    backgroundColor: '#f0fdfa',
  },
  eventSelectorTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#102a43',
  },
  eventSelectorMeta: {
    fontSize: 12,
    color: '#627d98',
    marginTop: 4,
  },
  participantArrowContainer: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  participantArrowGlyph: {
    fontSize: 28,
    fontWeight: '900',
    lineHeight: 28,
  },
  navigationMetricsCard: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#d9e2ec',
    backgroundColor: '#ffffff',
    padding: 10,
    gap: 4,
  },
  navigationMetric: {
    fontSize: 13,
    color: '#334e68',
    fontWeight: '600',
  },
  navigationMetricAlert: {
    fontSize: 13,
    color: '#b91c1c',
    fontWeight: '700',
    marginTop: 2,
  },
  modeSwitchRow: {
    flexDirection: 'row',
    gap: 8,
  },
  modeButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#9fb3c8',
    borderRadius: 999,
    paddingVertical: 8,
    alignItems: 'center',
    backgroundColor: '#ffffff',
  },
  modeButtonActive: {
    backgroundColor: '#0f766e',
    borderColor: '#0f766e',
  },
  modeButtonText: {
    color: '#334e68',
    fontWeight: '700',
    fontSize: 12,
  },
  modeButtonTextActive: {
    color: '#ffffff',
  },
  actionRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  urgencyButton: {
    flex: 1,
    borderRadius: 10,
    backgroundColor: '#dc2626',
    paddingVertical: 11,
    alignItems: 'center',
  },
  urgencyButtonText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 14,
  },
  adminEmergencyPanel: {
    position: 'absolute',
    top: 16,
    right: 16,
    left: 16,
    backgroundColor: 'rgba(127, 29, 29, 0.92)',
    borderRadius: 10,
    padding: 10,
    gap: 6,
  },
  adminEmergencyTitle: {
    color: '#fee2e2',
    fontWeight: '700',
    fontSize: 13,
  },
  adminEmergencyItem: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '600',
  },
  focusContainer: {
    flex: 1,
    padding: 18,
    backgroundColor: '#061b2b',
    gap: 14,
    justifyContent: 'center',
  },
  focusEmergencyWrap: {
    position: 'absolute',
    top: 14,
    right: 14,
    zIndex: 2,
  },
  focusUrgencyButton: {
    borderRadius: 999,
    backgroundColor: '#dc2626',
    paddingVertical: 8,
    paddingHorizontal: 12,
    alignItems: 'center',
  },
  focusUrgencyButtonText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 12,
  },
  focusTitle: {
    color: '#e0f2fe',
    fontSize: 24,
    fontWeight: '800',
    textAlign: 'center',
  },
  focusSubtitle: {
    color: '#bae6fd',
    textAlign: 'center',
    fontSize: 14,
    marginBottom: 8,
  },
  focusArrowFrame: {
    alignSelf: 'center',
    width: 180,
    height: 180,
    borderRadius: 90,
    borderWidth: 2,
    borderColor: '#1d4ed8',
    backgroundColor: '#0c4a6e',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 8,
    elevation: 7,
  },
  focusArrow: {
    width: 0,
    height: 0,
    borderLeftWidth: 24,
    borderRightWidth: 24,
    borderBottomWidth: 70,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: '#93c5fd',
  },
  fieldRow: {
    flexDirection: 'row',
    gap: 10,
  },
  eventFieldGroup: {
    gap: 6,
  },
  eventFieldLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: '#334e68',
  },
  halfInput: {
    flex: 1,
  },
  selectorDateField: {
    backgroundColor: '#f0fdfa',
    borderColor: '#0f766e',
  },
  gpxInput: {
    minHeight: 140,
  },
  gpxPreviewBox: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#d9e2ec',
    backgroundColor: '#ffffff',
    padding: 12,
    gap: 6,
    marginBottom: 8,
  },
  gpxPreviewLabel: {
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    color: '#9fb3c8',
    fontWeight: '700',
  },
  gpxPreviewText: {
    fontSize: 14,
    color: '#334e68',
    lineHeight: 20,
  },
  helperText: {
    fontSize: 13,
    color: '#627d98',
    marginTop: 6,
    marginBottom: 8,
  },
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 6,
    marginBottom: 10,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#9fb3c8',
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxActive: {
    borderColor: '#0f766e',
    backgroundColor: '#e6fffb',
  },
  checkboxDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#0f766e',
  },
  checkboxLabel: {
    fontSize: 15,
    color: '#334e68',
    fontWeight: '600',
  },
  eventList: {
    gap: 10,
    marginBottom: 8,
  },
  eventCard: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#d9e2ec',
    backgroundColor: '#ffffff',
    padding: 12,
    gap: 6,
  },
  eventCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 10,
  },
  eventHeaderActions: {
    alignItems: 'flex-end',
    gap: 8,
  },
  eventCardTitleBlock: {
    flex: 1,
  },
  eventCardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#102a43',
  },
  eventCardMeta: {
    fontSize: 13,
    color: '#627d98',
    marginTop: 2,
  },
  eventBadge: {
    backgroundColor: '#e6fffb',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  eventBadgeText: {
    color: '#0f766e',
    fontSize: 12,
    fontWeight: '700',
  },
  deleteEventButton: {
    borderWidth: 1,
    borderColor: '#ef4444',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    backgroundColor: '#fff1f2',
  },
  deleteEventButtonText: {
    color: '#b91c1c',
    fontSize: 12,
    fontWeight: '700',
  },
});
