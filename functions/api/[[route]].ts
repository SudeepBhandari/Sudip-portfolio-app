import { DEFAULT_PROFILE, DEFAULT_PROJECTS, DEFAULT_SERVICES } from '../../src/shared/defaults';

interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: {
    last_row_id?: number;
    changes?: number;
  };
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

interface CFEnv {
  DB?: D1Database;
  ADMIN_EMAIL?: string;
  ADMIN_INITIAL_PASSWORD?: string;
  SESSION_SECRET?: string;
  APP_URL?: string;
  EMAIL_PROVIDER?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  SENDGRID_API_KEY?: string;
}

interface CFEventContext {
  request: Request;
  env: CFEnv;
  waitUntil?: (promise: Promise<unknown>) => void;
}

const SESSION_COOKIE_NAME = 'admin_session_token';
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const encoder = new TextEncoder();

let d1Initialized = false;

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(view.byteLength);
  new Uint8Array(buf).set(view);
  return buf;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function base64UrlEncode(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const iterations = 100000;
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(encoder.encode(password)),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: toArrayBuffer(salt),
      iterations,
      hash: 'SHA-256'
    },
    keyMaterial,
    256
  );
  return `pbkdf2:${iterations}:${bytesToHex(salt)}:${bytesToHex(new Uint8Array(derivedBits))}`;
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (!storedHash.startsWith('pbkdf2:')) return false;
  const parts = storedHash.split(':');
  if (parts.length !== 4) return false;
  const iterations = Number(parts[1]);
  const salt = hexToBytes(parts[2]);
  const expectedHash = hexToBytes(parts[3]);
  if (!iterations || !salt.length || !expectedHash.length) return false;

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(encoder.encode(password)),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: toArrayBuffer(salt),
      iterations,
      hash: 'SHA-256'
    },
    keyMaterial,
    expectedHash.length * 8
  );
  return timingSafeEqual(new Uint8Array(derivedBits), expectedHash);
}

function getSigningSecret(env: CFEnv): string {
  return env.SESSION_SECRET || 'sudip-portfolio-edge-secret-key-2026';
}

async function getHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    toArrayBuffer(encoder.encode(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

interface TokenPayload {
  adminId: number;
  email: string;
  exp: number;
}

async function signSessionToken(payload: TokenPayload, env: CFEnv): Promise<string> {
  const payloadB64 = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const key = await getHmacKey(getSigningSecret(env));
  const sigBuffer = await crypto.subtle.sign('HMAC', key, toArrayBuffer(encoder.encode(payloadB64)));
  const sigB64 = base64UrlEncode(new Uint8Array(sigBuffer));
  return `${payloadB64}.${sigB64}`;
}

async function verifySessionToken(token: string | undefined, env: CFEnv): Promise<TokenPayload | null> {
  if (!token || !token.includes('.')) return null;
  const [payloadB64, sigB64] = token.split('.');
  if (!payloadB64 || !sigB64) return null;

  try {
    const key = await getHmacKey(getSigningSecret(env));
    const sigBytes = base64UrlDecode(sigB64);
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      toArrayBuffer(sigBytes),
      toArrayBuffer(encoder.encode(payloadB64))
    );
    if (!valid) return null;

    const payloadJson = new TextDecoder().decode(base64UrlDecode(payloadB64));
    const payload = JSON.parse(payloadJson) as TokenPayload;
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(cookieHeader: string | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = decodeURIComponent(part.slice(idx + 1).trim());
    cookies[k] = v;
  }
  return cookies;
}

function extractToken(request: Request): string | undefined {
  const cookies = parseCookies(request.headers.get('Cookie'));
  if (cookies[SESSION_COOKIE_NAME]) {
    return cookies[SESSION_COOKIE_NAME];
  }
  const authHeader = request.headers.get('Authorization');
  if (authHeader) {
    const match = authHeader.match(/^bearer\s+(.+)$/i);
    if (match) return match[1].trim();
  }
  const custom = request.headers.get('x-admin-token');
  if (custom) return custom.trim();
  return undefined;
}

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers
    }
  });
}

function buildSessionCookieHeader(request: Request, token: string, clear = false): string {
  const isHttps = new URL(request.url).protocol === 'https:';
  const secureFlag = isHttps ? '; Secure' : '';
  if (clear) {
    return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag}`;
  }
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secureFlag}`;
}

