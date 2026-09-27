import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const dir = path.join(os.homedir(), '.config', 'cabalscan');
const file = path.join(dir, 'credentials.json');
process.stdout.write('Enter the Helius API key (input is hidden): ');
process.stdin.setRawMode?.(true);
process.stdin.resume();
let value = '';
process.stdin.on('data', async (chunk) => {
  const text = chunk.toString();
  if (text === '\u0003') process.exit(130);
  if (text === '\r' || text === '\n') {
    process.stdin.setRawMode?.(false); process.stdin.pause();
    await fs.mkdir(dir, { recursive:true });
    await fs.writeFile(file, JSON.stringify({ heliusApiKey:value.trim() }, null, 2), { encoding:'utf8', mode:0o600 });
    console.log('\nKey saved locally outside the project.');
    process.exit(0);
  }
  if (text === '\u007f') value = value.slice(0,-1); else value += text;
});
