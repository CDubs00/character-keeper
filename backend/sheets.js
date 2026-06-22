/**
 * sheets.js — Sheet bundle manager
 *
 * Handles:
 *   - Scanning /bundles for bundles on startup and admin refresh
 *   - Maintaining the registry at /bundles-registry.json
 *   - Serving bundle files (schema, sheet.html, theme.css) to the frontend
 *   - API routes mounted by server.js
 */

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------

function getRegistryPath(dataDir) {
  return path.join(dataDir, 'sheets-registry.json');
}

function bundlesDir(dataDir) {
  return process.env.BUNDLES_DIR || path.join(dataDir, 'sheets');
}

// Copy any built-in bundle that isn't already in the live bundles dir.
// Never overwrites one the user already has, so drop-ins and edits persist.
function seedBundles(dataDir) {
  const target  = bundlesDir(dataDir);
  const seedDir = process.env.SEED_BUNDLES_DIR || '/app/seed-bundles';
  if (!fs.existsSync(seedDir)) return;
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(seedDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;          // bundles are folders
    const dest = path.join(target, entry.name);
    if (fs.existsSync(dest)) continue;           // already there — leave it alone
    fs.cpSync(path.join(seedDir, entry.name), dest, { recursive: true });
    console.log(`Seeded built-in bundle: ${entry.name}`);
  }
}

function loadRegistry(dataDir) {
  const p = getRegistryPath(dataDir);
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error('[sheets] Failed to parse sheets-registry.json:', e.message);
    return [];
  }
}

function saveRegistry(dataDir, registry) {
  fs.writeFileSync(
    getRegistryPath(dataDir),
    JSON.stringify(registry, null, 2)
  );
}

// ---------------------------------------------------------------------------
// Bundle scanner
//
// Scans /bundles for subfolders containing a manifest.json.
// Adds new valid bundles to the registry.
// Never removes or modifies existing registry entries.
//
// Returns a summary: { added, skipped, errors }
// ---------------------------------------------------------------------------

function scanBundles(dataDir) {
  seedBundles(dataDir); 
  const sheetsDir = bundlesDir(dataDir);
  const summary = { added: [], skipped: [], errors: [] };

  // sheets/ folder doesn't exist yet — that's fine, nothing to scan
  if (!fs.existsSync(sheetsDir)) {
    fs.mkdirSync(sheetsDir, { recursive: true });
    console.log('[sheets] Created BUNDLES_DIR directory');
    return summary;
  }

  const registry = loadRegistry(dataDir);
  const registeredIds = new Set(registry.map(r => r.sheetId));

  // Get all subdirectories in /bundles
  const folders = fs.readdirSync(sheetsDir).filter(name => {
    const full = path.join(sheetsDir, name);
    return fs.statSync(full).isDirectory();
  });

  for (const folder of folders) {
    const folderPath = path.join(sheetsDir, folder);
    const manifestPath = path.join(folderPath, 'manifest.json');

    // No manifest — skip silently (could be a temp folder or OS artifact)
    if (!fs.existsSync(manifestPath)) {
      continue;
    }

    // Parse manifest
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      const msg = `Bundle '${folder}/' has invalid manifest.json — ${e.message}`;
      console.warn(`[sheets] ${msg}`);
      summary.errors.push({ folder, reason: msg });
      continue;
    }

    // Validate required fields
    if (!manifest.sheetId) {
      const msg = `Bundle '${folder}/' is missing sheetId in manifest.json — ignored`;
      console.warn(`[sheets] ${msg}`);
      summary.errors.push({ folder, reason: msg });
      continue;
    }

    if (!manifest.name) {
      const msg = `Bundle '${folder}/' is missing name in manifest.json — ignored`;
      console.warn(`[sheets] ${msg}`);
      summary.errors.push({ folder, reason: msg });
      continue;
    }

    // Validate sheetId looks like a UUID v4
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidPattern.test(manifest.sheetId)) {
      const msg = `Bundle '${folder}/' sheetId is not a valid UUID v4 — ignored`;
      console.warn(`[sheets] ${msg}`);
      summary.errors.push({ folder, reason: msg });
      continue;
    }

    // Already registered — oldest entry wins, skip newcomer
    if (registeredIds.has(manifest.sheetId)) {
      const existing = registry.find(r => r.sheetId === manifest.sheetId);
      const msg = `Sheet '${manifest.name}' (${manifest.sheetId}) already registered on ${existing?.registeredAt} — ignoring '${folder}/'`;
      console.log(`[sheets] ${msg}`);
      summary.skipped.push({ folder, reason: msg });
      continue;
    }

    // Check required bundle files exist
    const requiredFiles = ['schema.json', 'sheet.html', 'theme.css'];
    const missingFiles = requiredFiles.filter(
      f => !fs.existsSync(path.join(folderPath, f))
    );

    if (missingFiles.length > 0) {
      const msg = `Bundle '${folder}/' is missing required files: ${missingFiles.join(', ')} — ignored`;
      console.warn(`[sheets] ${msg}`);
      summary.errors.push({ folder, reason: msg });
      continue;
    }

    // All good — register it
    const entry = {
      sheetId:      manifest.sheetId,
      name:         manifest.name,
      version:      manifest.version || '0.0.0',
      author:       manifest.author  || 'Unknown',
      folder:       folder,
      registeredAt: new Date().toISOString(),
      enabled:      true,
    };

    registry.push(entry);
    registeredIds.add(manifest.sheetId);
    saveRegistry(dataDir, registry);

    console.log(`[sheets] Registered new sheet: '${manifest.name}' v${entry.version} (${manifest.sheetId})`);
    summary.added.push({ folder, name: manifest.name, sheetId: manifest.sheetId });
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Bundle file resolver
//
// Finds the folder for a registered sheetId.
// Looks up the registry entry, then finds the folder on disk by scanning
// for a manifest with that sheetId. The registry stores the folder name
// as a hint, but we verify it still exists.
// ---------------------------------------------------------------------------

