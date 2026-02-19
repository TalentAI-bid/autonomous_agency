import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// Note: These tests require DATABASE_URL and REDIS_URL to be set.
// For CI, use docker-compose to spin up dependencies first.

describe('AgentCore API', () => {
  let baseUrl: string;

  beforeAll(async () => {
    baseUrl = `http://localhost:${process.env.PORT || 4000}`;
  });

  it('GET /api/health returns 200', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body).toHaveProperty('timestamp');
    expect(body).toHaveProperty('version');
  });

  it('POST /api/auth/register creates tenant and user', async () => {
    const res = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `test-${Date.now()}@example.com`,
        password: 'securepassword123',
        name: 'Test User',
        tenantName: `Test Tenant ${Date.now()}`,
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toHaveProperty('accessToken');
    expect(body.user).toHaveProperty('id');
    expect(body.tenant).toHaveProperty('id');
  });

  it('POST /api/auth/login returns JWT', async () => {
    // First register
    const email = `login-test-${Date.now()}@example.com`;
    await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password: 'securepassword123',
        name: 'Login Test',
        tenantName: `Login Tenant ${Date.now()}`,
      }),
    });

    // Then login
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'securepassword123' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('accessToken');
    expect(body.user.email).toBe(email);
  });

  it('Protected routes require authentication', async () => {
    const res = await fetch(`${baseUrl}/api/contacts`);
    expect(res.status).toBe(401);
  });

  it('Authenticated request to /api/contacts returns data', async () => {
    // Register and get token
    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `contacts-test-${Date.now()}@example.com`,
        password: 'securepassword123',
        name: 'Contacts Test',
        tenantName: `Contacts Tenant ${Date.now()}`,
      }),
    });
    const { accessToken } = await regRes.json();

    const res = await fetch(`${baseUrl}/api/contacts`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('pagination');
  });
});
