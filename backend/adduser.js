const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const { validateUsername } = require('./validateUsername');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

const args = process.argv.slice(2);
const username = args[0];
const password = args[1];
const isAdmin = args.includes('--admin');

if (!username || !password) {
  console.log('Usage: node adduser.js <username> <password> [--admin]');
  process.exit(1);
}

const usernameError = validateUsername(username);
if (usernameError) {
  console.log(usernameError);
  process.exit(1);
}

async function main() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const users = fs.existsSync(USERS_FILE)
    ? JSON.parse(fs.readFileSync(USERS_FILE))
    : [];

  if (users.find(u => u.username === username)) {
    console.log(`User "${username}" already exists`);
    process.exit(1);
  }

  const hashed = await bcrypt.hash(password, 10);
  users.push({
    username,
    password: hashed,
    admin: isAdmin,
    gm: false,
    player: !isAdmin,
  });

  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  console.log(`User "${username}" created${isAdmin ? ' (admin)' : ''}`);
}

main();