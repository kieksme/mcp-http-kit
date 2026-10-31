export {
  loadConfig,
  isLocalhostHostname,
  resolveHealthPaths,
  type LoadConfigOptions,
} from './config.js';
export {
  authenticateRequest,
  unauthorizedWwwAuthenticate,
  verifyBearerToken,
  extractBearerToken,
  verifyOAuthAccessToken,
  buildProtectedResourceMetadata,
  oauthWwwAuthenticate,
  resourceMetadataUrl,
  clearOAuthJwksCache,
  type AuthenticateResult,
  type AuthenticateOptions,
} from './auth/index.js';
export { toAuthInfo, fromAuthInfo } from './auth/context.js';
export {
  createMcpHttpApp,
  protectedResourceMetadataPath,
  checkHostAndOrigin,
  normalizeHostname,
  createNodeHttpServer,
  createNodeRequestListener,
  handleWithKitApp,
  type McpHttpApp,
  type McpHttpAppOptions,
  type HostGuardConfig,
  type HostGuardResult,
  type NodeHttpServerOptions,
} from './http/index.js';
export { startMcpServer } from './start.js';
export {
  resolveUpstreamCredential,
  parseUpstreamCredentialMode,
  assertHeaderModeAllowed,
  type UpstreamCredentialResult,
} from './upstream.js';
export {
  startTracing,
  shutdownTracing,
  type StartTracingOptions,
  type TracingHandle,
} from './otel.js';
export {
  isTelemetryEnabled,
  isPayloadRecordingEnabled,
  installTelemetry,
  type InstallTelemetryOptions,
} from './telemetry.js';
export type {
  TransportMode,
  AuthMode,
  UpstreamCredentialMode,
  BearerAuthConfig,
  OAuthAuthConfig,
  NoneAuthConfig,
  AuthConfig,
  HttpListenConfig,
  HealthInfo,
  HealthInfoProvider,
  KitConfig,
  AuthContext,
  RequestContext,
  ServerFactory,
  UpstreamCredentialOptions,
  StartMcpServerOptions,
  StartedServer,
} from './types.js';
