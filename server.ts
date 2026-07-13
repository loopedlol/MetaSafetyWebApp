import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer } from './server/app.ts';

export { createApp, renderSessionReport, startServer } from './server/app.ts';

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  startServer();
}
