import { Agent, get } from 'node:https';
import { DatabaseSync } from 'node:sqlite';
import { conditionsUrl, decodeConditions, localNow, minutesPerDay } from './public/sailings.js';

const agent = new Agent({ proxyEnv: process.env });
const historyWindow = 30 * minutesPerDay;

function readConditions() {
  return new Promise((resolve, reject) => {
    const request = get(conditionsUrl, { agent, headers: { Accept: 'application/json' } }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error('Conditions request returned HTTP ' + response.statusCode));
        return;
      }
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        text += chunk;
        if (text.length > 2_000_000) request.destroy(new Error('Conditions response exceeds the size limit'));
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          resolve(decodeConditions(JSON.parse(text)));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(10_000, () => request.destroy(new Error('Conditions request timed out')));
    request.on('error', reject);
  });
}

export function collectSailings() {
  const database = new DatabaseSync(new URL('./data/observed-sailings.sqlite', import.meta.url));
  database.exec(`
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS departures (
      direction TEXT NOT NULL,
      scheduled INTEGER NOT NULL,
      actual INTEGER NOT NULL,
      actualArrival INTEGER,
      vessel TEXT NOT NULL,
      observedAt INTEGER NOT NULL,
      PRIMARY KEY (direction, scheduled)
    )
  `);
  const put = database.prepare(`
    INSERT INTO departures VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (direction, scheduled) DO UPDATE SET
      actual = excluded.actual,
      actualArrival = coalesce(excluded.actualArrival, departures.actualArrival),
      vessel = coalesce(nullif(excluded.vessel, ''), departures.vessel),
      observedAt = excluded.observedAt
    WHERE excluded.observedAt >= departures.observedAt
  `);
  const prune = database.prepare('DELETE FROM departures WHERE scheduled < ?');
  const history = database.prepare('SELECT * FROM departures WHERE scheduled >= ? ORDER BY scheduled DESC');
  let conditions = null;

  async function refresh() {
    try {
      conditions = await readConditions();
      database.exec('BEGIN IMMEDIATE');
      try {
        for (const record of conditions.reports) {
          if (record.actual === null || record.observedAt === null) continue;
          put.run(record.direction, record.scheduled, record.actual, record.actualArrival, record.vessel, record.observedAt);
        }
        prune.run(localNow() - historyWindow);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    } catch (error) {
      console.warn('Coast Easy sailing collector:', error.message);
    } finally {
      setTimeout(refresh, 60_000).unref();
    }
  }

  void refresh();
  return () => ({ conditions, history: history.all(localNow() - historyWindow) });
}
