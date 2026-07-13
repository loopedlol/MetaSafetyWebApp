import { chmod, copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDatabase } from '../server/repositories/database.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

async function readJsonArray(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function timestampForPath(date = new Date()) {
  return date.toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

export async function importLegacyJson({
  databasePath,
  dataDir,
  migrationsDir,
  defaultOwnerEmail,
  backupRoot = path.join(dataDir, 'legacy-backups'),
  now = () => new Date().toISOString()
}) {
  const sourceFiles = ['users.json', 'sessions.json', 'uploads.json'];
  const backupDir = path.join(backupRoot, timestampForPath(new Date(now())));
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  for (const filename of sourceFiles) {
    try {
      const backupPath = path.join(backupDir, filename);
      await copyFile(path.join(dataDir, filename), backupPath);
      await chmod(backupPath, 0o600);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  const [users, sessions, uploads] = await Promise.all(
    sourceFiles.map((filename) => readJsonArray(path.join(dataDir, filename)))
  );
  const database = openDatabase({ databasePath, migrationsDir, now });
  const summary = { users: 0, sessions: 0, uploads: 0, skipped: 0, backupDir };

  try {
    for (const user of users) {
      if (database.hasLegacyImport('user', user.id)) {
        summary.skipped += 1;
        continue;
      }
      const existing = database.findUserById(user.id) ?? database.findUserByEmail(user.email);
      if (!existing) database.createUser(user);
      database.recordLegacyImport({ sourceType: 'user', sourceId: user.id, entityType: 'user', entityId: user.id });
      summary.users += 1;
    }

    const databaseUsers = database.listUsers();
    const defaultOwner = defaultOwnerEmail
      ? database.findUserByEmail(defaultOwnerEmail)
      : databaseUsers.length === 1
        ? databaseUsers[0]
        : null;

    for (const upload of uploads) {
      if (database.hasLegacyImport('upload', upload.id)) {
        summary.skipped += 1;
        continue;
      }
      const ownerId = upload.ownerId ?? defaultOwner?.id;
      if (!ownerId) throw new Error(`Cannot assign owner for legacy upload ${upload.id}. Use --default-owner-email.`);
      if (!database.getUploadForOwner(upload.id, ownerId)) {
        database.createEvidenceUploads([{ ...upload, ownerId }], ownerId);
      }
      database.recordLegacyImport({ sourceType: 'upload', sourceId: upload.id, entityType: 'evidence_upload', entityId: upload.id });
      summary.uploads += 1;
    }

    for (const session of sessions) {
      if (database.hasLegacyImport('session', session.sessionId)) {
        summary.skipped += 1;
        continue;
      }
      const ownerId = session.ownerId ?? session.createdBy?.id ?? defaultOwner?.id;
      if (!ownerId || !database.findUserById(ownerId)) {
        throw new Error(`Cannot assign owner for legacy session ${session.sessionId}. Use --default-owner-email.`);
      }
      database.saveSession(
        { ...session, ownerId },
        ownerId,
        { saveMode: ['completed', 'actions_open'].includes(session.status) ? 'finalize' : 'draft' }
      );
      database.recordLegacyImport({
        sourceType: 'session',
        sourceId: session.sessionId,
        entityType: 'tbm_session',
        entityId: session.sessionId
      });
      summary.sessions += 1;
    }
  } finally {
    database.close();
  }

  return summary;
}

function parseArguments(argv) {
  const valueAfter = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    databasePath: valueAfter('--database') ?? process.env.DATABASE_PATH ?? path.join(rootDir, 'data', 'safety-lens.sqlite'),
    dataDir: valueAfter('--data-dir') ?? path.join(rootDir, 'data'),
    migrationsDir: path.join(rootDir, 'db', 'migrations'),
    defaultOwnerEmail: valueAfter('--default-owner-email')
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const summary = await importLegacyJson(parseArguments(process.argv.slice(2)));
  console.log(JSON.stringify(summary, null, 2));
}
