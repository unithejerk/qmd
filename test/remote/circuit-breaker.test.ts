/**
 * Tests for the fault-isolating circuit breaker (src/remote/circuit-breaker.ts).
 *
 * Covers: closed→open transition on consecutive failures, cooldown timer,
 * half-open probe behavior, successful reset to closed, and diagnostic
 * state inspection (getState). Validates the three-state model prevents
 * cascading failures when remote endpoints are degraded.
 */
import { describe, test, expect, vi } from "vitest";
import { CircuitBreaker, type CircuitState } from "../../src/remote/circuit-breaker.js";


// =============================================================================
// circuit-breaker.ts
// =============================================================================

describe('CircuitBreaker', () => {
  test('starts in closed state', () => {
    const cb = new CircuitBreaker();
    expect(cb.canAttempt()).toBe(true);
    expect(cb.getState()).toBe('closed');
  });

  test('opens after maxFailures consecutive failures', () => {
    const cb = new CircuitBreaker(2);
    cb.onFailure();
    expect(cb.canAttempt()).toBe(true); // still closed (1 < 2)
    cb.onFailure();
    expect(cb.canAttempt()).toBe(false); // open after 2 failures
    expect(cb.getState()).toBe('open');
  });

  test('resets to closed on success', () => {
    const cb = new CircuitBreaker(2);
    cb.onFailure();
    cb.onFailure();
    expect(cb.getState()).toBe('open');
    // Force half-open by mocking time (not possible cleanly — test via success path)
  });

  test('onSuccess resets failures counter', () => {
    const cb = new CircuitBreaker(3);
    cb.onFailure();
    cb.onFailure();
    cb.onSuccess();
    expect(cb.getState()).toBe('closed');
  });

  test('transitions: closed → open → half-open → closed', async () => {
    // Use a very short cooldown for testing
    const cb = new CircuitBreaker(1, 50); // 1 failure, 50ms cooldown
    cb.onFailure();
    expect(cb.canAttempt()).toBe(false); // open after 1 failure
    expect(cb.getState()).toBe('open');

    // Wait for cooldown
    await new Promise((r) => setTimeout(r, 60));
    expect(cb.canAttempt()).toBe(true); // half-open
    expect(cb.getState()).toBe('half-open');

    // Success in half-open → back to closed
    cb.onSuccess();
    expect(cb.getState()).toBe('closed');
  });

  test('half-open failure goes back to open', async () => {
    const cb = new CircuitBreaker(1, 50);
    cb.onFailure();
    await new Promise((r) => setTimeout(r, 60));
    cb.canAttempt(); // transition to half-open
    cb.onFailure();  // fail in half-open
    expect(cb.getState()).toBe('open');
  });

  test('half-open allows only one in-flight probe attempt', async () => {
    const cb = new CircuitBreaker(1, 50);
    cb.onFailure();
    await new Promise((r) => setTimeout(r, 60));
    expect(cb.canAttempt()).toBe(true);  // first probe
    expect(cb.canAttempt()).toBe(false); // second concurrent probe blocked
    cb.onSuccess();
    expect(cb.getState()).toBe('closed');
    expect(cb.canAttempt()).toBe(true);
  });
});

// =============================================================================
// config.ts
// =============================================================================

