/**
 * Reload this page.
 *
 * A module of its own for one reason: `location` is not redefinable in a real browser, so
 * `vi.stubGlobal('location', ...)` throws `Cannot redefine property` and `vi.spyOn(location,
 * 'reload')` is no better. A test cannot let a real reload happen, so the seam has to exist in the
 * code rather than in the test, and a module boundary is the one seam this project already mocks
 * everywhere else.
 *
 * Guarded, because a sandboxed frame can refuse navigation and a refusal here should not take the
 * caller down with it: everything that reloads is offering an improvement, never doing something
 * whose failure matters.
 */
export const reloadPage = (): void => {
  try { location.reload() } catch {}
}
