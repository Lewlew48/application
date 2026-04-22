# Les Sources

Application mobile Expo (Android + iPhone) avec:

- Ecran de connexion
- Compte administrateur par defaut (`admin` / `admin`)
- Gestion des comptes utilisateurs depuis l'espace admin (creation + suppression)

## Pre-requis

- Application Expo Go sur le smartphone
- Un navigateur web (Chrome, Edge, Firefox, Safari)

## Tester sans Node.js (recommande)

1. Ouvrir https://snack.expo.dev dans un navigateur.
2. Creer un nouveau Snack vide.
3. Copier le contenu de App.tsx de ce projet dans le fichier App.js du Snack.
4. Installer la dependance @react-native-async-storage/async-storage depuis le panneau Dependencies du Snack.
5. Scanner le QR code du Snack avec Expo Go.

## Installation locale (optionnelle, avec Node.js)

Si tu veux executer le projet localement depuis ce dossier:

1. Installer Node.js LTS.
2. Ouvrir un terminal dans le dossier les-sources.
3. Lancer npm install.
4. Lancer npm run start.

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
