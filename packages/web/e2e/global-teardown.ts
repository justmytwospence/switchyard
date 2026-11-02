/** Stops the stack started by global-setup.ts (same runner process). */
export default async function globalTeardown(): Promise<void> {
  const teardown = (globalThis as { __syE2ETeardown?: () => Promise<void> }).__syE2ETeardown;
  await teardown?.();
}
