// Tests that exercise configuration semantics with deliberate placeholder bytes
// can opt out of cryptographic parsing. Dedicated validation tests use the
// production defaults and real certificate material.
export const tlsMaterialValidationStubs = Object.freeze({
  createTlsSecureContext: () => ({}),
  parseX509Certificate: () => ({})
});