async function ensureD1Initialized(db: D1Database, env: CFEnv): Promise<void> {
  if (d1Initialized) return;

  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login_at DATETIME
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      short_description TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      tools_json TEXT NOT NULL DEFAULT '[]',
      cover_image_key TEXT NOT NULL,
      featured INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'published',
      client_name TEXT,
      project_url TEXT,
      case_study_url TEXT,
      project_objective TEXT,
      design_process TEXT,
      final_outcome TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      published_at DATETIME
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS project_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      image_key TEXT NOT NULL,
      alt_text TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS inquiries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL,
      company TEXT,
      service TEXT NOT NULL,
      message TEXT NOT NULL,
      budget TEXT,
      deadline TEXT,
      preferred_contact TEXT DEFAULT 'Email',
      reference_url TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      admin_notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS site_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      setting_key TEXT UNIQUE NOT NULL,
      setting_value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS email_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inquiry_id INTEGER NOT NULL REFERENCES inquiries(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      error_summary TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 1,
      last_attempt_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`)
  ]);

  const profileRow = await db
    .prepare('SELECT setting_key FROM site_settings WHERE setting_key = ?')
    .bind('profile_data')
    .first();

  if (!profileRow) {
    await db
      .prepare('INSERT INTO site_settings (setting_key, setting_value) VALUES (?, ?)')
      .bind('profile_data', JSON.stringify(DEFAULT_PROFILE))
      .run();
  }

  const servicesRow = await db
    .prepare('SELECT setting_key FROM site_settings WHERE setting_key = ?')
    .bind('services_data')
    .first();

  if (!servicesRow) {
    await db
      .prepare('INSERT INTO site_settings (setting_key, setting_value) VALUES (?, ?)')
      .bind('services_data', JSON.stringify(DEFAULT_SERVICES))
      .run();
  }

  const projectCount = await db.prepare('SELECT COUNT(*) as count FROM projects').first<{ count: number }>();
  if (Number(projectCount?.count || 0) === 0) {
    for (const p of DEFAULT_PROJECTS) {
      await db
        .prepare(`
          INSERT INTO projects (
            title, slug, short_description, description, category, tools_json,
            cover_image_key, featured, status, client_name, project_url, case_study_url,
            project_objective, design_process, final_outcome, published_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
          p.title,
          p.slug,
          p.short_description,
          p.description,
          p.category,
          JSON.stringify(p.tools),
          p.cover_image_key,
          p.featured ? 1 : 0,
          p.status,
          p.client_name || null,
          p.project_url || null,
          p.case_study_url || null,
          p.project_objective || null,
          p.design_process || null,
          p.final_outcome || null,
          p.published_at || new Date().toISOString()
        )
        .run();
    }
  }

  const adminCount = await db.prepare('SELECT COUNT(*) as count FROM admins').first<{ count: number }>();
  if (Number(adminCount?.count || 0) === 0) {
    const adminEmail = (env.ADMIN_EMAIL || 'bhandarysudip5@gmail.com').trim().toLowerCase();
    const initialPassword = env.ADMIN_INITIAL_PASSWORD || 'SudipAdmin2026!';
    const passwordHash = await hashPassword(initialPassword);
    await db
      .prepare('INSERT INTO admins (email, password_hash) VALUES (?, ?)')
      .bind(adminEmail, passwordHash)
      .run();
  }

  d1Initialized = true;
}

async function sendEdgeInquiryEmail(
  env: CFEnv,
  inquiry: {
    id: number;
    full_name: string;
    email: string;
    company?: string | null;
    service: string;
    message: string;
    budget?: string | null;
    deadline?: string | null;
    preferred_contact?: string | null;
    reference_url?: string | null;
  }
): Promise<{ success: boolean; status: string; provider: string; errorSummary?: string }> {
  const adminEmail = env.ADMIN_EMAIL || 'bhandarysudip5@gmail.com';
  const provider = (env.EMAIL_PROVIDER || '').toLowerCase();

  if (!provider && !env.RESEND_API_KEY && !env.SENDGRID_API_KEY) {
    return {
      success: false,
      status: 'pending',
      provider: 'internal_queue',
      errorSummary: 'Recorded in database. Email provider setup is optional.'
    };
  }

  const subject = `New Portfolio Inquiry from ${inquiry.full_name} — ${inquiry.service}`;
  const textBody = [
    `New Inquiry #${inquiry.id}`,
    `Name: ${inquiry.full_name}`,
    `Email: ${inquiry.email}`,
    inquiry.company ? `Company: ${inquiry.company}` : null,
    `Service: ${inquiry.service}`,
    inquiry.budget ? `Budget: ${inquiry.budget}` : null,
    inquiry.deadline ? `Deadline: ${inquiry.deadline}` : null,
    `Preferred Contact: ${inquiry.preferred_contact || 'Email'}`,
    inquiry.reference_url ? `Reference URL: ${inquiry.reference_url}` : null,
    '',
    'Message:',
    inquiry.message
  ]
    .filter(Boolean)
    .join('\n');

  try {
    if ((provider === 'resend' || env.RESEND_API_KEY) && env.RESEND_API_KEY) {
      const fromEmail = env.RESEND_FROM_EMAIL || 'notifications@sudipbhandari5.com.np';
      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: `Sudip Bhandari Portfolio <${fromEmail}>`,
          to: [adminEmail],
          reply_to: inquiry.email,
          subject,
          text: textBody
        })
      });

      if (!resp.ok) {
        const errText = await resp.text();
        return {
          success: false,
          status: 'failed',
          provider: 'resend',
          errorSummary: `Resend HTTP ${resp.status}: ${errText.slice(0, 200)}`
        };
      }
      return { success: true, status: 'sent', provider: 'resend' };
    }

    if ((provider === 'sendgrid' || env.SENDGRID_API_KEY) && env.SENDGRID_API_KEY) {
      const fromEmail = env.RESEND_FROM_EMAIL || adminEmail;
      const resp = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.SENDGRID_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: adminEmail }], subject }],
          from: { email: fromEmail, name: 'Sudip Bhandari Portfolio' },
          reply_to: { email: inquiry.email },
          content: [{ type: 'text/plain', value: textBody }]
        })
      });

      if (!resp.ok) {
        const errText = await resp.text();
        return {
          success: false,
          status: 'failed',
          provider: 'sendgrid',
          errorSummary: `SendGrid HTTP ${resp.status}: ${errText.slice(0, 200)}`
        };
      }
      return { success: true, status: 'sent', provider: 'sendgrid' };
    }

    return {
      success: false,
      status: 'pending',
      provider: provider || 'internal_queue',
      errorSummary: 'Email provider credentials not configured for edge runtime.'
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Network error sending email';
    return {
      success: false,
      status: 'failed',
      provider: provider || 'resend',
      errorSummary: message
    };
  }
}

