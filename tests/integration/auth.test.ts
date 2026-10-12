import { describe, expect, test, beforeEach } from "bun:test";
import { api, registerCustomer, loginAs, resetRateLimits } from "../helpers";

beforeEach(() => resetRateLimits());

describe("auth", () => {
  test("register -> login -> refresh -> logout", async () => {
    const reg = await registerCustomer();
    expect(reg.accessToken.length).toBeGreaterThan(10);
    const login = await loginAs(reg.email);
    expect(login.accessToken.length).toBeGreaterThan(10);
    const ref = await api("POST", "/api/v1/auth/refresh", { body: { refreshToken: login.refreshToken } });
    expect(ref.status).toBe(200);
    const newToken = (ref.json as { data: { refreshToken: string } }).data.refreshToken;
    const logout = await api("POST", "/api/v1/auth/logout", { body: { refreshToken: newToken } });
    expect(logout.status).toBe(200);
  });

  test("duplicate email rejected, wrong password rejected", async () => {
    const reg = await registerCustomer();
    const dup = await api("POST", "/api/v1/auth/register", {
      body: { email: reg.email, phone: "+234700000999", password: "Password123!", firstName: "Dup", lastName: "User" },
    });
    expect(dup.status).toBe(409);
    const bad = await api("POST", "/api/v1/auth/login", { body: { email: reg.email, password: "WrongPass1!" } });
    expect(bad.status).toBe(401);
  });

  test("protected route requires token; never leaks password hash", async () => {
    const anon = await api("GET", "/api/v1/customers/me");
    expect(anon.status).toBe(401);
    const reg = await registerCustomer();
    const me = await api("GET", "/api/v1/customers/me", { token: reg.accessToken });
    expect(me.status).toBe(200);
    expect(JSON.stringify(me.json)).not.toContain("passwordHash");
  });

  test("IDOR: customer A cannot read customer B loan application", async () => {
    const a = await registerCustomer();
    const b = await registerCustomer();
    // A creates profile income then product application
    await api("PATCH", "/api/v1/customers/me", { token: a.accessToken, body: { monthlyIncomeKobo: 600_000_00 } });
    const products = await api("GET", "/api/v1/loan-products/", { token: a.accessToken });
    const prodId = ((products.json as { data: { id: string }[] }).data[0] as { id: string }).id;
    const created = await api("POST", "/api/v1/loan-applications/", { token: a.accessToken, body: { productId: prodId, amountKobo: 100_000_00, tenorMonths: 3 } });
    expect(created.status).toBe(201);
    const appId = (created.json as { data: { id: string } }).data.id;
    const intrude = await api("GET", `/api/v1/loan-applications/${appId}`, { token: b.accessToken });
    expect(intrude.status).toBe(403);
  });
});
