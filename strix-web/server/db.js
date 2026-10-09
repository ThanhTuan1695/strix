import { MongoClient } from 'mongodb';

const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017';
const DB_NAME = process.env.MONGO_DB || 'strix';

let client;
let db;

export async function connectDB() {
  client = new MongoClient(MONGO_URL);
  await client.connect();
  db = client.db(DB_NAME);

  await db.collection('scans').createIndex({ id: 1 }, { unique: true });
  await db.collection('mobileScans').createIndex({ id: 1 }, { unique: true });

  console.log(`MongoDB connected: ${MONGO_URL}/${DB_NAME}`);
  return db;
}

export function getDB() {
  return db;
}

export async function saveScan(scanData) {
  if (!db) return;
  const doc = { ...scanData };
  delete doc.pid;
  await db.collection('scans').updateOne(
    { id: doc.id },
    { $set: doc },
    { upsert: true },
  );
}

export async function saveMobileScan(scanData) {
  if (!db) return;
  const doc = { ...scanData };
  delete doc.filePath;
  await db.collection('mobileScans').updateOne(
    { id: doc.id },
    { $set: doc },
    { upsert: true },
  );
}

export async function deleteScan(scanId) {
  if (!db) return;
  await db.collection('scans').deleteOne({ id: scanId });
}

export async function deleteMobileScan(scanId) {
  if (!db) return;
  await db.collection('mobileScans').deleteOne({ id: scanId });
}

export async function loadAllScans() {
  if (!db) return [];
  return db.collection('scans').find().toArray();
}

export async function loadAllMobileScans() {
  if (!db) return [];
  return db.collection('mobileScans').find().toArray();
}

export async function closeDB() {
  if (client) await client.close();
}
