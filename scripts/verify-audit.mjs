import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../server/repositories/database.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const databasePath = process.env.DATABASE_PATH ?? path.join(rootDir, 'data', 'safety-lens.sqlite');
const database = openDatabase({ databasePath, migrationsDir: path.join(rootDir, 'db', 'migrations') });
const result = database.verifyAuditIntegrity();
database.close();

console.log(JSON.stringify(result, null, 2));
if (!result.valid) process.exitCode = 1;
