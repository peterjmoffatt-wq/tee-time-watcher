#!/usr/bin/env node
// One-off, local-only migration: turns the existing single-user courses.json
// into the owner's account + encrypted per-user facilities.json under data/.
// Run this on your own machine BEFORE deploying, so the real ForeUp password
// never crosses the network in plaintext — only the resulting encrypted
// data/ directory gets uploaded to the host.
//
// Usage:
//   node scripts/migrate-owner.js [path/to/courses.json] [email] [new-site-password]
// Any omitted argument is prompted for interactively.

'use strict';

const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const readline = require('readline');

const store      = require('../lib/store');
const auth       = require('../lib/auth');
const credCrypto = require('../lib/crypto');

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer); }));
}

async function main() {
  const coursesPath = process.argv[2] || path.join(__dirname, '..', 'courses.json');
  if (!fs.existsSync(coursesPath)) {
    console.error(`Not found: ${coursesPath}`);
    process.exit(1);
  }

  if (!process.env.CREDENTIALS_KEY) {
    const generated = crypto.randomBytes(32).toString('hex');
    process.env.CREDENTIALS_KEY = generated;
    console.log('No CREDENTIALS_KEY set in this shell — generated one for this run:\n');
    console.log(`  ${generated}\n`);
    console.log('Save this exact value. Set it as the CREDENTIALS_KEY Fly secret, or re-run');
    console.log('this script with CREDENTIALS_KEY already exported to reuse an existing one.\n');
  }

  const facilities = JSON.parse(fs.readFileSync(coursesPath, 'utf8'));
  if (!Array.isArray(facilities) || !facilities.length) {
    console.error('courses.json is empty or not an array — nothing to migrate.');
    process.exit(1);
  }

  const email = (process.argv[3] || await ask('Owner account email: ')).trim().toLowerCase();
  const sitePassword = process.argv[4] ||
    await ask('New site login password for this account (NOT your ForeUp password): ');

  if (!email || !sitePassword || sitePassword.length < 8) {
    console.error('Email and an 8+ character site password are required.');
    process.exit(1);
  }

  const existing = store.getUsers();
  if (existing.some(u => u.email === email)) {
    console.error(`A user with email ${email} already exists in data/users.json — aborting.`);
    process.exit(1);
  }

  const passwordHash = await auth.hashPassword(sitePassword);
  const userId  = crypto.randomUUID();
  const newUser = { id: userId, email, passwordHash, createdAt: new Date().toISOString() };
  await store.updateUsers((list) => { list.push(newUser); });

  const encryptedFacilities = facilities.map(fac => ({
    ...fac,
    id:             fac.id || crypto.randomUUID(),
    password:       credCrypto.encrypt(fac.password),
    credit_card_id: credCrypto.encrypt(fac.credit_card_id),
  }));
  await store.updateFacilities(userId, (list) => { list.push(...encryptedFacilities); });

  console.log(`\nMigrated ${encryptedFacilities.length} facilities for ${email} (user id ${userId}).`);
  console.log(`Data written under: ${store.DATA_DIR}`);
  console.log('Next: upload this data/ directory to the Fly volume, and set CREDENTIALS_KEY');
  console.log('as a Fly secret to the exact value used above.');
}

main().catch(err => { console.error(err); process.exit(1); });
