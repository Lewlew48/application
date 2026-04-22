# Les Sources

Application mobile Expo (Android + iPhone) avec:

- Ecran de connexion
- Compte administrateur par defaut (`admin` / `admin`)
- Gestion des comptes utilisateurs depuis l'espace admin (creation + suppression)
- Page Carte affichant les positions GPS en temps réel de tous les utilisateurs

## Important: Snack Expo

Cette application est conçue pour fonctionner avec **Snack Expo** (https://snack.expo.dev).

⚠️ **Limitations de Snack Expo:**
- La carte satellite (react-native-maps) n'est **pas disponible** sur Snack Expo - elle ne peut être utilisée que dans une installation locale
- La géolocalisation GPS (expo-location) est **limitée** sur Snack Expo et peut nécessiter des permissions supplémentaires selon votre navigateur

## Rôles

L'application supporte 3 rôles:
- **admin**: Accès complet à la gestion des comptes et à la carte
- **benevole**: Accès à la carte et affichage de sa position
- **participant**: Accès à la carte et affichage de sa position

## Pre-requis

- Application Expo Go sur le smartphone
- Un navigateur web (Chrome, Edge, Firefox, Safari)

## Tester sur Snack Expo (recommandé)

1. Ouvrir https://snack.expo.dev dans un navigateur.
2. Créer un nouveau Snack vide.
3. Copier le contenu de App.tsx de ce projet dans le fichier App.js du Snack.
4. Installer les dépendances depuis le panneau **Dependencies** du Snack:
   - `@react-native-async-storage/async-storage`
   - `expo-location` (optionnel - pour la géolocalisation)
   - **Note:** `react-native-maps` n'est **pas supporté** sur Snack Expo
5. Scanner le QR code du Snack avec Expo Go.

### Fonctionnalités sur Snack Expo

- ✅ Authentification et gestion des comptes
- ✅ Navigation entre les pages
- ⚠️ Carte: Affichage basique (sans vue satellite) - voir la section "Installation locale" pour la version complète

## Installation locale (pour la version complète avec carte satellite)

Si tu veux executer le projet localement avec toutes les fonctionnalites (carte satellite + géolocalisation GPS complète):

1. Installer Node.js LTS.
2. Ouvrir un terminal dans le dossier les-sources.
3. Lancer `npm install`.
4. Lancer `npm run start`.

### Fonctionnalités en local (complètes)

- ✅ Authentification et gestion des comptes
- ✅ Navigation entre les pages
- ✅ Carte satellite avec vue satellite (mapType="satellite")
- ✅ Géolocalisation GPS complète et en temps réel
- ✅ Marqueurs colorés par rôle sur la carte

Dans les deux cas:

- Scanner le QR code avec Expo Go sur Android
- Sur iPhone, scanner le QR code depuis l'appareil photo puis ouvrir Expo Go

## Comptes de test

- Admin:
  - identifiant: `admin`
  - mot de passe: `admin`

## Fonctionnement

- La connexion verifie les identifiants stockes localement.
- Les comptes utilisateurs sont persistants localement avec AsyncStorage.
- Le compte `admin` ne peut pas etre supprime.
- **Page Carte** (version locale uniquement):
  - Affichage d'une vraie carte en vue satellite
  - Les positions utilisent la géolocalisation réelle du téléphone
  - Tous les utilisateurs connectés peuvent voir les positions GPS des autres
  - Les marqueurs sont colorés selon le rôle:
    - **Orange** (#ff8c42) pour les participants
    - **Bleu** (#4b7bff) pour les bénévoles
    - **Vert** (#0f766e) pour les administrateurs
  - L'utilisateur courant est également affiché sur la carte avec une légende
