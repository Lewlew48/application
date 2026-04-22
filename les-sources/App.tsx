import AsyncStorage from '@react-native-async-storage/async-storage';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

type Role = 'admin' | 'user';

type User = {
  id: string;
  username: string;
  password: string;
  role: Role;
};

const STORAGE_KEY = 'les-sources-users-v1';

const DEFAULT_USERS: User[] = [
  {
    id: 'admin-1',
    username: 'admin',
    password: 'admin',
    role: 'admin',
  },
];

export default function App() {
  const [users, setUsers] = useState<User[]>([]);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [isReady, setIsReady] = useState(false);

  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');

  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<Role>('user');

  useEffect(() => {
    loadUsers();
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
        const hasAdmin = parsed.some((u) => u.username === 'admin' && u.role === 'admin');
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

  const handleLogin = () => {
    const username = loginUsername.trim();
    const password = loginPassword.trim();

    const found = users.find((u) => u.username === username && u.password === password);
    if (!found) {
      Alert.alert('Connexion echouee', 'Identifiants invalides.');
      return;
    }

    setCurrentUser(found);
    setLoginPassword('');
  };

  const handleLogout = () => {
    setCurrentUser(null);
    setLoginUsername('');
    setLoginPassword('');
  };

  const handleCreateUser = async () => {
    const username = newUsername.trim();
    const password = newPassword.trim();

    if (!username || !password) {
      Alert.alert('Erreur', 'Le nom d utilisateur et le mot de passe sont obligatoires.');
      return;
    }

    if (users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
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
    setNewRole('user');
  };

  const handleDeleteUser = async (userId: string) => {
    const target = users.find((u) => u.id === userId);
    if (!target) {
      return;
    }

    if (target.username === 'admin') {
      Alert.alert('Action impossible', 'Le compte admin par defaut ne peut pas etre supprime.');
      return;
    }

    const nextUsers = users.filter((u) => u.id !== userId);
    await persistUsers(nextUsers);

    if (currentUser?.id === userId) {
      handleLogout();
    }
  };

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

            <View style={styles.hintBox}>
              <Text style={styles.hint}>Compte admin par defaut</Text>
              <Text style={styles.hintStrong}>Identifiant: admin</Text>
              <Text style={styles.hintStrong}>Mot de passe: admin</Text>
            </View>
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

      {currentUser.role === 'admin' ? (
        <View style={styles.adminContainer}>
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
                style={[styles.roleButton, newRole === 'user' && styles.roleButtonActive]}
                onPress={() => setNewRole('user')}
              >
                <Text style={[styles.roleButtonText, newRole === 'user' && styles.roleButtonTextActive]}>
                  user
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
            renderItem={({ item }) => (
              <View style={styles.userCard}>
                <View>
                  <Text style={styles.userName}>{item.username}</Text>
                  <Text style={styles.userRole}>Role: {item.role}</Text>
                </View>
                <Pressable
                  style={[styles.deleteButton, item.username === 'admin' && styles.deleteButtonDisabled]}
                  onPress={() => handleDeleteUser(item.id)}
                  disabled={item.username === 'admin'}
                >
                  <Text style={styles.deleteButtonText}>Supprimer</Text>
                </Pressable>
              </View>
            )}
          />
        </View>
      ) : (
        <View style={styles.centered}>
          <Text style={styles.title}>Bienvenue sur Les Sources</Text>
          <Text style={styles.subtitle}>Vous etes connecte en utilisateur standard.</Text>
        </View>
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
});
