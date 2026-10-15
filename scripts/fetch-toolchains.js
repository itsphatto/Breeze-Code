// Downloads the pinned, checksummed Windows toolchains listed in toolchains.json into vendor/.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const root = path.join(__dirname, '..');
const manifestPath = path.join(root, 'toolchains.json');
const vendorDir = path.join(root, 'vendor');

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

function needsFetch(installed, name, version) {
  return installed[name] !== version;
}

async function download(url, to) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(to));
}

// Windows' bsdtar; a GNU tar earlier on PATH (Git Bash) mistakes "C:" for a remote host.
const tarExe = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe') : 'tar';

function unpack(archive, file, dest) {
  if (archive === '7z-sfx') execFileSync(file, ['-y', `-o${dest}`], { stdio: 'ignore' });
  else execFileSync(tarExe, ['-xf', file, '-C', dest], { stdio: 'inherit' });
}

function readVersions(vendor) {
  try { return JSON.parse(fs.readFileSync(path.join(vendor, '.versions.json'), 'utf8')); }
  catch { return {}; }
}

async function fetchTool(name, entry, vendor, deps = {}) {
  const dl = deps.download || download;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `breeze-${name}-`));
  try {
    const file = path.join(work, 'archive' + (entry.archive === '7z-sfx' ? '.exe' : ''));
    await dl(entry.url, file);
    if ((await sha256File(file)) !== entry.sha256) throw new Error(`Checksum mismatch for ${name}`);

    const unpacked = path.join(work, 'unpacked');
    fs.mkdirSync(unpacked);
    unpack(entry.archive, file, unpacked);

    const target = path.join(vendor, entry.dest);
    fs.mkdirSync(vendor, { recursive: true });
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(path.join(unpacked, entry.inner), target, { recursive: true });

    const versions = readVersions(vendor);
    versions[name] = entry.version;
    fs.writeFileSync(path.join(vendor, '.versions.json'), JSON.stringify(versions, null, 2));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function main() {
  if (process.platform !== 'win32') {
    console.log(`Nothing to fetch on ${process.platform} — Breeze uses the system compilers.`);
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const installed = readVersions(vendorDir);
  for (const [name, entry] of Object.entries(manifest)) {
    if (!needsFetch(installed, name, entry.version)) {
      console.log(`${name} ${entry.version} is up to date.`);
      continue;
    }
    console.log(`Fetching ${name} ${entry.version}...`);
    try {
      await fetchTool(name, entry, vendorDir);
    } catch (err) {
      console.error(`Failed to fetch ${name}: ${err.message}`);
      process.exit(1);
    }
    console.log(`${name} ${entry.version} installed.`);
  }
}

if (require.main === module) main();

module.exports = { sha256File, needsFetch, fetchTool };
