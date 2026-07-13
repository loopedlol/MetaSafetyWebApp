import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../server/repositories/database.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const databasePath = process.env.DATABASE_PATH ?? path.join(rootDir, 'data', 'safety-lens.sqlite');
const migrationsDir = path.join(rootDir, 'db', 'migrations');
const database = openDatabase({ databasePath, migrationsDir });
const applied = database.raw.prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version').all();
database.close();

console.log(`SQLite migrations complete: ${databasePath}`);
applied.forEach((migration) => console.log(`${migration.version} ${migration.applied_at}`));
