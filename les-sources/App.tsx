import AsyncStorage from '@react-native-async-storage/async-storage';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import * as Location from 'expo-location';
import { StatusBar } from 'expo-status-bar';
import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import MapView, { Marker, Polyline } from 'react-native-maps';

type Role = 'admin' | 'benevole' | 'participant';
type Page = 'admin' | 'carte';

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

const STORAGE_KEY = 'les-sources-users-v1';
const STORAGE_LOCATIONS_KEY = 'les-sources-locations-v1';
const STORAGE_EVENTS_KEY = 'les-sources-events-v1';

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

const getLocalDateKey = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const isValidDateInput = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

const isValidTimeInput = (value: string) => /^\d{2}:\d{2}$/.test(value);

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
  if (event.showForVolunteers) {
    return role === 'admin' || role === 'benevole';
  }

  return event.date === getLocalDateKey(new Date());
};

export default function App() {
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

  useEffect(() => {
    loadUsers();
    loadUserLocations();
    loadEvents();
  }, []);

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
    await AsyncStorage.setItem(STORAGE_EVENTS_KEY, JSON.stringify(nextEvents));
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

      const gpxText = await FileSystem.readAsStringAsync(asset.uri, {
        encoding: FileSystem.EncodingType.UTF8,
      });

      setEventGpxText(gpxText);
      setEventGpxFileName(fileName);
    } catch {
      Alert.alert('Erreur', 'Impossible de lire le fichier GPX.');
    }
  };

  const updateUserLocation = async (
    userId: string,
    username: string,
    latitude: number,
    longitude: number
  ) => {
    const existingIndex = userLocations.findIndex((loc: UserLocation) => loc.userId === userId);
    const newLocation: UserLocation = {
      userId,
      username,
      latitude,
      longitude,
      timestamp: Date.now(),
    };

    let updatedLocations: UserLocation[];
    if (existingIndex >= 0) {
      updatedLocations = [...userLocations];
      updatedLocations[existingIndex] = newLocation;
    } else {
      updatedLocations = [...userLocations, newLocation];
    }

    setUserLocations(updatedLocations);
    await AsyncStorage.setItem(STORAGE_LOCATIONS_KEY, JSON.stringify(updatedLocations));
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
          newLoc.longitude
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

    if (currentUser?.id === userId) {
      handleLogout();
    }
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
    <SafeAreaView style={styles.screen}>
      <StatusBar style="dark" />
      <View style={styles.panelHeader}>
        <View>
          <Text style={styles.panelTitle}>Bonjour {currentUser.username}</Text>
          <Text style={styles.panelSubtitle}>Role: {currentUser.role}</Text>
        </View>
        <Pressable style={styles.secondaryButton} onPress={handleLogout}>
          <Text style={styles.secondaryButtonText}>Deconnexion</Text>
        </Pressable>
      </View>

      {/* Navigation tabs */}
      <View style={styles.navTabs}>
        <Pressable
          style={[styles.navTab, currentPage === 'carte' && styles.navTabActive]}
          onPress={() => setCurrentPage('carte')}
        >
          <Text style={[styles.navTabText, currentPage === 'carte' && styles.navTabTextActive]}>
            Carte
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

      {/* Content pages */}
      {currentPage === 'carte' ? (
        <View style={styles.carteContainer}>
          <MapView
            key={currentLocation ? `${currentLocation.latitude}-${currentLocation.longitude}` : 'default-map'}
            style={styles.map}
            initialRegion={currentLocation ? {
              latitude: currentLocation.latitude,
              longitude: currentLocation.longitude,
              latitudeDelta: 0.0922,
              longitudeDelta: 0.0421,
            } : DEFAULT_MAP_REGION}
            mapType="satellite"
          >
            {currentLocation && (
              <Marker
                coordinate={{
                  latitude: currentLocation.latitude,
                  longitude: currentLocation.longitude,
                }}
                title="Ma position"
                description={currentUser.username}
                pinColor={getMarkerColorByRole(currentUser.role)}
              />
            )}

            {userLocations.map((location: UserLocation) => {
              if (location.userId === currentUser.id) return null;
              const user = users.find((u: User) => u.id === location.userId);
              if (!user) return null;

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

              return (
                <Fragment key={event.id}>
                  <Polyline coordinates={points} strokeColor={color} strokeWidth={4} />
                  <Marker
                    coordinate={points[0]}
                    title={event.name}
                    description={`${event.date} ${event.startTime} - ${event.endTime}`}
                    pinColor={color}
                  />
                  <Marker
                    coordinate={points[points.length - 1]}
                    title={`${event.name} - fin`}
                    pinColor={color}
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

          {/* Légende */}
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
        </View>
      ) : (
        <ScrollView style={styles.pageContainer} contentContainerStyle={styles.pageContent}>
          <View style={styles.adminContainer}>
            <Text style={styles.sectionTitle}>Creer un evenement</Text>
            <TextInput
              style={styles.input}
              placeholder="Nom de l evenement"
              value={eventName}
              onChangeText={setEventName}
            />
            <View style={styles.fieldRow}>
              <TextInput
                style={[styles.input, styles.halfInput]}
                placeholder="Date YYYY-MM-DD"
                value={eventDate}
                onChangeText={setEventDate}
                autoCapitalize="none"
              />
              <TextInput
                style={[styles.input, styles.halfInput]}
                placeholder="Debut HH:MM"
                value={eventStartTime}
                onChangeText={setEventStartTime}
                autoCapitalize="none"
              />
            </View>
            <TextInput
              style={styles.input}
              placeholder="Fin HH:MM"
              value={eventEndTime}
              onChangeText={setEventEndTime}
              autoCapitalize="none"
            />
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

                  return (
                    <View key={event.id} style={styles.eventCard}>
                      <View style={styles.eventCardHeader}>
                        <View style={styles.eventCardTitleBlock}>
                          <Text style={styles.eventCardTitle}>{event.name}</Text>
                          <Text style={styles.eventCardMeta}>
                            {event.date} de {event.startTime} a {event.endTime}
                          </Text>
                        </View>
                        <View style={styles.eventBadge}>
                          <Text style={styles.eventBadgeText}>{visibilityLabel}</Text>
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
              placeholder="Nom d utilisateur"
              value={newUsername}
              onChangeText={setNewUsername}
              autoCapitalize="none"
            />
            <TextInput
              style={styles.input}
              placeholder="Mot de passe"
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
      )}
    </SafeAreaView>
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
  fieldRow: {
    flexDirection: 'row',
    gap: 10,
  },
  halfInput: {
    flex: 1,
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
});
