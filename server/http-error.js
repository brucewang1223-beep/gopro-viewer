/** An Error the HTTP layer answers with `status` (4xx / 5xx) instead of a bare 500. */
export const httpError = (status, message) => Object.assign(new Error(message), { status });
