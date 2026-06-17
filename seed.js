// Seed the database with sample guests for local testing.
// Run with: npm run seed
const store = require('./db');

const sample = [
  { full_name: 'Sara Ahmed',        mobile: '+97455123456', seats: 2 },
  { full_name: 'Khalid Al-Thani',   mobile: '+97466778899', seats: 4 },
  { full_name: 'Maryam Hassan',     mobile: '+97433221100', seats: 1 },
  { full_name: 'Omar Faisal',       mobile: '+97450009988', seats: 3 },
  { full_name: 'Layla Nabil',       mobile: '+97477665544', seats: 2 },
];

const n = store.bulkUpsert(sample);
console.log(`Seeded ${n} guests.`);
console.log(store.getStats());
