// Simple local proxy server for CareStack API to avoid CORS in the browser
// Usage:
//   CARESTACK_API_KEY=... node server.js
// Or on Windows (PowerShell):
//   $env:CARESTACK_API_KEY="..."; node server.js

const express = require('express');
const cors = require('cors');
// Load environment variables from .env if present
try { require('dotenv').config(); } catch (_) {}

// Use global fetch if available (Node 18+), otherwise fall back to node-fetch
let fetchFn = global.fetch;
if (!fetchFn) {
  fetchFn = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
}

const app = express();
const PORT = process.env.PORT || 3000;

// Allow CORS from local dev by default
app.use(cors({ origin: true }));

app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// In-memory token cache
let tokenCache = {
  access_token: null,
  expires_at: 0, // epoch ms
};

async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.access_token && now < tokenCache.expires_at - 60_000) {
    return tokenCache.access_token;
  }

  const tokenUrl = process.env.CS_TOKEN_URL || 'https://id.carestack.ie/connect/token';
  const client_id = process.env.CS_CLIENT_ID || 'dentaltech_api_client';
  const client_secret = process.env.CS_CLIENT_SECRET || '';
  const username = process.env.CS_USERNAME || '';
  const password = process.env.CS_PASSWORD || '';

  if (!client_id || !client_secret || !username || !password) {
    throw new Error('Missing token credentials. Please set CS_CLIENT_ID, CS_CLIENT_SECRET, CS_USERNAME, CS_PASSWORD');
  }

  const body = new URLSearchParams();
  body.set('grant_type', 'password');
  body.set('client_id', client_id);
  body.set('client_secret', client_secret);
  body.set('username', username);
  body.set('password', password);

  const resp = await fetchFn(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  console.log("🚀 ~ getAccessToken ~ resp:", resp)

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Token request failed: ${resp.status} ${resp.statusText} ${text}`);
  }
  const json = await resp.json();
  const expires_in = Number(json.expires_in || 300); // seconds
  tokenCache.access_token = json.access_token;
  tokenCache.expires_at = Date.now() + expires_in * 1000;
  return tokenCache.access_token;
}

// Test endpoint to fetch a token
app.get('/api/token', async (req, res) => {
  try {
    const token = await getAccessToken();
    res.json({ access_token: token, expires_at: tokenCache.expires_at });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Proxy endpoint
app.get('/api/find-slot', async (req, res) => {
  try {
    const token = await getAccessToken();
    console.log("🚀 ~ token:", token)

    const { fromDate, locationId, providerId, productionTypeId } = req.query;

    if (!fromDate || !locationId || !providerId || !productionTypeId) {
      return res.status(400).json({ error: 'Missing required query params: fromDate, locationId, providerId, productionTypeId' });
    }

    const base = 'https://dentaltech.carestack.ie';
    const url = `${base}/scheduler/api/v1.0/appointments/find-slot?fromDate=${encodeURIComponent(fromDate)}&locationId=${encodeURIComponent(locationId)}&providerId=${encodeURIComponent(providerId)}&productionTypeId=${encodeURIComponent(productionTypeId)}`;

    const upstream = await fetchFn(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      },
    });

    const text = await upstream.text();
    res.status(upstream.status);
    // Forward content-type if provided, else default to json
    const ct = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
    res.setHeader('content-type', ct);
    res.send(text);
  } catch (err) {
    console.error('Proxy error', err);
    res.status(500).json({ error: 'Proxy failure', detail: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Local proxy running on http://localhost:${PORT}`);
});
