import { MongoClient } from 'mongodb';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { Store } from './db.js';
import { GoogleCalendar } from './google.js';
import { OpenAIDateInterpreter } from './interpreter.js';
import { BookingService } from './service.js';

const config = loadConfig();
const client = new MongoClient(config.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
await client.connect();
const store = new Store(client.db(config.MONGODB_DATABASE));
await store.init();
const google = new GoogleCalendar(store, config);
const service = new BookingService(store, config, google, new OpenAIDateInterpreter(config.OPENAI_API_KEY, config.OPENAI_MODEL));
const app = createApp(config, service, google);
const server = app.listen(config.PORT, () => console.log(JSON.stringify({ event: 'listening', port: config.PORT })));
let recovering: Promise<void> | undefined;
const recover = () => {
  if (!recovering) recovering = service.recover().catch(() => { console.error(JSON.stringify({ event: 'recovery_failed' })); }).finally(() => { recovering = undefined; });
};
recover();
const timer = setInterval(recover, 30000);
timer.unref();
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true; clearInterval(timer);
  const deadline = setTimeout(() => process.exit(1), 20000); deadline.unref();
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (recovering) await recovering;
  await client.close(); clearTimeout(deadline);
}
process.on('SIGTERM', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
