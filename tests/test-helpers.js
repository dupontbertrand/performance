const timeout = 120000;
let _mongoClient = null;
let _mongoDb = null;

async function getMongoDb() {
  if (_mongoDb) return _mongoDb;
  const { MongoClient } = require('mongodb');
  const url = process.env.MONGO_URL || 'mongodb://127.0.0.1:3001/meteor';
  // Meteor default db name is the path part of the URL (meteor) if not specified
  // We let driver parse it.
  _mongoClient = new MongoClient(url, { maxPoolSize: 2 });
  await _mongoClient.connect();
  _mongoDb = _mongoClient.db();
  return _mongoDb;
}

async function cleanDatabase({ collectionName = 'taskCollection', maxRetries = 3 } = {}) {
  let attempt = 0;
  const db = await getMongoDb();
  while (attempt < maxRetries) {
    attempt += 1;
    try {
      const col = db.collection(collectionName);
      await col.deleteMany({});
      return true;
    } catch (err) {
      if (attempt >= maxRetries) {
        console.warn(`Failed to clean collection ${collectionName} after ${attempt} attempts`, err);
        return false;
      }
      await new Promise(r => setTimeout(r, 250 * attempt));
    }
  }
}

const addAndRemoveTasks = async ({ page, reactive, taskCount }) => {
  page.setDefaultTimeout(timeout);

  await page.goto(process.env.REMOTE_URL || 'http://localhost:3000/');
  await page.getByLabel(reactive ? 'Reactive' : 'No Reactive', { exact: true }).check();

  await page.getByRole('button', { name: 'Remove all tasks' }).click();

  const sessionId = await page.textContent('span#sessionId');

  const tasks = Array.from({ length: taskCount });
  let addedNum = 1;
  for await (const _addTask of tasks) {
    await page.getByRole('button', { name: 'Add task' }).click();
    await page.waitForSelector(`text="${sessionId} New Task ${addedNum}"`, { state: 'visible' });
    addedNum += 1;
  }
  let removedNum = 1;
  for await (const _removeTask of tasks) {
    await page.getByRole('button', { name: 'Remove task' }).click();
    await page.waitForSelector(`text="${sessionId} New Task ${removedNum}"`, { state: 'detached' });
    removedNum += 1;
  }

  await page.getByRole('button', { name: 'Remove all tasks' }).click();
};

async function reactiveAddAndRemoveTasks(page) {
  const taskCount = parseFloat(process.env.TASK_COUNT || 20);
  await addAndRemoveTasks({ page, reactive: true, taskCount });
}

async function reactiveAddAndRemoveTasksWithCleanup(page) {
  try {
    await cleanDatabase();
  } catch (err) {
    console.warn('Database cleanup encountered an error (continuing with test)', err);
  }
  await reactiveAddAndRemoveTasks(page);
}

async function nonReactiveAddAndRemoveTasks(page) {
  const taskCount = parseFloat(process.env.TASK_COUNT || 20);
  await addAndRemoveTasks({ page, reactive: false, taskCount });
}

module.exports = {
  reactiveAddAndRemoveTasks,
  nonReactiveAddAndRemoveTasks,
  addAndRemoveTasks,
  reactiveAddAndRemoveTasksWithCleanup,
  cleanDatabase,
}
