/**
 * Shared security type primitives.
 *
 * Lives in its own module so both the core security scanner and the polyglot
 * security ruleset can depend on the `Severity` contract without importing each
 * other — which would create a dependency cycle.
 */
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