async function requireAuth(
  request: Request,
  env: CFEnv
): Promise<{ admin: { id: number; email: string } } | { errorResponse: Response }> {
  const token = extractToken(request);
  const payload = await verifySessionToken(token, env);
  if (!payload) {
    return { errorResponse: jsonResponse({ error: 'Unauthorized: Admin authentication required.' }, 401) };
  }

  if (env.DB) {
    const admin = await env.DB.prepare('SELECT id, email FROM admins WHERE id = ?')
      .bind(payload.adminId)
      .first<{ id: number; email: string }>();
    if (!admin) {
      return { errorResponse: jsonResponse({ error: 'Unauthorized: Account not found.' }, 401) };
    }
    return { admin };
  }

  return { admin: { id: payload.adminId, email: payload.email } };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function onRequest(context: CFEventContext): Promise<Response> {
  const { request, env } = context;
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const route = url.pathname.replace(/^\/api/, '') || '/';

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }

  try {
    if (env.DB) {
      await ensureD1Initialized(env.DB, env);
    }

    /* ==========================================
       PUBLIC API ENDPOINTS
       ========================================== */

    if (method === 'GET' && route === '/health') {
      if (env.DB) {
        const check = await env.DB.prepare('SELECT COUNT(*) as count FROM admins').first<{ count: number }>();
        return jsonResponse({
          status: 'healthy',
          database: 'cloudflare-d1',
          adminInitialized: Number(check?.count || 0) > 0,
          timestamp: new Date().toISOString()
        });
      }
      return jsonResponse({
        status: 'healthy',
        database: 'edge-defaults',
        adminInitialized: true,
        timestamp: new Date().toISOString()
      });
    }

    if (method === 'GET' && route === '/profile') {
      if (env.DB) {
        const row = await env.DB.prepare('SELECT setting_value FROM site_settings WHERE setting_key = ?')
          .bind('profile_data')
          .first<{ setting_value: string }>();
        if (row) return jsonResponse(JSON.parse(row.setting_value));
      }
      return jsonResponse(DEFAULT_PROFILE);
    }

    if (method === 'GET' && route === '/services') {
      if (env.DB) {
        const row = await env.DB.prepare('SELECT setting_value FROM site_settings WHERE setting_key = ?')
          .bind('services_data')
          .first<{ setting_value: string }>();
        if (row) return jsonResponse(JSON.parse(row.setting_value));
      }
      return jsonResponse(DEFAULT_SERVICES);
    }

    if (method === 'GET' && route === '/projects') {
      const category = url.searchParams.get('category') || '';
      const search = url.searchParams.get('search') || '';

      if (env.DB) {
        let query = `
          SELECT id, title, slug, short_description, description, category, tools_json,
                 cover_image_key, featured, status, client_name, project_url, case_study_url,
                 project_objective, design_process, final_outcome, created_at, published_at
          FROM projects
          WHERE status = 'published'
        `;
        const params: unknown[] = [];

        if (category && category !== 'All') {
          query += ' AND category = ?';
          params.push(category);
        }
        if (search.trim().length > 0) {
          query += ' AND (title LIKE ? OR short_description LIKE ? OR category LIKE ?)';
          const term = `%${search.trim()}%`;
          params.push(term, term, term);
        }
        query += ' ORDER BY featured DESC, id DESC';

        const stmt = params.length ? env.DB.prepare(query).bind(...params) : env.DB.prepare(query);
        const { results } = await stmt.all<Record<string, unknown>>();
        const formatted = results.map(p => ({
          ...p,
          tools: JSON.parse(String(p.tools_json || '[]')),
          featured: Boolean(p.featured)
        }));
        return jsonResponse(formatted);
      }

      const filtered = DEFAULT_PROJECTS.filter(p => {
        if (category && category !== 'All' && p.category !== category) return false;
        if (search.trim()) {
          const t = search.trim().toLowerCase();
          return (
            p.title.toLowerCase().includes(t) ||
            p.short_description.toLowerCase().includes(t) ||
            p.category.toLowerCase().includes(t)
          );
        }
        return true;
      });
      return jsonResponse(filtered);
    }

    if (method === 'GET' && route.startsWith('/projects/')) {
      const slug = decodeURIComponent(route.slice('/projects/'.length));
      if (env.DB) {
        const project = await env.DB.prepare(`SELECT * FROM projects WHERE slug = ? AND status = 'published'`)
          .bind(slug)
          .first<Record<string, unknown>>();

        if (!project) {
          return jsonResponse({ error: 'Project not found' }, 404);
        }

        const { results: images } = await env.DB.prepare(
          'SELECT id, image_key, alt_text, sort_order FROM project_images WHERE project_id = ? ORDER BY sort_order ASC, id ASC'
        )
          .bind(project.id)
          .all();

        const { results: related } = await env.DB.prepare(
          `SELECT id, title, slug, cover_image_key, category, short_description
           FROM projects
           WHERE category = ? AND id != ? AND status = 'published'
           LIMIT 3`
        )
          .bind(project.category, project.id)
          .all();

        return jsonResponse({
          ...project,
          tools: JSON.parse(String(project.tools_json || '[]')),
          featured: Boolean(project.featured),
          images,
          related
        });
      }

      const found = DEFAULT_PROJECTS.find(p => p.slug === slug);
      if (!found) return jsonResponse({ error: 'Project not found' }, 404);
      const related = DEFAULT_PROJECTS.filter(p => p.category === found.category && p.id !== found.id).slice(0, 3);
      return jsonResponse({ ...found, images: [], related });
    }

    if (method === 'POST' && route === '/inquiries') {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const {
        full_name,
        email,
        company,
        service,
        message,
        budget,
        deadline,
        preferred_contact,
        reference_url,
        website_hp
      } = body;

      if (website_hp) {
        return jsonResponse({ success: true, message: 'Inquiry received.' });
      }

      if (typeof full_name !== 'string' || full_name.trim().length < 2) {
        return jsonResponse({ error: 'Please enter your full name.' }, 400);
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (typeof email !== 'string' || !emailRegex.test(email.trim())) {
        return jsonResponse({ error: 'Please provide a valid email address.' }, 400);
      }

      if (typeof service !== 'string' || service.trim().length === 0) {
        return jsonResponse({ error: 'Please select a required service.' }, 400);
      }

      if (typeof message !== 'string' || message.trim().length < 10) {
        return jsonResponse({ error: 'Please describe your project (minimum 10 characters).' }, 400);
      }

      let newInquiryId = Date.now();
      if (env.DB) {
        const res = await env.DB.prepare(`
          INSERT INTO inquiries (
            full_name, email, company, service, message, budget, deadline,
            preferred_contact, reference_url, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `)
          .bind(
            full_name.trim(),
            email.trim().toLowerCase(),
            typeof company === 'string' && company.trim() ? company.trim() : null,
            service.trim(),
            message.trim(),
            typeof budget === 'string' && budget.trim() ? budget.trim() : null,
            typeof deadline === 'string' && deadline.trim() ? deadline.trim() : null,
            typeof preferred_contact === 'string' && preferred_contact.trim() ? preferred_contact.trim() : 'Email',
            typeof reference_url === 'string' && reference_url.trim() ? reference_url.trim() : null
          )
          .run();

        newInquiryId = Number(res.meta?.last_row_id || Date.now());
      }

      const emailTask = sendEdgeInquiryEmail(env, {
        id: newInquiryId,
        full_name: full_name.trim(),
        email: email.trim().toLowerCase(),
        company: typeof company === 'string' ? company.trim() : undefined,
        service: service.trim(),
        message: message.trim(),
        budget: typeof budget === 'string' ? budget.trim() : undefined,
        deadline: typeof deadline === 'string' ? deadline.trim() : undefined,
        preferred_contact: typeof preferred_contact === 'string' ? preferred_contact.trim() : undefined,
        reference_url: typeof reference_url === 'string' ? reference_url.trim() : undefined
      }).then(async emailRes => {
        if (env.DB) {
          await env.DB.prepare(
            `INSERT INTO email_notifications (inquiry_id, provider, status, error_summary, attempt_count, last_attempt_at, created_at)
             VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
          )
            .bind(newInquiryId, emailRes.provider, emailRes.status, emailRes.errorSummary || null)
            .run()
            .catch(() => {});
        }
      });

      if (context.waitUntil) {
        context.waitUntil(emailTask);
      } else {
        await emailTask;
      }

      return jsonResponse(
        {
          success: true,
          inquiryId: newInquiryId,
          message:
            'Thank you! Your project inquiry has been successfully received. I will review it and get back to you shortly.',
          whatsAppUrl: `https://wa.me/9779840631570?text=${encodeURIComponent(
            `Hello Sudip, I just sent a project inquiry regarding ${service.trim()} on your portfolio.`
          )}`
        },
        201
      );
    }

    if (method === 'GET' && route === '/cv') {
      let cvUrl = '';
      if (env.DB) {
        const row = await env.DB.prepare('SELECT setting_value FROM site_settings WHERE setting_key = ?')
          .bind('profile_data')
          .first<{ setting_value: string }>();
        if (row) {
          const parsed = JSON.parse(row.setting_value) as { cvUrl?: string };
          cvUrl = parsed.cvUrl || '';
        }
      }

      if (cvUrl.startsWith('data:application/pdf;base64,')) {
        const b64 = cvUrl.slice('data:application/pdf;base64,'.length);
        const bytes = base64ToUint8Array(b64);
        return new Response(toArrayBuffer(bytes), {
          status: 200,
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': 'attachment; filename="Sudip_Bhandari_CV.pdf"'
          }
        });
      }

      if (cvUrl && (cvUrl.startsWith('http://') || cvUrl.startsWith('https://') || cvUrl.startsWith('/'))) {
        return Response.redirect(new URL(cvUrl, url.origin).toString(), 302);
      }

      return jsonResponse(
        { error: 'No CV has been uploaded yet. Please contact directly or check back soon.' },
        404
      );
    }

    /* ==========================================
       ADMIN AUTHENTICATION ENDPOINTS
       ========================================== */

    if (method === 'POST' && route === '/admin/login') {
      const body = (await request.json().catch(() => ({}))) as { email?: string; password?: string };
      const email = (body.email || '').trim().toLowerCase();
      const password = body.password || '';

      if (!email || !password) {
        return jsonResponse({ error: 'Email and password are required.' }, 400);
      }

      let adminId = 1;
      let adminEmail = (env.ADMIN_EMAIL || 'bhandarysudip5@gmail.com').trim().toLowerCase();
      let valid = false;

      if (env.DB) {
        const admin = await env.DB.prepare('SELECT id, email, password_hash FROM admins WHERE email = ?')
          .bind(email)
          .first<{ id: number; email: string; password_hash: string }>();

        if (admin) {
          adminId = admin.id;
          adminEmail = admin.email;
          if (admin.password_hash.startsWith('pbkdf2:')) {
            valid = await verifyPassword(password, admin.password_hash);
          } else if (
            email === (env.ADMIN_EMAIL || 'bhandarysudip5@gmail.com').trim().toLowerCase() &&
            password === (env.ADMIN_INITIAL_PASSWORD || 'SudipAdmin2026!')
          ) {
            // Upgrade legacy non-PBKDF2 hash on first login
            const newHash = await hashPassword(password);
            await env.DB.prepare('UPDATE admins SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
              .bind(newHash, admin.id)
              .run();
            valid = true;
          }

          if (valid) {
            await env.DB.prepare('UPDATE admins SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?')
              .bind(admin.id)
              .run();
          }
        }
      } else {
        const expectedPass = env.ADMIN_INITIAL_PASSWORD || 'SudipAdmin2026!';
        valid = email === adminEmail && password === expectedPass;
      }

      if (!valid) {
        return jsonResponse({ error: 'Invalid email or password.' }, 401);
      }

      const sessionToken = await signSessionToken(
        { adminId, email: adminEmail, exp: Date.now() + SESSION_TTL_MS },
        env
      );

      return jsonResponse(
        {
          success: true,
          token: sessionToken,
          admin: { id: adminId, email: adminEmail }
        },
        200,
        { 'Set-Cookie': buildSessionCookieHeader(request, sessionToken) }
      );
    }

    if (method === 'POST' && route === '/admin/logout') {
      return jsonResponse(
        { success: true, message: 'Logged out successfully.' },
        200,
        { 'Set-Cookie': buildSessionCookieHeader(request, '', true) }
      );
    }

    if (method === 'GET' && route === '/admin/me') {
      const auth = await requireAuth(request, env);
      if ('errorResponse' in auth) return auth.errorResponse;
      return jsonResponse({
        authenticated: true,
        admin: auth.admin
      });
    }

    if (method === 'POST' && route === '/admin/change-password') {
      const auth = await requireAuth(request, env);
      if ('errorResponse' in auth) return auth.errorResponse;
      if (!env.DB) {
        return jsonResponse(
          { error: 'Bind a Cloudflare D1 database ("DB") in Cloudflare Pages Settings to persist password changes.' },
          503
        );
      }

      const body = (await request.json().catch(() => ({}))) as { currentPassword?: string; newPassword?: string };
      if (!body.currentPassword || !body.newPassword || body.newPassword.length < 8) {
        return jsonResponse({ error: 'New password must be at least 8 characters long.' }, 400);
      }

      const record = await env.DB.prepare('SELECT password_hash FROM admins WHERE id = ?')
        .bind(auth.admin.id)
        .first<{ password_hash: string }>();

      if (!record || !(await verifyPassword(body.currentPassword, record.password_hash))) {
        return jsonResponse({ error: 'Current password is incorrect.' }, 400);
      }

      const newHash = await hashPassword(body.newPassword);
      await env.DB.prepare('UPDATE admins SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .bind(newHash, auth.admin.id)
        .run();

      return jsonResponse({ success: true, message: 'Password updated successfully.' });
    }

    /* ==========================================
       ADMIN DASHBOARD OVERVIEW & PROJECTS
       ========================================== */

    if (method === 'GET' && route === '/admin/overview') {
      const auth = await requireAuth(request, env);
      if ('errorResponse' in auth) return auth.errorResponse;

      if (!env.DB) {
        return jsonResponse({
          stats: {
            publishedProjects: DEFAULT_PROJECTS.length,
            draftProjects: 0,
            totalInquiries: 0,
            newInquiries: 0
          },
          recentInquiries: []
        });
      }

      const publishedCount = await env.DB.prepare(
        "SELECT COUNT(*) as count FROM projects WHERE status = 'published'"
      ).first<{ count: number }>();
      const draftCount = await env.DB.prepare(
        "SELECT COUNT(*) as count FROM projects WHERE status = 'draft'"
      ).first<{ count: number }>();
      const totalInquiries = await env.DB.prepare('SELECT COUNT(*) as count FROM inquiries').first<{ count: number }>();
      const newInquiries = await env.DB.prepare(
        "SELECT COUNT(*) as count FROM inquiries WHERE status = 'new'"
      ).first<{ count: number }>();
      const { results: recentInquiries } = await env.DB.prepare(
        'SELECT id, full_name, email, service, status, created_at FROM inquiries ORDER BY id DESC LIMIT 5'
      ).all();

      return jsonResponse({
        stats: {
          publishedProjects: Number(publishedCount?.count || 0),
          draftProjects: Number(draftCount?.count || 0),
          totalInquiries: Number(totalInquiries?.count || 0),
          newInquiries: Number(newInquiries?.count || 0)
        },
        recentInquiries
      });
    }

    if (method === 'GET' && route === '/admin/projects') {
      const auth = await requireAuth(request, env);
      if ('errorResponse' in auth) return auth.errorResponse;

      const category = url.searchParams.get('category') || '';
      const status = url.searchParams.get('status') || '';
      const search = url.searchParams.get('search') || '';

      if (!env.DB) {
        const list = DEFAULT_PROJECTS.filter(p => {
          if (category && category !== 'All' && p.category !== category) return false;
          if (status && status !== 'All' && p.status !== status) return false;
          if (search.trim()) {
            const t = search.trim().toLowerCase();
            return p.title.toLowerCase().includes(t) || p.short_description.toLowerCase().includes(t);
          }
          return true;
        });
        return jsonResponse(list);
      }

      let query = 'SELECT * FROM projects WHERE 1=1';
      const params: unknown[] = [];

      if (category && category !== 'All') {
        query += ' AND category = ?';
        params.push(category);
      }
      if (status && status !== 'All') {
        query += ' AND status = ?';
        params.push(status);
      }
      if (search.trim()) {
        query += ' AND (title LIKE ? OR short_description LIKE ?)';
        const term = `%${search.trim()}%`;
        params.push(term, term);
      }
      query += ' ORDER BY id DESC';

      const stmt = params.length ? env.DB.prepare(query).bind(...params) : env.DB.prepare(query);
      const { results } = await stmt.all<Record<string, unknown>>();
      const formatted = results.map(p => ({
        ...p,
        tools: JSON.parse(String(p.tools_json || '[]')),
        featured: Boolean(p.featured)
      }));
      return jsonResponse(formatted);
    }

    if (method === 'POST' && route === '/admin/projects') {
      const auth = await requireAuth(request, env);
      if ('errorResponse' in auth) return auth.errorResponse;
      if (!env.DB) {
        return jsonResponse(
          { error: 'Cloudflare D1 database ("DB") is not bound yet. Bind D1 in Cloudflare Pages Settings to create projects.' },
          503
        );
      }

      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const {
        title,
        slug,
        short_description,
        description,
        category,
        tools,
        cover_image_key,
        featured,
        status,
        client_name,
        project_url,
        case_study_url,
        project_objective,
        design_process,
        final_outcome
      } = body;

      if (typeof title !== 'string' || typeof slug !== 'string' || typeof category !== 'string' || typeof cover_image_key !== 'string') {
        return jsonResponse({ error: 'Title, unique slug, category, and cover image are required.' }, 400);
      }

      const safeSlug = slug
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-');

      const existing = await env.DB.prepare('SELECT id FROM projects WHERE slug = ?').bind(safeSlug).first();
      if (existing) {
        return jsonResponse({ error: 'A project with this URL slug already exists.' }, 400);
      }

      const isPublished = status === 'published';
      const publishedAt = isPublished ? new Date().toISOString() : null;

      const res = await env.DB.prepare(`
        INSERT INTO projects (
          title, slug, short_description, description, category, tools_json,
          cover_image_key, featured, status, client_name, project_url, case_study_url,
          project_objective, design_process, final_outcome, created_at, updated_at, published_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)
      `)
        .bind(
          title.trim(),
          safeSlug,
          typeof short_description === 'string' ? short_description : '',
          typeof description === 'string' ? description : '',
          category,
          JSON.stringify(Array.isArray(tools) ? tools : []),
          cover_image_key,
          featured ? 1 : 0,
          typeof status === 'string' ? status : 'draft',
          client_name || null,
          project_url || null,
          case_study_url || null,
          project_objective || null,
          design_process || null,
          final_outcome || null,
          publishedAt
        )
        .run();

      return jsonResponse(
        {
          success: true,
          id: Number(res.meta?.last_row_id || 0),
          slug: safeSlug,
          message: 'Project created successfully.'
        },
        201
      );
    }

    if (route.startsWith('/admin/projects/')) {
      const id = route.slice('/admin/projects/'.length);
      const auth = await requireAuth(request, env);
      if ('errorResponse' in auth) return auth.errorResponse;

      if (method === 'GET') {
        if (!env.DB) {
          const found = DEFAULT_PROJECTS.find(p => String(p.id) === id);
          return found ? jsonResponse({ ...found, images: [] }) : jsonResponse({ error: 'Project not found' }, 404);
        }
        const project = await env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(id).first<Record<string, unknown>>();
        if (!project) return jsonResponse({ error: 'Project not found' }, 404);
        const { results: images } = await env.DB.prepare(
          'SELECT * FROM project_images WHERE project_id = ? ORDER BY sort_order ASC'
        )
          .bind(id)
          .all();
        return jsonResponse({
          ...project,
          tools: JSON.parse(String(project.tools_json || '[]')),
          featured: Boolean(project.featured),
          images
        });
      }

      if (method === 'PUT') {
        if (!env.DB) {
          return jsonResponse(
            { error: 'Cloudflare D1 database ("DB") is not bound yet. Bind D1 in Cloudflare Pages Settings to edit projects.' },
            503
          );
        }
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const existing = await env.DB.prepare('SELECT id, status, published_at FROM projects WHERE id = ?')
          .bind(id)
          .first<{ id: number; status: string; published_at: string | null }>();

        if (!existing) return jsonResponse({ error: 'Project not found.' }, 404);

        const safeSlug = String(body.slug || '')
          .toLowerCase()
          .trim()
          .replace(/[^a-z0-9-]/g, '-')
          .replace(/-+/g, '-');

        const slugCheck = await env.DB.prepare('SELECT id FROM projects WHERE slug = ? AND id != ?')
          .bind(safeSlug, id)
          .first();
        if (slugCheck) return jsonResponse({ error: 'Another project already uses this URL slug.' }, 400);

        let publishedAt = existing.published_at;
        if (body.status === 'published' && !existing.published_at) {
          publishedAt = new Date().toISOString();
        }

        await env.DB.prepare(`
          UPDATE projects SET
            title = ?, slug = ?, short_description = ?, description = ?,
            category = ?, tools_json = ?, cover_image_key = ?, featured = ?,
            status = ?, client_name = ?, project_url = ?, case_study_url = ?,
            project_objective = ?, design_process = ?, final_outcome = ?,
            updated_at = CURRENT_TIMESTAMP, published_at = ?
          WHERE id = ?
        `)
          .bind(
            String(body.title || '').trim(),
            safeSlug,
            body.short_description || '',
            body.description || '',
            body.category || 'Branding',
            JSON.stringify(Array.isArray(body.tools) ? body.tools : []),
            body.cover_image_key || '',
            body.featured ? 1 : 0,
            body.status || 'draft',
            body.client_name || null,
            body.project_url || null,
            body.case_study_url || null,
            body.project_objective || null,
            body.design_process || null,
            body.final_outcome || null,
            publishedAt,
            id
          )
          .run();

        return jsonResponse({ success: true, message: 'Project updated successfully.' });
      }

      if (method === 'DELETE') {
        if (!env.DB) {
          return jsonResponse(
            { error: 'Cloudflare D1 database ("DB") is not bound yet. Bind D1 in Cloudflare Pages Settings to delete projects.' },
            503
          );
        }
        await env.DB.prepare('DELETE FROM project_images WHERE project_id = ?').bind(id).run();
        await env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(id).run();
        return jsonResponse({ success: true, message: 'Project deleted successfully.' });
      }
    }

    if (method === 'POST' && route === '/admin/uploads') {
      const auth = await requireAuth(request, env);
      if ('errorResponse' in auth) return auth.errorResponse;

      const formData = await request.formData();
      const file = formData.get('file');
      if (!file || !(file instanceof File)) {
        return jsonResponse({ error: 'No image file uploaded.' }, 400);
      }

      const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
      if (!allowed.includes(file.type)) {
        return jsonResponse({ error: 'Only JPEG, PNG, WebP, and GIF images are allowed.' }, 400);
      }
      if (file.size > 1.5 * 1024 * 1024) {
        return jsonResponse(
          { error: 'Image exceeds 1.5MB edge storage limit. Please compress or paste a hosted image URL.' },
          400
        );
      }

      const b64 = arrayBufferToBase64(await file.arrayBuffer());
      const dataUrl = `data:${file.type};base64,${b64}`;
      return jsonResponse({
        success: true,
        fileKey: dataUrl,
        filename: file.name,
        size: file.size
      });
    }

    /* ==========================================
       ADMIN INQUIRIES MANAGEMENT
       ========================================== */

    if (method === 'GET' && route === '/admin/inquiries') {
      const auth = await requireAuth(request, env);
      if ('errorResponse' in auth) return auth.errorResponse;
      if (!env.DB) return jsonResponse([]);

      const status = url.searchParams.get('status') || '';
      const search = url.searchParams.get('search') || '';

      let query = `
        SELECT i.*,
               e.status as email_status,
               e.provider as email_provider,
               e.error_summary as email_error
        FROM inquiries i
        LEFT JOIN email_notifications e ON e.inquiry_id = i.id
        WHERE 1=1
      `;
      const params: unknown[] = [];

      if (status && status !== 'all') {
        query += ' AND i.status = ?';
        params.push(status);
      }
      if (search.trim()) {
        query += ' AND (i.full_name LIKE ? OR i.email LIKE ? OR i.company LIKE ? OR i.message LIKE ?)';
        const term = `%${search.trim()}%`;
        params.push(term, term, term, term);
      }
      query += ' ORDER BY i.id DESC';

      const stmt = params.length ? env.DB.prepare(query).bind(...params) : env.DB.prepare(query);
      const { results } = await stmt.all();
      return jsonResponse(results);
    }

    if (route.startsWith('/admin/inquiries/')) {
      const auth = await requireAuth(request, env);
      if ('errorResponse' in auth) return auth.errorResponse;
      if (!env.DB) {
        return jsonResponse({ error: 'Cloudflare D1 database ("DB") is not bound yet.' }, 503);
      }

      const sub = route.slice('/admin/inquiries/'.length);
      if (sub.endsWith('/retry-email') && method === 'POST') {
        const id = sub.slice(0, -'/retry-email'.length);
        const inquiry = await env.DB.prepare('SELECT * FROM inquiries WHERE id = ?')
          .bind(id)
          .first<{
            id: number;
            full_name: string;
            email: string;
            company: string | null;
            service: string;
            message: string;
            budget: string | null;
            deadline: string | null;
            preferred_contact: string | null;
            reference_url: string | null;
          }>();
        if (!inquiry) return jsonResponse({ error: 'Inquiry not found' }, 404);

        const result = await sendEdgeInquiryEmail(env, inquiry);
        return jsonResponse(result);
      }

      const id = sub;
      if (method === 'GET') {
        const inquiry = await env.DB.prepare(`
          SELECT i.*,
                 e.status as email_status,
                 e.provider as email_provider,
                 e.error_summary as email_error,
                 e.attempt_count as email_attempts,
                 e.last_attempt_at as email_last_attempt
          FROM inquiries i
          LEFT JOIN email_notifications e ON e.inquiry_id = i.id
          WHERE i.id = ?
        `)
          .bind(id)
          .first();
        if (!inquiry) return jsonResponse({ error: 'Inquiry not found' }, 404);
        return jsonResponse(inquiry);
      }

      if (method === 'PATCH') {
        const body = (await request.json().catch(() => ({}))) as { status?: string; admin_notes?: string };
        const validStatuses = ['new', 'contacted', 'in_progress', 'completed', 'archived'];
        if (body.status && !validStatuses.includes(body.status)) {
          return jsonResponse({ error: 'Invalid inquiry status.' }, 400);
        }

        await env.DB.prepare(`
          UPDATE inquiries SET
            status = COALESCE(?, status),
            admin_notes = COALESCE(?, admin_notes),
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `)
          .bind(body.status || null, body.admin_notes !== undefined ? body.admin_notes : null, id)
          .run();

        return jsonResponse({ success: true, message: 'Inquiry updated successfully.' });
      }

      if (method === 'DELETE') {
        await env.DB.prepare('DELETE FROM email_notifications WHERE inquiry_id = ?').bind(id).run();
        await env.DB.prepare('DELETE FROM inquiries WHERE id = ?').bind(id).run();
        return jsonResponse({ success: true, message: 'Inquiry deleted successfully.' });
      }
    }

    /* ==========================================
       ADMIN SETTINGS & CV MANAGEMENT
       ========================================== */

    if (method === 'GET' && route === '/admin/settings') {
      const auth = await requireAuth(request, env);
      if ('errorResponse' in auth) return auth.errorResponse;

      if (!env.DB) {
        return jsonResponse({
          profile: DEFAULT_PROFILE,
          services: DEFAULT_SERVICES
        });
      }

      const profileRow = await env.DB.prepare('SELECT setting_value FROM site_settings WHERE setting_key = ?')
        .bind('profile_data')
        .first<{ setting_value: string }>();
      const servicesRow = await env.DB.prepare('SELECT setting_value FROM site_settings WHERE setting_key = ?')
        .bind('services_data')
        .first<{ setting_value: string }>();

      return jsonResponse({
        profile: profileRow ? JSON.parse(profileRow.setting_value) : DEFAULT_PROFILE,
        services: servicesRow ? JSON.parse(servicesRow.setting_value) : DEFAULT_SERVICES
      });
    }

    if (method === 'PUT' && route === '/admin/settings') {
      const auth = await requireAuth(request, env);
      if ('errorResponse' in auth) return auth.errorResponse;
      if (!env.DB) {
        return jsonResponse(
          { error: 'Cloudflare D1 database ("DB") is not bound yet. Bind D1 in Cloudflare Pages Settings to save settings.' },
          503
        );
      }

      const body = (await request.json().catch(() => ({}))) as { profile?: unknown; services?: unknown };
      if (body.profile) {
        await env.DB.prepare(`
          INSERT INTO site_settings (setting_key, setting_value, updated_at)
          VALUES ('profile_data', ?, CURRENT_TIMESTAMP)
          ON CONFLICT(setting_key) DO UPDATE SET
            setting_value = excluded.setting_value,
            updated_at = CURRENT_TIMESTAMP
        `)
          .bind(JSON.stringify(body.profile))
          .run();
      }
      if (body.services && Array.isArray(body.services)) {
        await env.DB.prepare(`
          INSERT INTO site_settings (setting_key, setting_value, updated_at)
          VALUES ('services_data', ?, CURRENT_TIMESTAMP)
          ON CONFLICT(setting_key) DO UPDATE SET
            setting_value = excluded.setting_value,
            updated_at = CURRENT_TIMESTAMP
        `)
          .bind(JSON.stringify(body.services))
          .run();
      }

      return jsonResponse({ success: true, message: 'Settings saved successfully.' });
    }

    if (method === 'POST' && route === '/admin/upload-cv') {
      const auth = await requireAuth(request, env);
      if ('errorResponse' in auth) return auth.errorResponse;
      if (!env.DB) {
        return jsonResponse(
          { error: 'Cloudflare D1 database ("DB") is not bound yet. Bind D1 in Cloudflare Pages Settings to upload your CV.' },
          503
        );
      }

      const formData = await request.formData();
      const file = formData.get('cv');
      if (!file || !(file instanceof File)) {
        return jsonResponse({ error: 'No PDF file was uploaded.' }, 400);
      }
      if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
        return jsonResponse({ error: 'CV must be a PDF document.' }, 400);
      }
      if (file.size > 1.5 * 1024 * 1024) {
        return jsonResponse({ error: 'CV PDF exceeds 1.5MB edge storage limit.' }, 400);
      }

      const b64 = arrayBufferToBase64(await file.arrayBuffer());
      const dataUrl = `data:application/pdf;base64,${b64}`;

      const profileRow = await env.DB.prepare('SELECT setting_value FROM site_settings WHERE setting_key = ?')
        .bind('profile_data')
        .first<{ setting_value: string }>();

      const profile = profileRow ? JSON.parse(profileRow.setting_value) : { ...DEFAULT_PROFILE };
      profile.cvUrl = dataUrl;

      await env.DB.prepare(
        'UPDATE site_settings SET setting_value = ?, updated_at = CURRENT_TIMESTAMP WHERE setting_key = ?'
      )
        .bind(JSON.stringify(profile), 'profile_data')
        .run();

      return jsonResponse({
        success: true,
        cvUrl: '/api/cv',
        message: 'CV uploaded and updated successfully.'
      });
    }

    return jsonResponse({ error: `API endpoint not found: ${method} ${route}` }, 404);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    return jsonResponse({ error: message }, 500);
  }
}
