# Firebase Setup Guide

TaskFlow uses a freshly provisioned Firebase project and Cloud Firestore database:

- **Firebase Project ID**: `gen-lang-client-0707937978`
- **Firestore Database ID**: `ai-studio-subscriptiontask-992983c8-db4b-4b78-98e3-4f6d1adf9bac`
- **Firestore Region**: `asia-south1`
- **Auth Domain**: `gen-lang-client-0707937978.firebaseapp.com`
- **Storage Bucket**: `gen-lang-client-0707937978.firebasestorage.app`

## 1. Web Client Configuration

The public Web SDK configuration is stored in:
- `/firebase-applet-config.json`
- `/client/src/firebase-applet-config.json`

Both files initialize `getFirestore(app, firebaseConfig.firestoreDatabaseId)` against `ai-studio-subscriptiontask-992983c8-db4b-4b78-98e3-4f6d1adf9bac`.

## 2. Backend Firebase Admin SDK Credentials

Configure the following environment variables on your backend host (e.g., Render):

```env
FIREBASE_PROJECT_ID=gen-lang-client-0707937978
FIRESTORE_DATABASE_ID=ai-studio-subscriptiontask-992983c8-db4b-4b78-98e3-4f6d1adf9bac
FIREBASE_STORAGE_BUCKET=gen-lang-client-0707937978.firebasestorage.app
FIREBASE_CLIENT_EMAIL=<service-account-email@gen-lang-client-0707937978.iam.gserviceaccount.com>
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

Verify connectivity at `/api/health` and `/api/bootstrap/status`.

## 3. Security Rules & Composite Indexes

- **Security Rules**: Defined in `/firestore.rules` and verified with `npx eslint firestore.rules` (`@firebase/eslint-plugin-security-rules`).
- **Schema Blueprint**: Defined in `/firebase-blueprint.json`.
- **Composite Indexes**: Defined in `/firestore.indexes.json` — deploy using:
  ```bash
  firebase deploy --only firestore:indexes --project gen-lang-client-0707937978
  ```

## 4. First-Time Workspace Initialization

TaskFlow does **not** seed hardcoded admin passwords or mock accounts. Once Admin SDK credentials are active, open `/login` to initialize your Workspace and primary Administrator via `POST /api/bootstrap`.