function resolveBundleFolder(dataDir, sheetId) {
  const registry = loadRegistry(dataDir);
  const entry = registry.find(r => r.sheetId === sheetId && r.enabled);
  if (!entry) return null;

  const sheetsDir = bundlesDir(dataDir);

  // Try the cached folder name first
  if (entry.folder) {
    const cached = path.join(sheetsDir, entry.folder);
    const manifest = path.join(cached, 'manifest.json');
    if (fs.existsSync(manifest)) {
      try {
        const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        if (m.sheetId === sheetId) return cached;
      } catch (_) {}
    }
  }

  // Cached folder is stale — scan for the right one
  const folders = fs.readdirSync(sheetsDir).filter(name =>
    fs.statSync(path.join(sheetsDir, name)).isDirectory()
  );

  for (const folder of folders) {
    const manifestPath = path.join(sheetsDir, folder, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (m.sheetId === sheetId) return path.join(sheetsDir, folder);
    } catch (_) {}
  }

  return null;
}

// ---------------------------------------------------------------------------
// Express routes
// ---------------------------------------------------------------------------

function registerRoutes(app, dataDir, requireAuth) {

  // GET /api/sheets
  // Returns all enabled registry entries — used by the frontend to know
  // which sheets are available when creating a new character.
  app.get('/api/sheets', requireAuth, (req, res) => {
    const registry = loadRegistry(dataDir);
    res.json(registry.filter(r => r.enabled));
  });

  // GET /api/sheets/:sheetId/schema
  // Returns the bundle's schema.json (empty character template, die config)
  app.get('/api/sheets/:sheetId/schema', (req, res) => {
    const folder = resolveBundleFolder(dataDir, req.params.sheetId);
    if (!folder) return res.status(404).json({ error: 'Sheet not found' });

    const schemaPath = path.join(folder, 'schema.json');
    if (!fs.existsSync(schemaPath)) {
      return res.status(404).json({ error: 'schema.json not found in bundle' });
    }

    try {
      res.json(JSON.parse(fs.readFileSync(schemaPath, 'utf8')));
    } catch (e) {
      res.status(500).json({ error: 'Failed to parse schema.json' });
    }
  });

  // GET /api/sheets/:sheetId/sheet.html
  // Serves the raw HTML template for the sheet renderer
  app.get('/api/sheets/:sheetId/sheet.html', (req, res) => {
    const folder = resolveBundleFolder(dataDir, req.params.sheetId);
    if (!folder) return res.status(404).json({ error: 'Sheet not found' });

    const htmlPath = path.join(folder, 'sheet.html');
    if (!fs.existsSync(htmlPath)) {
      return res.status(404).json({ error: 'sheet.html not found in bundle' });
    }

    res.setHeader('Content-Type', 'text/html');
    res.sendFile(htmlPath);
  });

  // GET /api/sheets/:sheetId/theme.css
  // Serves the bundle's CSS
  app.get('/api/sheets/:sheetId/theme.css', (req, res) => {
    const folder = resolveBundleFolder(dataDir, req.params.sheetId);
    if (!folder) return res.status(404).json({ error: 'Sheet not found' });

    const cssPath = path.join(folder, 'theme.css');
    if (!fs.existsSync(cssPath)) {
      return res.status(404).json({ error: 'theme.css not found in bundle' });
    }

    res.setHeader('Content-Type', 'text/css');
    res.sendFile(cssPath);
  });

  // GET /api/sheets/:sheetId/assets/*
  // Serves any file inside the bundle folder (fonts, logos, backgrounds, etc.)
  // so bundles can be fully self-contained — no reaching out to the web.
  // Public, like the other bundle file routes, so share-link viewers get them
  // too. Path-traversal protected: the resolved path must stay inside the
  // bundle folder. Express sets the content-type from the file extension;
  // nosniff stops the browser from reinterpreting it as something executable.
  app.get('/api/sheets/:sheetId/assets/*', (req, res) => {
    const folder = resolveBundleFolder(dataDir, req.params.sheetId);
    if (!folder) return res.status(404).json({ error: 'Sheet not found' });

    const rel    = req.params[0] || '';            // the part after /assets/
    const target = path.resolve(folder, rel);
    const root   = path.resolve(folder);

    // Reject anything that escapes the bundle folder (e.g. ../../secret)
    if (target !== root && !target.startsWith(root + path.sep)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(target);
  });

  // POST /api/sheets/refresh  (admin only)
  // Re-runs the bundle scan without restarting the container.
  app.post('/api/sheets/refresh', requireAuth, (req, res) => {
    if (!req.session?.user?.admin) {
      return res.status(403).json({ error: 'Admin only' });
    }

    const summary = scanBundles(dataDir);
    res.json({
      ok: true,
      added:   summary.added,
      skipped: summary.skipped,
      errors:  summary.errors,
    });
  });
}
// ---------------------------------------------------------------------------
// Schema loader
//
// Reads a bundle's schema.json by sheetId. Used by server.js to look up
// per-bundle metadata (e.g. sidecarPaths) without going through the HTTP route.
// Throws if the bundle can't be resolved; returns the parsed JSON otherwise.
// Callers that want graceful degradation should wrap in try/catch.
// ---------------------------------------------------------------------------
function loadSchema(dataDir, sheetId) {
  const folder = resolveBundleFolder(dataDir, sheetId);
  if (!folder) throw new Error(`Bundle not found for sheetId ${sheetId}`);
  const schemaPath = path.join(folder, 'schema.json');
  return JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { scanBundles, registerRoutes, loadSchema };