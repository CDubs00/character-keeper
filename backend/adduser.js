const fs       = require('fs');
const path     = require('path');
const bcrypt   = require('bcrypt');
const readline = require('readline');
const { validateUsername } = require('./validateUsername');

const DATA_DIR   = process.env.DATA_DIR || path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

const args     = process.argv.slice(2);
const username = args[0];
const isAdmin  = args.includes('--admin');

if (!username) {
  console.log('Usage: node adduser.js <username> [--admin]');
  process.exit(1);
}

const usernameError = validateUsername(username);
if (usernameError) {
  console.log(usernameError);
  process.exit(1);
}

function promptPassword() {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question('Password: ', pw => { rl.close(); resolve(pw); });
  });
}

async function main() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const users = fs.existsSync(USERS_FILE)
    ? JSON.parse(fs.readFileSync(USERS_FILE))
    : [];

  if (users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
    console.log(`User "${username}" already exists`);
    process.exit(1);
  }

  const password = await promptPassword();
  if (!password) {
    console.log('Password cannot be empty');
    process.exit(1);
  }

  const hashed = await bcrypt.hash(password, 10);
  users.push({
    username,
    password:     hashed,
    admin:        isAdmin,
    gm:           false,
    player:       !isAdmin,
    tokenVersion: 1,
  });

  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  console.log(`User "${username}" created${isAdmin ? ' (admin)' : ''}`);
}

main();
