/**
 * Seed the Lite edition with a few sample guests.
 *   node lite/seed.js
 */
const store = require('./store');

const sample = [
  { full_name: 'Sara Ahmed', mobile: '+97455123456', seats: 2 },
  { full_name: 'Khalid Al-Thani', mobile: '+97466778899', seats: 4 },
  { full_name: 'Maryam Hassan', mobile: '+97433445566', seats: 1 },
  { full_name: 'Omar Farooq', mobile: '+97450119988', seats: 3 },
  { full_name: 'Layla Nasser', mobile: '+97477001122', seats: 2 },
];

const n = store.bulkUpsert(sample);
console.log(`Seeded ${n} guest(s) into the Lite store.`);
